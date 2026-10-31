import mongoose from "mongoose";
import { BaseCustomerModel } from "../../models/CustomerSystem/BaseCustomer";
import { CustomerVehicleModel } from "../../models/BikeSystemModel2/CustomerVehicleModel";
import { StockConceptCSVModel } from "../../models/BikeSystemModel3/StockConceptCSV";
import { StockConceptModel } from "../../models/BikeSystemModel2/StockConcept";
import { SalesReportModel } from "../../models/SalesReport";
import { normalizePhone } from "../salesReport.service";
import BikesModel from "../../models/BikeSystemModel/Bikes";
import logger from "../../utils/logger";

export type SalesReportRowOutcome =
  | "matched_status_flipped"
  | "matched_manual_form_status_flipped"
  | "matched_already_sold"
  | "unmatched"
  | "customer_conflict";

interface CatalogueEntry {
  key: string;
  exShowroom: number;
  variants: { key: string; adjustment: number }[];
}

let catalogueCache: { at: number; entries: CatalogueEntry[] } | null = null;
const CATALOGUE_TTL_MS = 60_000;

/**
 * The sales register abbreviates variants the catalogue spells out — DISK and
 * DC for Disc, DR for Drum, STD for Standard.
 */
const TOKEN_SYNONYMS: Record<string, string> = {
  DISK: "DISC",
  DC: "DISC",
  DR: "DRUM",
  STANDARD: "STD",
};

/**
 * The register names the 110 cc scooters without their displacement
 * ("ACTIVA DLX", "DIO STD") but always writes it for the 125s ("ACTIVA 125
 * DISC"), while the catalogue always carries it. SCV110 is Honda's product
 * code for the Activa 110, which sometimes lands in the MODEL NAME cell.
 * Applied to register labels only.
 */
const FAMILY_ALIASES: [RegExp, string][] = [
  [/^SCV110\w*/, "ACTIVA 110"],
  [/^ACTIVA\b(?! \d)/, "ACTIVA 110"],
  [/^DIO\b(?! \d)/, "DIO 110"],
];

/**
 * Normalise a model/variant label so "SHINE 100-OBD2B" and the catalogue's
 * "Shine 100" compare equal: uppercase, drop emission-norm suffixes, turn
 * punctuation into spaces, unify variant abbreviations.
 */
function normalizeModelKey(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\b(OBD\s*2\s*B?|BS\s*-?\s*(VI|6)|BSVI)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((t) => TOKEN_SYNONYMS[t] ?? t)
    .join(" ");
}

async function loadCatalogue(): Promise<CatalogueEntry[]> {
  if (catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS)
    return catalogueCache.entries;
  const bikes = await BikesModel.find({ isActive: true })
    .select("modelName variants priceBreakdown.exShowroomPrice")
    .lean();
  const entries: CatalogueEntry[] = bikes
    .filter((b: any) => b.priceBreakdown?.exShowroomPrice > 0)
    .map((b: any) => ({
      key: normalizeModelKey(b.modelName),
      exShowroom: b.priceBreakdown.exShowroomPrice,
      variants: (b.variants ?? []).map((v: any) => ({
        key: normalizeModelKey(v.name),
        adjustment: v.priceAdjustment ?? 0,
      })),
    }));
  catalogueCache = { at: Date.now(), entries };
  return entries;
}

/** A register/stock model label normalised, with its CC filled in where the register leaves it out. */
function registerModelKey(label: string): string {
  let key = normalizeModelKey(label);
  for (const [pattern, family] of FAMILY_ALIASES)
    key = key.replace(pattern, family);
  return key;
}

/** A label with only case and punctuation normalised — "-OBD2" and "OBD2B" stay distinct. */
const exactModelKey = (label: string) =>
  label.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

interface StockPrices {
  /** By exactModelKey: the same model and emission norm. */
  exact: Map<string, number>;
  /** By registerModelKey: "-OBD2" and "-OBD2B" stock of one model share a key; the most recently imported wins. */
  byModel: Map<string, number>;
}

let stockPriceCache: { at: number; prices: StockPrices } | null = null;

