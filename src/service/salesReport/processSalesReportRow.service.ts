import mongoose from "mongoose";
import { BaseCustomerModel } from "../../models/CustomerSystem/BaseCustomer";
import { CustomerVehicleModel } from "../../models/BikeSystemModel2/CustomerVehicleModel";
import { StockConceptCSVModel } from "../../models/BikeSystemModel3/StockConceptCSV";
import { StockConceptModel } from "../../models/BikeSystemModel2/StockConcept";
import { normalizePhone } from "../salesReport.service";
import logger from "../../utils/logger";

export type SalesReportRowOutcome =
  | "matched_status_flipped"
  | "matched_manual_form_status_flipped"
  | "matched_already_sold"
  | "unmatched"
  | "customer_conflict";

export interface ProcessSalesReportRowInput {
  modelName: string;
  modelVariant: string;
  customerFirstName: string;
  customerLastName: string;
  customerMobile: string;
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
  /** True when this row is what brought the BaseCustomer into existence. */
  customerCreated: boolean;
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
): Promise<{ id: mongoose.Types.ObjectId; created: boolean } | null> {
  const phoneNumber = normalizePhone(rawMobile);
  if (!phoneNumber) {
    logger.warn(
      `SalesReport: no valid phone number on row for frame ${frameNo || "(none)"} — no customer created`,
    );
    return null;
  }

  const existing = await BaseCustomerModel.findOne({ phoneNumber });
  if (existing) {
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

  const customer = await findOrCreateCustomer(row.customerMobile, frameNo);
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
    };
  }

  if (stockDoc.stockStatus.status === "Sold") {
    return {
      outcome: "matched_already_sold",
      matched: true,
      needsReview: true,
      matchedStockId: stockDoc._id as unknown as mongoose.Types.ObjectId,
      matchedStockType: "StockConceptCSV",
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

  stockDoc.stockStatus.status = "Sold";
  stockDoc.salesInfo = {
    soldTo: customerId,
    soldDate: new Date(),
    salePrice: row.totalPayment,
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
    customerId,
    customerVehicleId: vehicle._id as unknown as mongoose.Types.ObjectId,
    customerCreated,
  };
}
