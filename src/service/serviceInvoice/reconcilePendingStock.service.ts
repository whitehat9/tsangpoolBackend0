// service/serviceInvoice/reconcilePendingStock.service.ts
//
// Closes the timing gap between service invoices and parts-stock uploads.
//
// Service invoices arrive continuously; parts stock is uploaded in batches. So
// an invoice routinely bills a part that has not been imported yet, and the
// importer parks that line as PENDING_STOCK rather than guessing it is an
// accessory (see partMatcher.service.ts).
//
// This runs after a parts-stock upload and settles those debts: every pending
// line whose part number just arrived becomes SOLD, dated, with its consumption
// ledger row written and its revenue moved out of the "pending" bucket into
// parts/lubes — on the invoice and on the customer's vehicle.

import mongoose from "mongoose";
import logger from "../../utils/logger";
import { ServiceInvoiceModel } from "../../models/ServiceInvoice/ServiceInvoice";
import {
  ServiceInvoiceLineItemModel,
  IServiceInvoiceLineItem,
} from "../../models/ServiceInvoice/ServiceInvoiceLineItem";
import { PartsConsumptionModel } from "../../models/ServiceInvoice/PartsConsumption";
import { CustomerVehicleModel } from "../../models/BikeSystemModel2/CustomerVehicleModel";
import { PartsReportModel } from "../../models/PartsReport";
import { exactKey, looseKey } from "./partMatcher.service";

export interface ReconciledLine {
  invoiceId: string;
  invoiceNumber: string;
  lineItemId: string;
  partNo: string;
  qty: number;
  taxableAmount: number;
  matchQuality: "exact" | "loose";
  soldAt: Date;
}

export interface ReconcileResult {
  /** Pending lines examined for this branch. */
  examined: number;
  /** Lines flipped to SOLD. */
  resolved: number;
  /** Still pending — their part number is still not in stock. */
  stillPending: number;
  /** Distinct invoices touched. */
  invoicesTouched: number;
  lines: ReconciledLine[];
}

const EMPTY: ReconcileResult = {
  examined: 0,
  resolved: 0,
  stillPending: 0,
  invoicesTouched: 0,
  lines: [],
};

/**
 * Resolve this branch's PENDING_STOCK invoice lines against current parts stock.
 *
 * Safe to call repeatedly: it only ever reads lines that are still
 * PENDING_STOCK, and flips them in one step to SOLD, so a second run finds
 * nothing to do. Never throws into the caller — a parts upload must not fail
 * because reconciliation hit a problem.
 *
 * @param batchId the parts batch that triggered this, recorded on each line
 */
