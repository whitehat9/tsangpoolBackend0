/**
 * Dedicated, SalesReport-only column matcher/normalizer. Deliberately NOT a
 * reuse of utils/dataImport/columnMatcher.ts — the SalesReport module owns
 * its own business column-mapping, independent of the generic multi-dataset
 * DataImport module (mirrors utils/partsColumnMatcher.ts's and
 * utils/partsColumnMatcher.ts's isolation rationale).
 *
 * This is the mandatory-field checker: every field below is `required`, so a
 * CSV missing any of them is rejected up front with the exact missing labels
 * — see matchSalesReportColumns().
 */

export interface SalesReportNormalizedRow {
  modelName?: string;
  modelVariant?: string;
  customerFirstName?: string;
  customerLastName?: string;
  customerMobile?: string;
  frameNo?: string;
  engineNo?: string;
  purchaseType?: string;
  totalPayment?: number;
  // Alternative ("Sl No / DATE / CUSTOMER NAME / PHONE NO. / LOCATION / ...")
  // layout. All optional — imported whenever the file carries the column.
  slNo?: string;
  saleDate?: Date;
  location?: string;
  colour?: string;
  rto?: string;
  insurance?: string;
  hsrp?: string;
}

interface SalesReportField {
  key: keyof SalesReportNormalizedRow | "customerName";
  label: string;
  required: boolean;
  /**
   * When true, the field is only enforced for the standard layout. A file
   * carrying the single "Customer Name" column (the alternative layout) has
   * no variant / first+last name / purchase type / payment columns at all.
   */
  optionalInAltLayout?: boolean;
  aliases: string[];
}

const SALES_REPORT_FIELDS: SalesReportField[] = [
  { key: "modelName", label: "Model Name", required: true, aliases: ["Model", "Model Name"] },
  { key: "modelVariant", label: "Model Variant", required: false, aliases: ["Variant", "Model Variant"] },
  { key: "customerFirstName", label: "Customer First Name", required: true, optionalInAltLayout: true, aliases: ["First Name", "Customer First Name"] },
  { key: "customerLastName", label: "Customer Last Name", required: true, optionalInAltLayout: true, aliases: ["Last Name", "Customer Last Name"] },
  { key: "customerMobile", label: "Contact Mobile", required: true, aliases: ["Mobile", "Contact Number", "Customer Mobile", "Contact Mobile", "Contact Mobile Phone #", "Phone No", "Phone Number"] },
  { key: "frameNo", label: "Frame No", required: true, aliases: ["Frame Number", "Chassis No", "Chassis Number", "Frame No", "Frame#"] },
  { key: "engineNo", label: "Engine No", required: true, aliases: ["Engine Number", "Engine No", "Engine No/Motor No", "Engin No"] },
  { key: "purchaseType", label: "Purchase Type", required: false, aliases: ["Purchase Type"] },
  { key: "totalPayment", label: "Total Payment", required: false, aliases: ["Total Payment", "Total Amount"] },
  // --- Alternative layout columns (optional; stored whenever present) ---
  { key: "customerName", label: "Customer Name", required: false, aliases: ["Customer Name", "Name"] },
  { key: "slNo", label: "Sl No", required: false, aliases: ["Sl No", "Sl. No", "S No", "Serial No"] },
  { key: "saleDate", label: "Date", required: false, aliases: ["Date", "Sale Date", "Sold Date"] },
  { key: "location", label: "Location", required: false, aliases: ["Location"] },
  { key: "colour", label: "Colour", required: false, aliases: ["Colour", "Color"] },
  { key: "rto", label: "RTO", required: false, aliases: ["RTO"] },
  { key: "insurance", label: "Insurance", required: false, aliases: ["Insurance"] },
  { key: "hsrp", label: "HSRP", required: false, aliases: ["HSRP"] },
];

export interface SalesReportMatchedField {
  canonicalKey: string;
  label: string;
  sourceColumn: string;
}

export interface SalesReportField_MissingEntry {
  key: string;
  label: string;
}

export interface SalesReportColumnMatchResult {
  matchedFields: SalesReportMatchedField[];
  unmatchedColumns: string[];
  missingRequired: SalesReportField_MissingEntry[];
  isValid: boolean;
}

/**
 * Every known header string (canonical labels + aliases) for the SalesReport
 * dataset. Passed to the file parser so it can locate the real header row
 * when a dealer export carries title/blank rows above it, and pick the right
 * delimiter for ambiguous CSVs — see dataImport.service.ts#detectHeaderRowIndex,
 * mirrors getPartsHeaderAliases().
 */
export function getSalesReportHeaderAliases(): string[] {
  const all: string[] = [];
  SALES_REPORT_FIELDS.forEach((f) => {
    all.push(f.label, ...f.aliases);
  });
  return all;
}

