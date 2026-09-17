// service/serviceInvoice/invoicePdfExtractor.ts
//
// Structured extraction of Honda DMS "service Tax Invoice" PDFs (one PDF per
// closed job card).
//
// WHY THIS DOESN'T USE pdf-parse'S NORMAL OUTPUT
// ---------------------------------------------
// `pdfParse(buffer).text` concatenates every text item on a line with no
// separator, so the line-item table comes out unusable — e.g. the first row
// renders as "108233-2MB-F0LGF" (Sr "1" + part "08233-2MB-F0LGF") and
// "27101972Paid325.561No's325.560.00325.56" for the rest of the columns.
// There is no reliable way to split that back apart.
//
// Instead we pass a custom `pagerender`, which hands us the pdfjs text items
// *with their transform matrices*. transform[4]/transform[5] are the x/y of
// each item, so we can rebuild the table geometrically: bucket items into
// horizontal bands (rows) by y, then bin them into columns by x.
//
// This needs no OCR and no external document-AI service — see
// docs/service-invoice-pdf.md for the verification notes.

import pdfParse from "pdf-parse";
import { parseNumeric, parseFlexibleDate } from "../../utils/parseValues";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextItem {
  /** 1-based page number. */
  page: number;
  x: number;
  y: number;
  str: string;
}

export interface Band {
  y: number;
  items: TextItem[];
}

/** The 13 columns of the line-item table, left to right. */
export type LineItemColumn =
  | "srNo"
  | "partNo"
  | "description"
  | "hsn"
  | "sublet"
  | "billingType"
  | "unitPrice"
  | "qty"
  | "uom"
  | "totalAmount"
  | "discountPct"
  | "discountRs"
  | "taxableAmount";

export interface ColumnBound {
  key: LineItemColumn;
  /** Inclusive lower x bound. */
  from: number;
  /** Exclusive upper x bound. */
  to: number;
}

export type LineItemKind = "PART" | "LABOUR";

export interface ParsedLineItem {
  srNo: number;
  /** Part number (parts) or job code (labour), uppercased, whitespace stripped. */
  partNo: string;
  description: string;
  hsn: string;
  uom: string;
  /** "No's" => PART, "Hrs" => LABOUR. */
  kind: LineItemKind;
  qty: number;
  unitPrice?: number;
  discountPct?: number;
  discountRs?: number;
  /** Pre-tax amount for this line. */
  taxableAmount: number;
}

export interface ParsedInvoiceHeader {
  jobCardNumber?: string;
  invoiceNumber?: string;
  invoiceDate?: Date;
  jobCardClosedDate?: Date;
  frameNumber?: string;
  engineNumber?: string;
  registrationNumber?: string;
  modelName?: string;
  modelCode?: string;
  color?: string;
  serviceType?: string;
  serviceKm?: number;
  advisorName?: string;
  technicianName?: string;
  saleDate?: Date;
}

export interface ParsedParties {
  customerName?: string;
  customerMobile?: string;
  /** The DMS's own customer key, e.g. "1-1XURDIM6". */
  customerAccountId?: string;
  customerAddress?: string;
  customerCity?: string;
  customerPin?: string;
}

export interface ParsedTotals {
  totalPartsAmount?: number;
  totalLabourAmount?: number;
  totalDiscountAmount?: number;
  totalTaxAmount?: number;
  totalInvoiceAmount?: number;
  miscellaneousAmount?: number;
  paymentMode?: string;
}

export interface ReconciliationResult {
  /** Did the line items add up to the invoice's own stated totals? */
  ok: boolean;
  /** Sum of taxable amounts of PART lines. */
  partsTaxable: number;
  /** Sum of taxable amounts of LABOUR lines. */
  labourTaxable: number;
  /** Stated total minus our computed (tax-adjusted) figure. */
  partsDelta?: number;
  labourDelta?: number;
  notes: string[];
}

