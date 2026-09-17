// service/serviceInvoice/effectiveStock.service.ts
//
// Derives "what is actually on the shelf" by netting service consumption off
// the last dealer stock count, without ever writing to the stock rows
// themselves. See models/ServiceInvoice/PartsConsumption.ts for why the
// decrement has to be derived rather than stored.

import mongoose from "mongoose";
import { PartsReportModel } from "../../models/PartsReport";
import { PartsConsumptionModel } from "../../models/ServiceInvoice/PartsConsumption";

export interface EffectiveStockRow {
  partNumber: string;
  description?: string;
  /** Quantity from the most recent parts-stock upload. */
  stockQty: number;
  /** Quantity consumed by service work since that upload landed. */
  consumedQty: number;
  /** stockQty - consumedQty, floored at 0. */
  effectiveQty: number;
  unitPrice?: number;
  /** When the stock figure was last refreshed by an upload. */
  stockAsOf?: Date;
  /** True when consumption exceeds the counted stock — worth investigating. */
  oversold: boolean;
}

export interface EffectiveStockResult {
  rows: EffectiveStockRow[];
  totals: {
    partsTracked: number;
    totalStockQty: number;
    totalConsumedQty: number;
    totalEffectiveQty: number;
    oversoldCount: number;
  };
}

/**
 * Start of `d`'s UTC day.
 *
 * The cutoff below has to be compared at day granularity, because the two
 * sides carry different precision: a stock row's `importDate` is a real
 * timestamp, while an invoice's `consumedAt` comes from a printed date and is
 * therefore midnight UTC. Comparing them directly would drop every consumption
 * that happened on the same calendar day as a stock count — the invoice would
 * always look "earlier" than a count taken later that afternoon.
 *
 * When both fall on the same day we genuinely cannot order them, so we count
 * the consumption. Under-reporting what is on the shelf is the safe direction
 * to be wrong in; over-reporting invites selling stock that isn't there.
 */
function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Net consumption against the current stock snapshot for one branch.
 *
 * Only consumption from the day of a part's own `importDate` onwards counts:
 * once a newer physical count arrives from the dealer, everything consumed
 * before it is already baked into that number, and subtracting it again would
 * double-count.
 */
export async function getEffectiveStock(
  branchId: string,
  opts: { partNumber?: string } = {},
): Promise<EffectiveStockResult> {
  const branchObjectId = new mongoose.Types.ObjectId(branchId);

  const stockFilter: Record<string, any> = {
    branchId: branchObjectId,
    isActive: true,
    isCurrent: true,
  };
  if (opts.partNumber) {
    stockFilter["normalized.partNumber"] = opts.partNumber.trim().toUpperCase();
  }

  const stockRows = await PartsReportModel.find(stockFilter, {
    normalized: 1,
    importDate: 1,
  }).lean();

  if (stockRows.length === 0) {
    return {
      rows: [],
      totals: {
        partsTracked: 0,
        totalStockQty: 0,
        totalConsumedQty: 0,
        totalEffectiveQty: 0,
        oversoldCount: 0,
      },
    };
  }

  // One grouped read for the whole branch, then filter per part by its own
  // stock date — cheaper than a query per part number.
  const consumption = await PartsConsumptionModel.aggregate<{
    _id: string;
    entries: Array<{ qty: number; consumedAt: Date }>;
  }>([
    { $match: { branchId: branchObjectId, isActive: true } },
    {
      $group: {
        _id: "$partNumber",
        entries: { $push: { qty: "$qty", consumedAt: "$consumedAt" } },
      },
    },
  ]);

  const consumptionByPart = new Map(consumption.map((c) => [c._id, c.entries]));

  const rows: EffectiveStockRow[] = [];
  for (const row of stockRows) {
    const normalized = (row as any).normalized || {};
    const partNumber: string = normalized.partNumber;
    if (!partNumber) continue;

    const stockQty = Number(normalized.quantity ?? 0);
    const stockAsOf: Date | undefined = (row as any).importDate;

    const entries = consumptionByPart.get(partNumber) || [];
    const cutoff = stockAsOf ? startOfUtcDay(new Date(stockAsOf)) : undefined;
    const consumedQty = entries.reduce((sum, e) => {
      if (cutoff !== undefined && startOfUtcDay(new Date(e.consumedAt)) < cutoff) {
        return sum;
      }
      return sum + Number(e.qty ?? 0);
    }, 0);

    rows.push({
      partNumber,
      description: normalized.description,
      stockQty,
      consumedQty,
      effectiveQty: Math.max(0, stockQty - consumedQty),
      unitPrice: normalized.unitPrice,
      stockAsOf,
      oversold: consumedQty > stockQty,
    });
  }

  rows.sort((a, b) => a.partNumber.localeCompare(b.partNumber));

  return {
    rows,
    totals: {
      partsTracked: rows.length,
      totalStockQty: rows.reduce((s, r) => s + r.stockQty, 0),
      totalConsumedQty: rows.reduce((s, r) => s + r.consumedQty, 0),
      totalEffectiveQty: rows.reduce((s, r) => s + r.effectiveQty, 0),
      oversoldCount: rows.filter((r) => r.oversold).length,
    },
  };
}