/** Normalize a header for comparison: trim, collapse whitespace, lowercase, strip punctuation. */
function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[.:/\\_#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map a file's detected columns onto the SalesReport canonical fields. */
export function matchSalesReportColumns(
  detectedColumns: string[],
): SalesReportColumnMatchResult {
  const lookup = new Map<string, SalesReportField>();
  SALES_REPORT_FIELDS.forEach((field) => {
    lookup.set(normalizeHeader(field.label), field);
    field.aliases.forEach((alias) => lookup.set(normalizeHeader(alias), field));
  });

  const matchedFields: SalesReportMatchedField[] = [];
  const unmatchedColumns: string[] = [];
  const matchedKeys = new Set<string>();

  detectedColumns.forEach((column) => {
    const field = lookup.get(normalizeHeader(column));
    if (field) {
      matchedFields.push({ canonicalKey: field.key, label: field.label, sourceColumn: column });
      matchedKeys.add(field.key);
    } else {
      unmatchedColumns.push(column);
    }
  });

  const isAltLayout = matchedKeys.has("customerName");
  const missingRequired = SALES_REPORT_FIELDS.filter(
    (f) =>
      f.required &&
      !(isAltLayout && f.optionalInAltLayout) &&
      !matchedKeys.has(f.key),
  ).map((f) => ({ key: f.key, label: f.label }));

  return {
    matchedFields,
    unmatchedColumns,
    missingRequired,
    isValid: missingRequired.length === 0,
  };
}

const JOIN_KEY_STRING_FIELDS = new Set(["frameNo", "engineNo"]);
const NUMERIC_KEYS = new Set(["totalPayment"]);

/**
 * Parse a date cell. Dealer exports are day-first (dd/mm/yyyy, dd-mm-yyyy);
 * a JS Date or an ISO string is accepted as-is. Returns undefined when
 * unparseable so the caller can flag the row for review instead of storing
 * garbage.
 */
function parseDate(raw: any): Date | undefined {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw;
  const str = stripWrappingQuotes(raw);
  if (!str) return undefined;
  const m = str.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1])));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Split one full-name cell into first / last (last token = last name). */
function splitFullName(full: string): { first: string; last: string } {
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] ?? "", last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

/**
 * Some dealer-export tools (the same broken exporter behind this module's
 * UTF-16 mis-decoding — see salesReport.service.ts#repairMisdecodedUtf16)
 * write every cell wrapped in a literal pair of straight double quotes, e.g.
 * a Frame No cell containing the 19 characters `"ME4JK430DTW427360"` rather
 * than the 17-character value itself. Left in place, this breaks stock
 * matching outright (the quoted frame/engine number never equals the clean
 * value stored on StockConceptCSV) and silently zeroes numeric fields (see
 * parseNumeric below) — so every string value is unwrapped before use.
 */
function stripWrappingQuotes(raw: any): string {
  const str = String(raw ?? "").trim();
  if (str.length >= 2 && str.startsWith('"') && str.endsWith('"')) {
    return str.slice(1, -1).trim();
  }
  return str;
}

/**
 * Parses a money cell that may be wrapped in quotes, prefixed/suffixed with
 * a currency word or symbol (e.g. `"Rs.90,194.55"`), or written in the
 * accounting convention of parentheses for a non-positive amount (e.g.
 * `"(Rs.0.00)"`). Currency letters/symbols are trimmed off the ends first —
 * a blanket "strip every non-digit character" pass would instead be fooled
 * by "Rs."'s own trailing period, which lands right in front of the real
 * number and gets misread as a bogus leading decimal point (turning
 * "Rs.90,194.55" into 0.90194 instead of 90194.55).
 */
function parseNumeric(raw: any): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let str = stripWrappingQuotes(raw);
  if (str === "") return undefined;

  const isParenthesizedNegative = /^\(.*\)$/.test(str);
  if (isParenthesizedNegative) str = str.slice(1, -1).trim();

  // Trim any leading/trailing run of non-digit, non-minus characters
  // (currency words like "Rs.", symbols like "₹"/"$", stray spaces) before
  // the comma/decimal-point content in between is touched.
  str = str.replace(/^[^\d-]+/, "").replace(/[^\d.]+$/, "");
  const cleaned = str.replace(/,/g, "").trim();
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return undefined;
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return undefined;
  return isParenthesizedNegative ? -n : n;
}

/** Build the canonical normalized object for one parsed SalesReport row. */
export function buildSalesReportNormalizedRow(
  rowData: Record<string, any>,
  matchResult: SalesReportColumnMatchResult,
): { normalized: SalesReportNormalizedRow; needsReview: boolean } {
  const normalized: SalesReportNormalizedRow = {};
  let needsReview = false;
  let fullName = "";

  matchResult.matchedFields.forEach(({ canonicalKey, sourceColumn }) => {
    const raw = rowData[sourceColumn];

    if (JOIN_KEY_STRING_FIELDS.has(canonicalKey)) {
      const value = stripWrappingQuotes(raw).toUpperCase();
      if (value) (normalized as any)[canonicalKey] = value;
      return;
    }

    if (canonicalKey === "customerName") {
      const value = stripWrappingQuotes(raw);
      if (value) fullName = value;
      return;
    }

    if (canonicalKey === "saleDate") {
      const value = parseDate(raw);
      if (value) normalized.saleDate = value;
      else if (stripWrappingQuotes(raw) !== "") needsReview = true;
      return;
    }

    if (NUMERIC_KEYS.has(canonicalKey)) {
      const value = parseNumeric(raw);
      if (value === undefined) {
        if (stripWrappingQuotes(raw) !== "") needsReview = true;
      } else {
        (normalized as any)[canonicalKey] = value;
      }
      return;
    }

    const value = stripWrappingQuotes(raw);
    if (value) (normalized as any)[canonicalKey] = value;
  });

  // Alternative layout: only a single "Customer Name" column. Split it unless
  // the file also carried explicit first/last name columns.
  if (fullName && !normalized.customerFirstName && !normalized.customerLastName) {
    const { first, last } = splitFullName(fullName);
    if (first) normalized.customerFirstName = first;
    if (last) normalized.customerLastName = last;
  }

  return { normalized, needsReview };
}