/** Latest cost price per model in the Daily Stock (CSV) uploads. */
async function loadStockPrices(): Promise<StockPrices> {
  if (stockPriceCache && Date.now() - stockPriceCache.at < CATALOGUE_TTL_MS)
    return stockPriceCache.prices;
  const rows = await StockConceptCSVModel.aggregate([
    { $match: { isActive: { $ne: false }, costPrice: { $gt: 0 } } },
    { $sort: { csvImportDate: -1 } },
    {
      $group: {
        _id: "$modelVariant",
        costPrice: { $first: "$costPrice" },
        at: { $first: "$csvImportDate" },
      },
    },
    { $sort: { at: -1 } },
  ]);
  const prices: StockPrices = { exact: new Map(), byModel: new Map() };
  for (const r of rows) {
    const label = String(r._id ?? "");
    const exact = exactModelKey(label);
    const model = registerModelKey(label);
    if (exact && !prices.exact.has(exact)) prices.exact.set(exact, r.costPrice);
    if (model && !prices.byModel.has(model)) prices.byModel.set(model, r.costPrice);
  }
  stockPriceCache = { at: Date.now(), prices };
  return prices;
}

/**
 * The catalogue model a register label names: the longest catalogue model
 * name the label starts with (so "SHINE 100-OBD2B" resolves to "Shine 100"),
 * plus whatever follows it, as tokens, for variant matching. Catalogue names
 * carry the CC ("Activa 125", "Dio 110"), so this matches on name and CC.
 */
function findCatalogueModel(
  label: string,
  catalogue: CatalogueEntry[],
): { entry: CatalogueEntry; rest: Set<string> } | null {
  const input = registerModelKey(label);
  if (!input) return null;
  const entry = catalogue
    .filter((c) => input === c.key || input.startsWith(c.key + " "))
    .sort((a, b) => b.key.length - a.key.length)[0];
  if (!entry) return null;
  const rest = input.slice(entry.key.length).trim();
  return { entry, rest: new Set(rest ? rest.split(" ") : []) };
}

/**
 * The model's price plus the priceAdjustment of the variant the label names
 * (e.g. "SP125 DLX DISK" -> Disc). A variant matches when all its words appear
 * in the label; single letters are ignored so the catalogue's "H-Smart"
 * matches the register's "SMART". The most specific variant wins.
 */
function priceFromCatalogue(label: string, catalogue: CatalogueEntry[]): number {
  const found = findCatalogueModel(label, catalogue);
  if (!found) return 0;
  const variant = found.entry.variants
    .map((v) => ({ v, words: v.key.split(" ").filter((t) => t.length > 1) }))
    .filter(({ words }) => words.length > 0 && words.every((t) => found.rest.has(t)))
    .sort((a, b) => b.words.length - a.words.length)[0]?.v;
  return found.entry.exShowroom + (variant?.adjustment ?? 0);
}

/**
 * A row with no model name at all ("-" or blank) is priced from its engine
 * number: the first five characters identify the model family (JK36E is the
 * Activa 110), so the model names already recorded against that prefix — in
 * stock or in earlier sales — say which catalogue model it is. Used only when
 * those names all resolve to the same model, at that model's base price,
 * since the variant can't be known this way.
 */
async function priceFromEngineFamily(
  engineNo: string,
  catalogue: CatalogueEntry[],
): Promise<number> {
  const prefix = engineNo.trim().toUpperCase().slice(0, 5);
  if (!/^[A-Z0-9]{5}$/.test(prefix)) return 0;
  const startsWith = new RegExp(`^${prefix}`);
  const [stockNames, soldNames] = await Promise.all([
    StockConceptCSVModel.distinct("modelVariant", { engineNumber: startsWith }),
    SalesReportModel.distinct("modelName", { engineNo: startsWith, isActive: true }),
  ]);
  const models = new Map<string, CatalogueEntry>();
  for (const name of [...stockNames, ...soldNames]) {
    const found = findCatalogueModel(String(name ?? ""), catalogue);
    if (found) models.set(found.entry.key, found.entry);
  }
  return models.size === 1 ? [...models.values()][0].exShowroom : 0;
}

