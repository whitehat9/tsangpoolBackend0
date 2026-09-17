// service/serviceInvoice/partMatcher.service.ts
//
// Decides, for every line on a service invoice, whether it was a part sold out
// of this branch's parts stock or an accessory the technician fitted to the
// bike — by checking the invoice's part number against parts inventory.

import { getCurrentSnapshot } from "../partsStockDiff.service";
import type {
  ParsedLineItem,
  LineItemKind,
} from "./invoicePdfExtractor";
import type {
  LineItemClassification,
  PartMatchQuality,
} from "../../models/ServiceInvoice/ServiceInvoiceLineItem";

export interface ClassifiedLineItem extends ParsedLineItem {
  matchKey: string;
  classification: LineItemClassification;
  matchQuality: PartMatchQuality;
  matchedPartId: string | null;
  isLube: boolean;
  /** Null while PENDING_STOCK; set once the line is known to be sold. */
  soldAt: Date | null;
  needsReview: boolean;
  reviewReason?: string;
}

export interface ClassificationSummary {
  sold: number;
  /** Billed parts not in stock yet — awaiting a Part-Admin stock upload. */
  pending: number;
  accessory: number;
  labour: number;
  looseMatches: number;
  /** Part numbers that were not found in stock. */
  unmatchedPartNumbers: string[];
}

export interface ClassificationResult {
  lineItems: ClassifiedLineItem[];
  summary: ClassificationSummary;
  revenue: {
    partsRevenue: number;
    lubesRevenue: number;
    accessoriesRevenue: number;
    pendingRevenue: number;
    labourRevenue: number;
  };
}

/**
 * Stock stores part numbers trimmed + uppercased and nothing else (see
 * utils/partsColumnMatcher.ts), so an invoice number has to agree
 * character-for-character to match exactly.
 */
export function exactKey(partNo: string): string {
  return String(partNo ?? "").trim().toUpperCase();
}

/**
 * Tolerant key: additionally drop the separators dealers are inconsistent
 * about, so "06435-K0W-N01", "06435 K0W N01" and "06435K0WN01" collapse to the
 * same thing. A match found only at this level is still treated as SOLD but
 * flagged, because a punctuation difference can also mean two genuinely
 * different parts in some numbering schemes.
 */
export function looseKey(partNo: string): string {
  return exactKey(partNo).replace(/[-\s._/]/g, "");
}

/**
 * Lubricants are billed as parts but roll up separately on the vehicle
 * (`serviceExpenses.lubesRevenue`). The old XLSX import got that split from a
 * dedicated "Lubes Revenue" column, which the PDF does not have — so we use
 * the invoice's own HSN classification instead of guessing from the
 * description. HSN chapter 2710 is petroleum oils and lubricating preparations.
 */
export function isLubeHsn(hsn: string): boolean {
  return /^2710/.test(String(hsn ?? "").trim());
}

/**
 * Classify every line of one invoice against the branch's current parts stock.
 *
 * LABOUR lines short-circuit — they are job codes, never inventory.
 */
export async function classifyLineItems(
  branchId: string,
  parsed: ParsedLineItem[],
  /** The invoice's own date — when a matched part actually left the shelf. */
  soldAtDate: Date | null = null,
): Promise<ClassificationResult> {
  const snapshot = await getCurrentSnapshot(branchId);

  // Build a loose-key index alongside the exact map the diff service gives us.
  const looseIndex = new Map<string, { id: string; collisions: number }>();
  snapshot.forEach((entry, partNumber) => {
    const key = looseKey(partNumber);
    const existing = looseIndex.get(key);
    if (existing) {
      existing.collisions += 1;
    } else {
      looseIndex.set(key, { id: String(entry._id), collisions: 1 });
    }
  });

  const lineItems: ClassifiedLineItem[] = [];
  const summary: ClassificationSummary = {
    sold: 0,
    pending: 0,
    accessory: 0,
    labour: 0,
    looseMatches: 0,
    unmatchedPartNumbers: [],
  };
  const revenue = {
    partsRevenue: 0,
    lubesRevenue: 0,
    accessoriesRevenue: 0,
    pendingRevenue: 0,
    labourRevenue: 0,
  };

  for (const item of parsed) {
    const exact = exactKey(item.partNo);
    const loose = looseKey(item.partNo);
    const isLube = isLubeHsn(item.hsn);

    if (item.kind === ("LABOUR" as LineItemKind)) {
      summary.labour += 1;
      revenue.labourRevenue += item.taxableAmount;
      lineItems.push({
        ...item,
        matchKey: loose,
        classification: "LABOUR",
        matchQuality: "none",
        matchedPartId: null,
        isLube: false,
        soldAt: null,
        needsReview: false,
      });
      continue;
    }

    const exactHit = snapshot.get(exact);
    if (exactHit) {
      summary.sold += 1;
      if (isLube) revenue.lubesRevenue += item.taxableAmount;
      else revenue.partsRevenue += item.taxableAmount;
      lineItems.push({
        ...item,
        matchKey: loose,
        classification: "SOLD",
        matchQuality: "exact",
        matchedPartId: String(exactHit._id),
        isLube,
        soldAt: soldAtDate,
        needsReview: false,
      });
      continue;
    }

    const looseHit = looseIndex.get(loose);
    if (looseHit) {
      summary.sold += 1;
      summary.looseMatches += 1;
      if (isLube) revenue.lubesRevenue += item.taxableAmount;
      else revenue.partsRevenue += item.taxableAmount;
      const ambiguous = looseHit.collisions > 1;
      lineItems.push({
        ...item,
        matchKey: loose,
        classification: "SOLD",
        matchQuality: "loose",
        matchedPartId: ambiguous ? null : looseHit.id,
        isLube,
        soldAt: soldAtDate,
        needsReview: true,
        reviewReason: ambiguous
          ? `"${item.partNo}" matched ${looseHit.collisions} stock part numbers once punctuation was ignored — confirm which one was actually used.`
          : `"${item.partNo}" only matched stock after ignoring punctuation — confirm it is the same part.`,
      });
      continue;
    }

    // Not in stock. This is far more often a timing gap than a real accessory:
    // service invoices arrive continuously while parts stock is uploaded in
    // batches, so the part is usually just not imported yet. Park the line as
    // PENDING_STOCK — it books no parts revenue and takes no stock — and let
    // the next parts-stock upload resolve it to SOLD
    // (reconcilePendingStock.service.ts). Calling it an accessory here would
    // permanently mis-attribute a part that simply hadn't been uploaded.
    summary.pending += 1;
    summary.unmatchedPartNumbers.push(item.partNo);
    revenue.pendingRevenue += item.taxableAmount;
    lineItems.push({
      ...item,
      matchKey: loose,
      classification: "PENDING_STOCK",
      matchQuality: "none",
      matchedPartId: null,
      isLube,
      soldAt: null,
      needsReview: true,
      reviewReason: `"${item.partNo}" is not in parts stock yet — recorded against this invoice and awaiting a parts-stock upload, which will mark it sold.`,
    });
  }

  return { lineItems, summary, revenue };
}