export interface ParsedServiceInvoice {
  header: ParsedInvoiceHeader;
  parties: ParsedParties;
  lineItems: ParsedLineItem[];
  totals: ParsedTotals;
  reconciliation: ReconciliationResult;
  /** True when anything looked off and a human should eyeball the import. */
  needsReview: boolean;
  reviewReasons: string[];
  pageCount: number;
  /** Raw concatenated text, kept for audit/debugging on the stored document. */
  rawText: string;
}

export class InvoicePdfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoicePdfParseError";
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Items whose y differs by less than this are treated as the same visual row.
 * Honda invoice rows are ~8-45pt apart; sub-point jitter is common within a row.
 */
const BAND_TOLERANCE = 1.5;

/** Pull every text item out of the PDF with its page and x/y position. */
export async function extractTextItems(
  buffer: Buffer,
): Promise<{ items: TextItem[]; pageCount: number; rawText: string }> {
  const items: TextItem[] = [];

  const result = await pdfParse(buffer, {
    pagerender: (pageData: any) =>
      pageData.getTextContent().then((content: any) => {
        for (const item of content.items) {
          const str = typeof item.str === "string" ? item.str : "";
          if (str === "") continue;
          items.push({
            page: pageData.pageNumber,
            x: item.transform[4],
            y: item.transform[5],
            str,
          });
        }
        // We only care about the side effect above; pdf-parse still wants a
        // string back for its own `.text` accumulation.
        return "";
      }),
  } as any);

  return {
    items,
    pageCount: result.numpages,
    rawText: result.text || "",
  };
}

/** Group one page's items into y-bands (visual rows), top to bottom. */
export function groupIntoBands(items: TextItem[], page: number): Band[] {
  const pageItems = items
    .filter((i) => i.page === page)
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const bands: Band[] = [];
  for (const item of pageItems) {
    const last = bands[bands.length - 1];
    if (last && Math.abs(last.y - item.y) <= BAND_TOLERANCE) {
      last.items.push(item);
    } else {
      bands.push({ y: item.y, items: [item] });
    }
  }

  for (const band of bands) band.items.sort((a, b) => a.x - b.x);
  return bands;
}

/** Flatten a band to a single string, for pattern tests. */
function bandText(band: Band): string {
  return band.items.map((i) => i.str).join("");
}

/**
 * Same, but space-separated. Adjacent cells in these PDFs carry no trailing
 * space of their own, so a bare join fuses them ("Cash" + "Total Tax Amount"
 * => "CashTotal Tax Amount") and any value-capturing regex runs straight
 * through the boundary. Use this whenever matching a *value* out of a band.
 */
