// utils/parseValues.ts
//
// Shared value coercion for dealer-export ingestion (counter-sale spreadsheets,
// service-invoice PDFs, ...). These used to live privately inside
// service/counterSaleReport.service.ts; they were lifted here so the
// service-invoice PDF extractor can reuse the exact same semantics rather
// than growing a second, subtly-different copy.

/** Strip currency/thousands noise and coerce to a finite number, else undefined. */
export function parseNumeric(raw: any): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const cleaned = String(raw).replace(/[,₹$\s]/g, "").trim();
  if (cleaned === "") return undefined;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a dealer-export date.
 *
 * DD-MM-YYYY / DD/MM/YYYY (and 2-digit year variants) is the real dealer
 * format and MUST be tried before the generic `new Date(str)` fallback, which
 * happily (mis)parses ambiguous dates as US-style MM-DD-YYYY. Honda DMS
 * invoices additionally carry a time component ("14/09/2026 02:49:50 PM"),
 * which the leading-anchored regex ignores by design — only the date part is
 * significant for reporting, and mixing in a local time would shift the day
 * across timezones.
 */
export function parseFlexibleDate(raw: any): Date | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const str = String(raw).trim();

  const match = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isNaN(d.getTime())) return d;
  }

  const direct = new Date(str);
  if (!Number.isNaN(direct.getTime())) return direct;

  return undefined;
}
