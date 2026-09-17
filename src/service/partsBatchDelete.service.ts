// service/partsBatchDelete.service.ts
//
// Reverses one parts-stock upload — the "something went wrong, undo it" path.
//
// A parts upload is not an append: it is a diff against the current snapshot
// (see partsStockDiff.service.ts). It inserts rows for new/changed parts, flips
// the rows it superseded to `isCurrent: false`, and then settles any service
// invoice that had been waiting on a part this file finally delivered
// (reconcilePendingStock.service.ts). Undoing it therefore means undoing all
// three, in the right order — deleting the rows alone would leave the branch
// with no current row for every part the batch touched, and would leave
// invoices claiming parts that are no longer in stock.

import mongoose from "mongoose";
import logger from "../utils/logger";
import { PartsReportModel } from "../models/PartsReport";
import { PartsReportBatchModel } from "../models/PartsReportBatch";
import { ServiceInvoiceModel } from "../models/ServiceInvoice/ServiceInvoice";
import {
  ServiceInvoiceLineItemModel,
  IServiceInvoiceLineItem,
} from "../models/ServiceInvoice/ServiceInvoiceLineItem";
import { PartsConsumptionModel } from "../models/ServiceInvoice/PartsConsumption";
import { CustomerVehicleModel } from "../models/BikeSystemModel2/CustomerVehicleModel";

/** Matches the wording partMatcher.service.ts writes onto reviewReasons. */
const pendingReason = (partNo: string): string =>
  `"${partNo}" is not in parts stock yet — recorded against this invoice and awaiting a parts-stock upload, which will mark it sold.`;

export interface ReversePartsBatchResult {
  batchId: string;
  /** Rows this batch inserted, now retired. */
  rowsRemoved: number;
  /** Rows this batch had superseded, now current again. */
  rowsRestored: number;
  /** Invoice lines pushed back to PENDING_STOCK. */
  linesUnreconciled: number;
  /** Consumption ledger rows deleted. */
  ledgerRowsRemoved: number;
  invoicesTouched: number;
}

/**
 * Undo the pending-stock settlement this batch performed.
 *
 * `reconcilePendingStock` stamps `reconciledByBatch` on every line it flipped,
 * which is what makes this exact rather than a guess: each of those lines goes
 * back to PENDING_STOCK, its ledger row is deleted (the ledger is append-only
 * in normal operation, but this row records a sale that is being retracted),
 * and its revenue moves back from parts/lubes into `pendingRevenue` on both the
 * invoice and the customer's vehicle.
 */
async function reversePendingReconciliation(
  batchId: string,
): Promise<Pick<
  ReversePartsBatchResult,
  "linesUnreconciled" | "ledgerRowsRemoved" | "invoicesTouched"