function bandTextSpaced(band: Band): string {
  return band.items.map((i) => i.str.trim()).filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Column bounds
// ---------------------------------------------------------------------------

/** A UoM *value* (as opposed to the "UoM" header label) marks a real data row. */
const UOM_VALUE_PATTERN = /No's|Nos|Hrs/i;

/**
 * Header labels in table order. The PDF wraps every multi-word label across
 * lines ("Part No/" + "Jobcode"), so these match the distinctive leading
 * fragment and we anchor on its x.
 *
 * `pick` disambiguates the two discount columns, which the PDF renders as
 * "Discoun"+"t %" and "Discount "+"(Rs)" — after trimming, both begin with
 * "Discoun", so neither a prefix nor an exact match can separate them.
 * Instead we take every match left-to-right: the first is Discount %, the
 * second is Discount (Rs).
 */
const HEADER_ANCHORS: Array<{
  key: LineItemColumn;
  match: RegExp;
  pick?: number;
}> = [
  { key: "srNo", match: /^Sr$/i },
  { key: "partNo", match: /^Part\s*No\//i },
  { key: "description", match: /^Description/i },
  { key: "hsn", match: /^HSN\/SAC/i },
  { key: "sublet", match: /^Sublet/i },
  { key: "billingType", match: /^Billing/i },
  { key: "unitPrice", match: /^Unit$/i },
  { key: "qty", match: /^Qty/i },
  { key: "uom", match: /^UoM/i },
  { key: "totalAmount", match: /^Total$/i },
  { key: "discountPct", match: /^Discoun/i, pick: 0 },
  { key: "discountRs", match: /^Discoun/i, pick: 1 },
  { key: "taxableAmount", match: /^Taxable/i },
];

/**
 * Maximum y gap between two bands that are still part of the same wrapped
 * header. The header labels wrap over several lines ~4.2pt apart ("Part No/" /
 * "Jobcode", "Unit" / "Price" / "(Rs)"), whereas the gap from the header down
 * to the first data row is ~8.6pt. That difference is what separates them.
 */
const HEADER_WRAP_MAX_GAP = 6;

/**
 * Locate the line-item table header and return it as ONE synthetic band.
 *
 * The header is not a single band: on the reference invoice it spans five
 * (y=339.6 "Unit"/"Taxable" down to y=322.9 "(Rs)"), because every multi-word
 * column label wraps. Treating any one of those lines as "the header" finds
 * only a third of the columns, so we merge the whole wrapped block.
 *
 * Expansion stops at a band carrying an actual UoM *value* (No's / Hrs), which
 * marks the first data row and can never be part of the header.
 */
function findHeaderZone(bands: Band[]): Band | undefined {
  const anchor = bands.findIndex((b) => /Part\s*No\//i.test(bandText(b)));
  if (anchor === -1) return undefined;

  let start = anchor;
  while (
    start > 0 &&
    Math.abs(bands[start - 1].y - bands[start].y) <= HEADER_WRAP_MAX_GAP &&
    !UOM_VALUE_PATTERN.test(bandText(bands[start - 1]))
  ) {
    start--;
  }

  let end = anchor;
  while (
    end < bands.length - 1 &&
    Math.abs(bands[end].y - bands[end + 1].y) <= HEADER_WRAP_MAX_GAP &&
    !UOM_VALUE_PATTERN.test(bandText(bands[end + 1]))
  ) {
    end++;
  }

  const merged: TextItem[] = [];
  for (let i = start; i <= end; i++) merged.push(...bands[i].items);
  merged.sort((a, b) => a.x - b.x);

  return { y: bands[anchor].y, items: merged };
}

/**
 * Derive column x-ranges from the header band.
 *
 * Hardcoding x ranges would break the moment a dealer's PDF template shifted a
 * column, so we read the anchors off the header itself and split at the
 * midpoint between neighbours.
 */
export function deriveColumnBounds(headerBand: Band): ColumnBound[] {
  const anchors: Array<{ key: LineItemColumn; x: number }> = [];

  for (const { key, match, pick } of HEADER_ANCHORS) {
    const xs = headerBand.items
      .filter((item) => match.test(item.str.trim()))
      .map((item) => item.x)
      .sort((a, b) => a - b);
    const x = xs[pick ?? 0];
    if (x !== undefined) anchors.push({ key, x });
  }

  if (anchors.length < 6) {
    throw new InvoicePdfParseError(
      `Could not locate the line-item table header (found ${anchors.length} of ${HEADER_ANCHORS.length} column anchors).`,
    );
  }

  anchors.sort((a, b) => a.x - b.x);

  return anchors.map((anchor, idx) => {
    const prev = anchors[idx - 1];
    const next = anchors[idx + 1];
    return {
      key: anchor.key,
      from: prev ? (prev.x + anchor.x) / 2 : Number.NEGATIVE_INFINITY,
      to: next ? (anchor.x + next.x) / 2 : Number.POSITIVE_INFINITY,
    };
  });
}

function columnOf(bounds: ColumnBound[], x: number): LineItemColumn | undefined {
  for (const b of bounds) {
    if (x >= b.from && x < b.to) return b.key;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

/**
 * Where the line-item table stops. Without this the final row keeps swallowing
 * the footer text that follows it (tax summary, T&C, gatepass) into its
 * description column.
 */
const TABLE_TERMINATORS =
  /Remarks for Sublet Job|Total Invoice Value|HSN\/SAC Code|Free Service Schedule|Terms and Conditions|GATEPASS|Acknowledgement from customer/i;

/**
 * Walk every page in order and rebuild the line-item rows.
 *
 * A band begins a new row when it has a bare integer in the Sr column AND a
 * UoM cell — the two signals together are what distinguish a real row from the
 * header, the totals line, or a wrapped continuation. Bands that are neither a
 * new row nor a terminator append their part/description text to the row in
 * progress, which is how wrapped part numbers ("90401-" + "KWP-F00") and
 * multi-line descriptions get reassembled.
 *
 * Column bounds are derived ONCE from the page that carries the header and
 * reused on later pages: the table spans pages and continuation pages repeat
 * no header, so per-page derivation would fail outright on page 2.
 */
export function extractLineItems(
  items: TextItem[],
  pageCount: number,
): { lineItems: ParsedLineItem[]; bounds: ColumnBound[] } {
  let bounds: ColumnBound[] | undefined;
  const rows: Array<Partial<Record<LineItemColumn, string>>> = [];
  let current: Partial<Record<LineItemColumn, string>> | undefined;
  let finished = false;

  for (let page = 1; page <= pageCount && !finished; page++) {
    const bands = groupIntoBands(items, page);

    let startIdx = 0;
    if (!bounds) {
      const headerZone = findHeaderZone(bands);
      if (!headerZone) continue; // header is on a later page
      bounds = deriveColumnBounds(headerZone);
      // Resume below the header block, not below the anchor line — the
      // wrapped label lines beneath it are not data.
      startIdx = bands.findIndex((b) => b.y < headerZone.y);
      while (
        startIdx > -1 &&
        startIdx < bands.length &&
        !UOM_VALUE_PATTERN.test(bandText(bands[startIdx]))
      ) {
        startIdx++;
      }
      if (startIdx === -1) startIdx = bands.length;
    }

    for (let bi = startIdx; bi < bands.length; bi++) {
      const band = bands[bi];

      if (TABLE_TERMINATORS.test(bandText(band))) {
        current = undefined;
        finished = true;
        break;
      }

      const srItem = band.items.find(
        (i) => columnOf(bounds!, i.x) === "srNo" && /^\s*\d+\s*$/.test(i.str),
      );
      const uomItem = band.items.find(
        (i) => columnOf(bounds!, i.x) === "uom" && UOM_VALUE_PATTERN.test(i.str),
      );

      if (srItem && uomItem) {
        current = {};
        for (const item of band.items) {
          const col = columnOf(bounds, item.x);
          if (!col) continue;
          current[col] = ((current[col] || "") + " " + item.str.trim()).trim();
        }
        rows.push(current);
      } else if (current) {
        for (const item of band.items) {
          const col = columnOf(bounds, item.x);
          if (col === "partNo" || col === "description") {
            current[col] = (current[col] || "") + item.str.trim();
          }
        }
      }
    }
  }

  if (!bounds) {
    throw new InvoicePdfParseError(
      "No line-item table found — this does not look like a Honda DMS service invoice.",
    );
  }

  const lineItems = rows.map((r) => {
    const uom = (r.uom || "").trim();
    return {
      srNo: Number(parseNumeric(r.srNo) ?? 0),
      partNo: (r.partNo || "").replace(/\s+/g, "").toUpperCase(),
      description: (r.description || "").replace(/\s+/g, " ").trim(),
      hsn: (r.hsn || "").replace(/\s+/g, ""),
      uom,
      kind: (/Hrs/i.test(uom) ? "LABOUR" : "PART") as LineItemKind,
      qty: parseNumeric(r.qty) ?? 0,
      unitPrice: parseNumeric(r.unitPrice),
      discountPct: parseNumeric(r.discountPct),
      discountRs: parseNumeric(r.discountRs),
      taxableAmount: parseNumeric(r.taxableAmount) ?? 0,
    };
  });

  return { lineItems, bounds };
}

// ---------------------------------------------------------------------------
// Header fields
// ---------------------------------------------------------------------------

/**
 * Header fields render as "Label:" and its value as separate text items on the
 * same band, so we find the label then take the next non-empty item to its
 * right.
 */
const HEADER_LABELS: Array<{ key: keyof ParsedInvoiceHeader; label: RegExp }> = [
  { key: "jobCardNumber", label: /^Order\s+Number$/i },
  { key: "invoiceNumber", label: /^Invoice Number$/i },
  { key: "invoiceDate", label: /^Invoice Date$/i },
  { key: "jobCardClosedDate", label: /^Jobcard Closed Date\/Time$/i },
  { key: "frameNumber", label: /^Frame No\.?$/i },
  { key: "engineNumber", label: /^Engine No\.?$/i },
  { key: "registrationNumber", label: /^Reg\.\s+No\.?$/i },
  { key: "modelName", label: /^Model Name$/i },
  { key: "modelCode", label: /^Model Code$/i },
  { key: "color", label: /^Color$/i },
  { key: "serviceType", label: /^Service Type$/i },
  { key: "serviceKm", label: /^Service KM$/i },
  { key: "advisorName", label: /^Advisor Name$/i },
  { key: "technicianName", label: /^Technician$/i },
  { key: "saleDate", label: /^Sale Date$/i },
];

const DATE_KEYS: Array<keyof ParsedInvoiceHeader> = [
  "invoiceDate",
  "jobCardClosedDate",
  "saleDate",
];

/** Strip the trailing ":" / ":-" punctuation pdfjs leaves attached to labels. */
function cleanLabel(raw: string): string {
  return raw.trim().replace(/\s*:-?\s*$/, "").trim();
}

/** The next meaningful value to the right of index `from` within a band. */
function valueAfter(band: Band, from: number): string | undefined {
  for (let i = from + 1; i < band.items.length; i++) {
    const v = band.items[i].str.trim();
    if (v === "" || v === ":" || v === ":-") continue;
    // A neighbouring label means this field was blank on the invoice.
    if (/^[A-Za-z][A-Za-z ().\/]*\s*:-?$/.test(band.items[i].str.trim())) return undefined;
    return v;
  }
  return undefined;
}

export function extractHeaderFields(items: TextItem[], pageCount: number): ParsedInvoiceHeader {
  const out: ParsedInvoiceHeader = {};

  for (let page = 1; page <= pageCount; page++) {
    for (const band of groupIntoBands(items, page)) {
      band.items.forEach((item, idx) => {
        const label = cleanLabel(item.str);
        if (!label) return;
        for (const { key, label: pattern } of HEADER_LABELS) {
          if (out[key] !== undefined) continue;
          if (!pattern.test(label)) continue;
          const raw = valueAfter(band, idx);
          if (raw === undefined) continue;
          if (DATE_KEYS.indexOf(key) !== -1) {
            const d = parseFlexibleDate(raw);
            if (d) (out as any)[key] = d;
          } else if (key === "serviceKm") {
            const n = parseNumeric(raw);
            if (n !== undefined) out.serviceKm = n;
          } else {
            (out as any)[key] = raw.trim();
          }
        }
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Parties (who the customer is)
// ---------------------------------------------------------------------------

/**
 * The party blocks are laid out in two columns: the DEALER on the left and the
 * CUSTOMER on the right. Both use identical labels ("Legal Name :",
 * "Phone(M) :"), so the x position is the only thing telling them apart —
 * reading the left column would silently register every invoice against the
 * dealer.
 *
 * Everything at/after this x belongs to the customer side.
 */
const CUSTOMER_COLUMN_MIN_X = 300;

const PARTY_LABELS: Array<{ key: keyof ParsedParties; label: RegExp }> = [
  { key: "customerName", label: /^Legal Name$/i },
  { key: "customerMobile", label: /^Phone\(M\)$/i },
  { key: "customerAccountId", label: /^Account\/Customer Id$/i },
  { key: "customerAddress", label: /^Address$/i },
  { key: "customerCity", label: /^City$/i },
  { key: "customerPin", label: /^PIN Code$/i },
];

export function extractParties(items: TextItem[]): ParsedParties {
  const out: ParsedParties = {};

  // The labels repeat across a "Ship To" and a "Bill To" block, and some are
  // blank in one of them (the sample's Ship To phone is empty while Bill To
  // carries the real number). So we take the FIRST NON-EMPTY value per label
  // rather than the first occurrence.
  for (const band of groupIntoBands(items, 1)) {
    band.items.forEach((item, idx) => {
      if (item.x < CUSTOMER_COLUMN_MIN_X) return;
      const label = cleanLabel(item.str);
      if (!label) return;
      for (const { key, label: pattern } of PARTY_LABELS) {
        if (out[key] !== undefined) continue;
        if (!pattern.test(label)) continue;
        const raw = valueAfter(band, idx);
        if (raw === undefined) continue;
        const value = raw.trim();
        if (value) out[key] = value;
      }
    });
  }

  if (out.customerMobile) {
    const digits = out.customerMobile.replace(/\D/g, "");
    out.customerMobile = digits.length > 10 ? digits.slice(-10) : digits;
    if (!out.customerMobile) delete out.customerMobile;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

const TOTAL_LABELS: Array<{ key: keyof ParsedTotals; label: RegExp }> = [
  { key: "totalPartsAmount", label: /^Total Parts Amount$/i },
  { key: "totalLabourAmount", label: /^Total Labour\/Service Amount$/i },
  { key: "totalDiscountAmount", label: /^Total Discount Amount$/i },
  { key: "totalTaxAmount", label: /^Total Tax Amount$/i },
  { key: "totalInvoiceAmount", label: /^Total Invoice Amount$/i },
  { key: "miscellaneousAmount", label: /^Miscellaneous Amount \(Consumables\)$/i },
];

export function extractTotals(items: TextItem[], pageCount: number): ParsedTotals {
  const out: ParsedTotals = {};

  for (let page = 1; page <= pageCount; page++) {
    for (const band of groupIntoBands(items, page)) {
      const items_ = band.items;
      items_.forEach((item, idx) => {
        const label = cleanLabel(item.str);
        if (!label) return;

        for (const { key, label: pattern } of TOTAL_LABELS) {
          if (out[key] !== undefined) continue;
          if (!pattern.test(label)) continue;
          const raw = valueAfter(band, idx);
          const n = parseNumeric(raw);
          if (n !== undefined) (out as any)[key] = n;
        }

        if (out.paymentMode === undefined && /^Payment Mode$/i.test(label)) {
          const raw = valueAfter(band, idx);
          if (raw) out.paymentMode = raw.trim();
        }
      });

      // Labels and values sometimes land in the same text item on the totals
      // block ("Payment Mode: Cash"), so fall back to an inline match against
      // the space-separated form.
      const text = bandTextSpaced(band);
      if (out.paymentMode === undefined) {
        // Single token only: the very next label ("Total Tax Amount") sits
        // flush against the value in the raw stream.
        const m = text.match(/Payment Mode\s*:?\s*([A-Za-z]+)/i);
        if (m) out.paymentMode = m[1].trim();
      }
      for (const { key, label } of TOTAL_LABELS) {
        if (out[key] !== undefined) continue;
        const source = label.source.replace(/^\^/, "").replace(/\$$/, "");
        const m = text.match(new RegExp(source + "\\s*:?\\s*([\\d.,]+)", "i"));
        if (m) {
          const n = parseNumeric(m[1]);
          if (n !== undefined) (out as any)[key] = n;
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Cross-check the line items against the invoice's own stated totals.
 *
 * The two are expressed on different bases: line items carry the TAXABLE
 * amount, while "Total Parts Amount" / "Total Labour Amount" are TAX
 * INCLUSIVE. On the reference invoice the parts lines sum to 666.33 while the
 * stated parts total is 786.27 — the difference is exactly the 9% CGST + 9%
 * SGST charged on those lines. So we compare against the taxable sum grossed
 * up by the invoice's own tax ratio rather than expecting a literal match.
 *
 * A mismatch means the geometric parse probably dropped or merged a row, which
 * is the one failure mode that would silently corrupt inventory — hence it
 * gates `needsReview` rather than being merely informational.
 */
const RECONCILE_TOLERANCE_RATIO = 0.02; // 2%
const RECONCILE_TOLERANCE_ABS = 5; // rupees

export function reconcile(
  lineItems: ParsedLineItem[],
  totals: ParsedTotals,
): ReconciliationResult {
  const partsTaxable = lineItems
    .filter((l) => l.kind === "PART")
    .reduce((sum, l) => sum + l.taxableAmount, 0);
  const labourTaxable = lineItems
    .filter((l) => l.kind === "LABOUR")
    .reduce((sum, l) => sum + l.taxableAmount, 0);

  const notes: string[] = [];
  let ok = true;

  const check = (
    stated: number | undefined,
    computed: number,
    what: string,
  ): number | undefined => {
    if (stated === undefined) {
      notes.push(`Invoice did not state a ${what} total; skipped that check.`);
      return undefined;
    }
    const delta = stated - computed;
    const tolerance = Math.max(
      RECONCILE_TOLERANCE_ABS,
      Math.abs(stated) * RECONCILE_TOLERANCE_RATIO,
    );
    // `stated` is tax-inclusive, so it should be >= the taxable sum but by no
    // more than a sane GST rate (28% is the highest slab in play).
    if (delta < -tolerance || delta > Math.abs(computed) * 0.3 + tolerance) {
      ok = false;
      notes.push(
        `${what}: line items total ${computed.toFixed(2)} (taxable) but the invoice states ${stated.toFixed(2)} — outside the expected GST range.`,
      );
    }
    return delta;
  };

  const partsDelta = check(totals.totalPartsAmount, partsTaxable, "Parts");
  const labourDelta = check(totals.totalLabourAmount, labourTaxable, "Labour");

  if (lineItems.length === 0) {
    ok = false;
    notes.push("No line items were extracted from the invoice.");
  }

  return { ok, partsTaxable, labourTaxable, partsDelta, labourDelta, notes };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Parse one Honda DMS service invoice PDF into structured data. */
export async function parseServiceInvoicePdf(
  buffer: Buffer,
): Promise<ParsedServiceInvoice> {
  const { items, pageCount, rawText } = await extractTextItems(buffer);

  if (items.length === 0) {
    throw new InvoicePdfParseError(
      "This PDF has no extractable text layer (it is probably a scan or photo). " +
        "Re-export the invoice from the DMS as a text PDF — scanned images are not supported.",
    );
  }

  const header = extractHeaderFields(items, pageCount);
  const parties = extractParties(items);
  const { lineItems } = extractLineItems(items, pageCount);
  const totals = extractTotals(items, pageCount);
  const reconciliation = reconcile(lineItems, totals);

  const reviewReasons: string[] = [];
  if (!reconciliation.ok) reviewReasons.push(...reconciliation.notes);
  if (!header.invoiceNumber)
    reviewReasons.push("Invoice Number missing — required to de-duplicate this invoice.");
  if (!header.frameNumber)
    reviewReasons.push("Frame No. missing — the invoice cannot be linked to a vehicle.");
  if (!parties.customerMobile)
    reviewReasons.push("Customer Phone(M) missing — the customer cannot be matched by phone.");
  for (const li of lineItems) {
    if (!li.partNo)
      reviewReasons.push(`Line ${li.srNo} has no part number / job code.`);
  }

  return {
    header,
    parties,
    lineItems,
    totals,
    reconciliation,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
    pageCount,
    rawText,
  };
}