/**
 * Price used when a sales report row carries no Total Payment. Order:
 *   (1) an "Ex-Showroom" column preserved in the matched CSV stock's own row;
 *   (2) the bike catalogue's ex-showroom price, by the stock's model variant
 *       then the row's model name (see priceFromCatalogue);
 *   (3) the Daily Stock (CSV) upload's price — the matched vehicle's own, else
 *       the latest one for the same model — for models the catalogue lacks
 *       (NX200, SP160, ...). This is the dealer's cost, so it ranks below the
 *       catalogue's selling price;
 *   (4) for a row with no model name, its engine family (see
 *       priceFromEngineFamily).
 * Needs no stock match beyond (1) and the first half of (3). Returns 0 only
 * when the model is in neither the bike catalogue nor any stock upload.
 */
export async function lookupExShowroom(
  stockDoc: {
    modelVariant?: string;
    csvData?: Record<string, any>;
    costPrice?: number;
  } | null,
  rowModelName: string,
  engineNo = "",
): Promise<number> {
  for (const [key, value] of Object.entries(stockDoc?.csvData ?? {})) {
    if (!/ex[\s._-]*showroom/i.test(key)) continue;
    const n = parseFloat(String(value ?? "").replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }

  const labels = [stockDoc?.modelVariant ?? "", rowModelName];
  const catalogue = await loadCatalogue();
  for (const label of labels) {
    const price = priceFromCatalogue(label, catalogue);
    if (price > 0) return price;
  }

  if (stockDoc?.costPrice && stockDoc.costPrice > 0) return stockDoc.costPrice;
  const stockPrices = await loadStockPrices();
  for (const label of labels) {
    const price =
      stockPrices.exact.get(exactModelKey(label)) ??
      stockPrices.byModel.get(registerModelKey(label));
    if (price) return price;
  }

  if (!normalizeModelKey(rowModelName) && engineNo)
    return priceFromEngineFamily(engineNo, catalogue);
  return 0;
}

export interface ProcessSalesReportRowInput {
  modelName: string;
  modelVariant: string;
  customerFirstName: string;
  customerLastName: string;
  customerMobile: string;
  location?: string;
  frameNo: string;
  engineNo: string;
  purchaseType: string;
  totalPayment: number;
}

export interface ProcessSalesReportRowResult {
  outcome: SalesReportRowOutcome;
  matched: boolean;
  needsReview: boolean;
  matchedStockId?: mongoose.Types.ObjectId;
  matchedStockType?: "StockConceptCSV" | "StockConcept";
  customerId?: mongoose.Types.ObjectId;
  customerVehicleId?: mongoose.Types.ObjectId;
  /** Total actually used: the row's own value, else the matched CSV stock's ex-showroom price. */
  totalPayment?: number;
  /** Model variant taken from the matched CSV stock when the row had none. */
  modelVariant?: string;
  /** True when this row is what brought the BaseCustomer into existence. */
  customerCreated: boolean;
  /** Stock status before this row flipped it to Sold — set only when it did flip. */
  stockPreviousStatus?: string;
}

/**
 * Find-or-create the BaseCustomer for one sales-report row.
 *
 * This is deliberately run BEFORE (and independently of) the stock match:
 * the row is a record of a real, already-completed sale, so the buyer is a
 * real customer of this dealership whether or not their vehicle happens to
 * be present in StockConceptCSV/StockConcept. Gating customer creation on a
 * stock match — which is what this module used to do — meant a report whose
 * frame numbers predated the stock import created zero customers, and the
 * names sitting in the report were never surfaced anywhere.
 *
 * Returns null only when the row carries no usable 10-digit mobile number:
 * phoneNumber is BaseCustomer's unique business key, so there is nothing to
 * create or de-duplicate against without it.
 */
async function findOrCreateCustomer(
  rawMobile: string,
  frameNo: string,
  location?: string,
): Promise<{ id: mongoose.Types.ObjectId; created: boolean } | null> {
  const phoneNumber = normalizePhone(rawMobile);
  if (!phoneNumber) {
    logger.warn(
      `SalesReport: no valid phone number on row for frame ${frameNo || "(none)"} — no customer created`,
    );
    return null;
  }

  // Only Golaghat is kept on the customer; any other location is ignored.
  const cleanLocation = /golaghat/i.test(location ?? "") ? "Golaghat" : undefined;

  const existing = await BaseCustomerModel.findOne({ phoneNumber });
  if (existing) {
    // Fill a missing location, but never overwrite one already on file.
    if (cleanLocation && !existing.location) {
      await BaseCustomerModel.updateOne(
        { _id: existing._id, location: { $in: [null, ""] } },
        { $set: { location: cleanLocation } },
      );
    }
    // An existing customer's creationSource is never overwritten — it records
    // how they first entered the system, not how they were last seen.
    return {
      id: existing._id as unknown as mongoose.Types.ObjectId,
      created: false,
    };
  }

  try {
    const created = await BaseCustomerModel.create({
      phoneNumber,
      ...(cleanLocation && { location: cleanLocation }),
      isVerified: false,
      creationSource: "new_csv_sales_report",
    });
    return {
      id: created._id as unknown as mongoose.Types.ObjectId,
      created: true,
    };
  } catch (error: any) {
    // phoneNumber is uniquely indexed; a concurrent upload (or a concurrent
    // OTP sign-up) can win the race between the findOne above and this
    // create. Re-read rather than failing the row.
    if (error?.code === 11000) {
      const raced = await BaseCustomerModel.findOne({ phoneNumber });
      if (raced && cleanLocation && !raced.location) {
        await BaseCustomerModel.updateOne(
          { _id: raced._id, location: { $in: [null, ""] } },
          { $set: { location: cleanLocation } },
        );
      }
      if (raced)
        return {
          id: raced._id as unknown as mongoose.Types.ObjectId,
          created: false,
        };
    }
    throw error;
  }
}

/**
 * Processes one SalesReport row: creates/links the customer, matches the row
 * against StockConceptCSV by Frame No OR Engine No, flips matched-but-unsold
 * stock to "Sold", and links a CustomerVehicle. Mirrors
 * serviceInvoice/autoRegister.service.ts#autoRegisterFromInvoice,
 * adapted for the "already-sold vehicle CSV" use case:
 *
 *  - The customer is created first and unconditionally (see
 *    findOrCreateCustomer) — every outcome below, including `unmatched`,
 *    carries a customerId whenever the row had a usable mobile number.
 *  - Match is OR'd across frameNo/engineNo (not frame-number-only), and
 *    scoped to the uploading branch.
 *  - No legacy StockConcept fallback and NO placeholder-stock creation on a
 *    miss — an unmatched row is just recorded for visibility (needsReview),
 *    never fabricates a stock record.
 *  - A stock row already "Sold" is left untouched (matched_already_sold)
 *    rather than re-processed, so re-uploads don't double-count.
 *  - New BaseCustomer docs get creationSource: "new_csv_sales_report".
 */
export async function processSalesReportRow(
  row: ProcessSalesReportRowInput,
  branchId: string,
  uploadedBy: mongoose.Types.ObjectId,
): Promise<ProcessSalesReportRowResult> {
  const frameNo = row.frameNo?.trim().toUpperCase();
  const engineNo = row.engineNo?.trim().toUpperCase();

  const customer = await findOrCreateCustomer(row.customerMobile, frameNo, row.location);
  const customerId = customer?.id;
  const customerCreated = customer?.created ?? false;

  const orMatch: Record<string, any>[] = [];
  if (frameNo) orMatch.push({ frameNumber: frameNo });
  if (engineNo) orMatch.push({ engineNumber: engineNo });

  const stockDoc = orMatch.length
    ? await StockConceptCSVModel.findOne({
        "stockStatus.branchId": branchId,
        $or: orMatch,
      })
    : null;

  // Total Payment is optional on the upload: when the row has none, use the
  // ex-showroom price of the matched CSV stock (see lookupExShowroom). Likewise the model variant.
  const resolvedTotal =
    row.totalPayment > 0
      ? row.totalPayment
      : await lookupExShowroom(stockDoc, row.modelName, row.engineNo);
  const resolvedVariant = row.modelVariant || stockDoc?.modelVariant || "";
  const derived = {
    totalPayment: resolvedTotal,
    modelVariant: resolvedVariant,
  };

  if (!stockDoc) {
    // No Daily Stock (CSV) match — fall back to the Manual stock form
    // (StockConceptModel). Unlike the CSV match above, a Manual-form match
    // only ever flips the status field: no CustomerVehicle gets linked here,
    // so it's always flagged needsReview for manual follow-up. The customer
    // itself still exists — they were created above.
    const manualDoc = orMatch.length
      ? await StockConceptModel.findOne({
          "stockStatus.branchId": branchId,
          $or: [
            ...(engineNo ? [{ engineNumber: engineNo }] : []),
            ...(frameNo ? [{ chassisNumber: frameNo }] : []),
          ],
        })
      : null;

    if (!manualDoc) {
      return {
        outcome: "unmatched",
        matched: false,
        needsReview: true,
        customerId,
        customerCreated,
      };
    }

    if (manualDoc.stockStatus.status === "Sold") {
      return {
        outcome: "matched_already_sold",
        matched: true,
        needsReview: true,
        matchedStockId: manualDoc._id as unknown as mongoose.Types.ObjectId,
        matchedStockType: "StockConcept",
        customerId,
        customerCreated,
      };
    }

    const manualPrevious = manualDoc.stockStatus.status;
    manualDoc.stockStatus.status = "Sold";
    await manualDoc.save();

    return {
      outcome: "matched_manual_form_status_flipped",
      matched: true,
      needsReview: true,
      matchedStockId: manualDoc._id as unknown as mongoose.Types.ObjectId,
      matchedStockType: "StockConcept",
      customerId,
      customerCreated,
      stockPreviousStatus: manualPrevious,
    };
  }

  if (stockDoc.stockStatus.status === "Sold") {
    return {
      outcome: "matched_already_sold",
      matched: true,
      needsReview: true,
      matchedStockId: stockDoc._id as unknown as mongoose.Types.ObjectId,
      matchedStockType: "StockConceptCSV",
    ...derived,
      customerId,
      customerCreated,
    };
  }

  if (!customerId) {
    // Stock matched but the row has no phone number, so there is no customer
    // to sell it to. Leave the stock unflipped rather than marking it Sold
    // with no owner — that would strand the unit as unassignable.
    return {
      outcome: "unmatched",
      matched: true,
      needsReview: true,
      matchedStockId: stockDoc._id as unknown as mongoose.Types.ObjectId,
      matchedStockType: "StockConceptCSV",
    ...derived,
      customerCreated,
    };
  }

  // CustomerVehicle.customer is unique — don't violate that constraint if
  // this customer already owns a different vehicle.
  const existingForCustomer = await CustomerVehicleModel.findOne({
    customer: customerId,
  });
  if (existingForCustomer) {
    logger.warn(
      `SalesReport: customer ${customerId} already owns a vehicle, skipping link for frame ${frameNo}`,
    );
    return {
      outcome: "customer_conflict",
      matched: true,
      needsReview: true,
      matchedStockId: stockDoc._id as unknown as mongoose.Types.ObjectId,
      matchedStockType: "StockConceptCSV",
    ...derived,
      customerId,
      customerCreated,
    };
  }

  const vehicle = await CustomerVehicleModel.create({
    stockConcept: stockDoc._id,
    stockType: "StockConceptCSV",
    customer: customerId,
    isPaid: true,
    isFinance: false,
    insurance: false,
  });

  const csvPrevious = stockDoc.stockStatus.status;
  stockDoc.stockStatus.status = "Sold";
  stockDoc.salesInfo = {
    soldTo: customerId,
    soldDate: new Date(),
    salePrice: resolvedTotal,
    paymentStatus: "Paid",
    customerVehicleId: vehicle._id as unknown as mongoose.Types.ObjectId,
  };
  await stockDoc.save();

  return {
    outcome: "matched_status_flipped",
    matched: true,
    needsReview: false,
    matchedStockId: stockDoc._id as unknown as mongoose.Types.ObjectId,
    matchedStockType: "StockConceptCSV",
    ...derived,
    customerId,
    customerVehicleId: vehicle._id as unknown as mongoose.Types.ObjectId,
    customerCreated,
    stockPreviousStatus: csvPrevious,
  };
}