>> {
  const lines = await ServiceInvoiceLineItemModel.find({
    reconciledByBatch: batchId,
    isActive: true,
  }).lean<IServiceInvoiceLineItem[]>();

  if (lines.length === 0)
    return { linesUnreconciled: 0, ledgerRowsRemoved: 0, invoicesTouched: 0 };

  // invoiceId -> revenue that moves back into pending
  const perInvoice = new Map<
    string,
    { parts: number; lubes: number; partNos: string[] }
  >();

  for (const line of lines) {
    const invoiceId = String(line.invoiceId);
    const bucket = perInvoice.get(invoiceId) ?? {
      parts: 0,
      lubes: 0,
      partNos: [],
    };
    if (line.isLube) bucket.lubes += line.taxableAmount;
    else bucket.parts += line.taxableAmount;
    bucket.partNos.push(line.partNo);
    perInvoice.set(invoiceId, bucket);
  }

  const lineIds = lines.map((l) => l._id);

  // 1. back to PENDING_STOCK, clearing everything the settlement stamped on.
  await ServiceInvoiceLineItemModel.updateMany(
    { _id: { $in: lineIds } },
    {
      classification: "PENDING_STOCK",
      matchedPartId: null,
      soldAt: null,
      reconciledAt: null,
      reconciledByBatch: null,
      needsReview: false,
    },
  );

  // 2. drop the consumption rows this settlement wrote.
  const ledger = await PartsConsumptionModel.deleteMany({
    lineItemId: { $in: lineIds },
  });

  // 3. move the revenue back out of parts/lubes into pending.
  const invoices = await ServiceInvoiceModel.find(
    { _id: { $in: [...perInvoice.keys()] } },
    { customerVehicleId: 1, reviewReasons: 1 },
  ).lean();
  const invoiceById = new Map(invoices.map((i: any) => [String(i._id), i]));

  for (const [invoiceId, bucket] of perInvoice) {
    const moved = bucket.parts + bucket.lubes;
    await ServiceInvoiceModel.updateOne(
      { _id: invoiceId },
      {
        $inc: {
          "derivedRevenue.partsRevenue": -bucket.parts,
          "derivedRevenue.lubesRevenue": -bucket.lubes,
          "derivedRevenue.pendingRevenue": moved,
        },
      },
    );

    const inv = invoiceById.get(invoiceId);
    if (inv?.customerVehicleId) {
      await CustomerVehicleModel.updateOne(
        { _id: inv.customerVehicleId },
        {
          $inc: {
            "serviceExpenses.partsRevenue": -bucket.parts,
            "serviceExpenses.lubesRevenue": -bucket.lubes,
          },
        },
      );
    }

    // 4. put back the "awaiting stock" review reasons the settlement cleared,
    //    so these invoices reappear in the review queue where they belong.
    const existing: string[] = inv?.reviewReasons ?? [];
    const restored = [...existing];
    for (const partNo of bucket.partNos) {
      const reason = pendingReason(partNo);
      if (!restored.includes(reason)) restored.push(reason);
    }
    await ServiceInvoiceModel.updateOne(
      { _id: invoiceId },
      { reviewReasons: restored, needsReview: restored.length > 0 },
    );
  }

  return {
    linesUnreconciled: lines.length,
    ledgerRowsRemoved: ledger.deletedCount ?? 0,
    invoicesTouched: perInvoice.size,
  };
}

/**
 * Reverse a parts-stock batch completely.
 *
 * The caller is responsible for authorization and for the "is this the latest
 * batch" check — see controllers/Parts/partsBatchDelete.controller.ts. Reversing
 * anything other than the newest batch is refused there, because every later
 * batch was diffed against the snapshot this one produced; undoing a middle
 * link would silently invalidate all of them.
 */
export async function reversePartsBatch(
  batchId: string,
  branchId: mongoose.Types.ObjectId | string,
  deletedBy: mongoose.Types.ObjectId,
  deletedByRole: string,
): Promise<ReversePartsBatchResult> {
  const reconciliation = await reversePendingReconciliation(batchId);

  // Retire this batch's rows BEFORE restoring the ones it superseded. Both
  // carry the same part numbers, and at most one row per part number per
  // branch may be `isCurrent` — restoring first would collide with the live
  // unique index.
  const removed = await PartsReportModel.updateMany(
    { importBatch: batchId, isActive: true },
    {
      isActive: false,
      isCurrent: false,
      deletedBy,
      deletedByRole,
      deletedAt: new Date(),
    },
  );

  const restored = await PartsReportModel.updateMany(
    { supersededByBatch: batchId },
    { isCurrent: true, supersededByBatch: null },
  );

  await PartsReportBatchModel.updateOne(
    { batchId },
    {
      isActive: false,
      deletedBy,
      deletedByRole,
      deletedAt: new Date(),
    },
  );

  logger.info(
    `Parts batch reversed: ${batchId} (branch ${branchId}) — ` +
      `${removed.modifiedCount} row(s) retired, ${restored.modifiedCount} restored, ` +
      `${reconciliation.linesUnreconciled} invoice line(s) back to pending`,
  );

  return {
    batchId,
    rowsRemoved: removed.modifiedCount ?? 0,
    rowsRestored: restored.modifiedCount ?? 0,
    ...reconciliation,
  };
}