export async function reconcilePendingStock(
  branchId: string,
  batchId?: string,
): Promise<ReconcileResult> {
  try {
    const branchObjectId = new mongoose.Types.ObjectId(branchId);

    const pending = await ServiceInvoiceLineItemModel.find({
      branchId: branchObjectId,
      classification: "PENDING_STOCK",
      isActive: true,
    }).lean<IServiceInvoiceLineItem[]>();

    if (pending.length === 0) return { ...EMPTY };

    // Current stock for this branch, indexed both ways — same two-tier match
    // the importer uses, so a line resolves here exactly as it would have at
    // import time had the stock been present.
    const stockRows = await PartsReportModel.find(
      { branchId: branchObjectId, isActive: true, isCurrent: true },
      { normalized: 1 },
    ).lean();

    const exactIndex = new Map<string, string>();
    const looseIndex = new Map<string, { id: string; collisions: number }>();
    for (const row of stockRows) {
      const partNumber = (row as any).normalized?.partNumber;
      if (!partNumber) continue;
      const id = String((row as any)._id);
      exactIndex.set(exactKey(partNumber), id);
      const lk = looseKey(partNumber);
      const hit = looseIndex.get(lk);
      if (hit) hit.collisions += 1;
      else looseIndex.set(lk, { id, collisions: 1 });
    }

    const now = new Date();
    const resolvedLines: ReconciledLine[] = [];
    // invoiceId -> revenue that moves out of pending
    const perInvoice = new Map<
      string,
      { parts: number; lubes: number; lineIds: string[] }
    >();

    for (const line of pending) {
      const exact = exactIndex.get(exactKey(line.partNo));
      const loose = !exact ? looseIndex.get(line.matchKey) : undefined;
      if (!exact && !loose) continue;

      const matchedPartId = exact ?? (loose!.collisions === 1 ? loose!.id : null);
      const invoiceId = String(line.invoiceId);

      const bucket = perInvoice.get(invoiceId) ?? {
        parts: 0,
        lubes: 0,
        lineIds: [],
      };
      if (line.isLube) bucket.lubes += line.taxableAmount;
      else bucket.parts += line.taxableAmount;
      bucket.lineIds.push(String(line._id));
      perInvoice.set(invoiceId, bucket);

      resolvedLines.push({
        invoiceId,
        invoiceNumber: "",
        lineItemId: String(line._id),
        partNo: line.partNo,
        qty: line.qty,
        taxableAmount: line.taxableAmount,
        matchQuality: exact ? "exact" : "loose",
        soldAt: now,
        // matchedPartId is carried through the update below
        ...({ matchedPartId } as any),
      });
    }

    if (resolvedLines.length === 0) {
      return {
        examined: pending.length,
        resolved: 0,
        stillPending: pending.length,
        invoicesTouched: 0,
        lines: [],
      };
    }

    // Invoice numbers + the consumption date (when the part actually left the
    // shelf — the job card's close date, not today).
    const invoices = await ServiceInvoiceModel.find(
      { _id: { $in: [...perInvoice.keys()] } },
      {
        invoiceNumber: 1,
        jobCardClosedDate: 1,
        invoiceDate: 1,
        frameNumber: 1,
        technicianName: 1,
        customerVehicleId: 1,
      },
    ).lean();
    const invoiceById = new Map(invoices.map((i: any) => [String(i._id), i]));

    // ── 1. flip the lines ──────────────────────────────────────────────────
    for (const line of resolvedLines) {
      const inv = invoiceById.get(line.invoiceId);
      line.invoiceNumber = inv?.invoiceNumber ?? "";
      await ServiceInvoiceLineItemModel.updateOne(
        { _id: line.lineItemId },
        {
          classification: "SOLD",
          matchQuality: line.matchQuality,
          matchedPartId: (line as any).matchedPartId ?? null,
          soldAt: now,
          reconciledAt: now,
          reconciledByBatch: batchId ?? null,
          needsReview: line.matchQuality === "loose",
        },
      );
    }

    // ── 2. write the consumption ledger rows ───────────────────────────────
    const consumptionDocs = resolvedLines.map((line) => {
      const inv = invoiceById.get(line.invoiceId);
      return {
        partNumber: line.partNo,
        matchKey: looseKey(line.partNo),
        qty: line.qty,
        taxableAmount: line.taxableAmount,
        invoiceId: new mongoose.Types.ObjectId(line.invoiceId),
        lineItemId: new mongoose.Types.ObjectId(line.lineItemId),
        matchedPartId: (line as any).matchedPartId ?? null,
        branchId: branchObjectId,
        // The part was consumed when the job card closed, not when the stock
        // file happened to be uploaded. getEffectiveStock() then correctly
        // ignores it if the stock count post-dates that (the count already
        // reflects it), which is exactly what we want for a back-filled sale.
        consumedAt: inv?.jobCardClosedDate || inv?.invoiceDate || now,
        frameNumber: inv?.frameNumber,
        technicianName: inv?.technicianName,
      };
    });
    if (consumptionDocs.length > 0) {
      await PartsConsumptionModel.insertMany(consumptionDocs);
    }

    // ── 3. move revenue out of pending, on the invoice and the vehicle ─────
    for (const [invoiceId, bucket] of perInvoice) {
      const moved = bucket.parts + bucket.lubes;
      await ServiceInvoiceModel.updateOne(
        { _id: invoiceId },
        {
          $inc: {
            "derivedRevenue.partsRevenue": bucket.parts,
            "derivedRevenue.lubesRevenue": bucket.lubes,
            "derivedRevenue.pendingRevenue": -moved,
          },
        },
      );

      const inv = invoiceById.get(invoiceId);
      if (inv?.customerVehicleId) {
        await CustomerVehicleModel.updateOne(
          { _id: inv.customerVehicleId },
          {
            $inc: {
              "serviceExpenses.partsRevenue": bucket.parts,
              "serviceExpenses.lubesRevenue": bucket.lubes,
            },
          },
        );
      }
    }

    // ── 4. clear the invoice-level review flag where nothing is left pending ─
    await refreshInvoiceReviewState([...perInvoice.keys()]);

    logger.info(
      `Parts stock upload${batchId ? ` ${batchId}` : ""}: reconciled ${resolvedLines.length} pending invoice line(s) across ${perInvoice.size} invoice(s) for branch ${branchId}`,
    );

    return {
      examined: pending.length,
      resolved: resolvedLines.length,
      stillPending: pending.length - resolvedLines.length,
      invoicesTouched: perInvoice.size,
      lines: resolvedLines,
    };
  } catch (err: any) {
    // Never fail the parts upload because of this.
    logger.error(`reconcilePendingStock failed for branch ${branchId}: ${err?.message}`);
    return { ...EMPTY };
  }
}

/**
 * Drop the "awaiting stock" reasons from invoices that have no pending lines
 * left, so a resolved invoice stops showing in the review queue.
 */
async function refreshInvoiceReviewState(invoiceIds: string[]): Promise<void> {
  for (const id of invoiceIds) {
    const stillPending = await ServiceInvoiceLineItemModel.countDocuments({
      invoiceId: id,
      classification: "PENDING_STOCK",
      isActive: true,
    });
    if (stillPending > 0) continue;

    const invoice = await ServiceInvoiceModel.findById(id).select(
      "reviewReasons",
    );
    if (!invoice) continue;

    const remaining = (invoice.reviewReasons || []).filter(
      (r) => !/is not in parts stock yet/i.test(r),
    );
    invoice.reviewReasons = remaining;
    invoice.needsReview = remaining.length > 0;
    await invoice.save();
  }
}
