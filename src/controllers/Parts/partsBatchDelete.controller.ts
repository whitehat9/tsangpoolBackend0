import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { PartsReportModel } from "../../models/PartsReport";
import { PartsReportBatchModel } from "../../models/PartsReportBatch";
import { reversePartsBatch } from "../../service/partsBatchDelete.service";
import { getUserBranch, getUserRole, isAdmin } from "../../types/user.types";

/**
 * @desc    Reverse a parts-stock batch — undo a bad upload. Retires the rows
 *          it inserted, restores the rows it superseded, and pushes any
 *          service-invoice line it settled back to PENDING_STOCK. See
 *          service/partsBatchDelete.service.ts for what each step undoes.
 * @route   DELETE /api/parts/batches/:batchId
 * @access  Super-Admin (any branch), Part-Admin (own branch)
 */
export const deletePartsBatch = asyncHandler(
  async (req: Request, res: Response) => {
    const { batchId } = req.params;

    const batch = await PartsReportBatchModel.findOne({
      batchId,
      isActive: true,
    });
    if (!batch) {
      res.status(404);
      throw new Error("Parts batch not found");
    }

    if (req.user && !isAdmin(req.user)) {
      const ownBranch = getUserBranch(req.user);
      if (!ownBranch || ownBranch !== batch.branchId.toString()) {
        res.status(403);
        throw new Error("Not authorized to delete this branch's import batch");
      }
    }

    // A parts upload is a diff against the snapshot the previous one left
    // behind, so the batches form a chain. Reversing a middle link would leave
    // every later batch diffed against a state that no longer exists — the
    // stock counts after it would be silently wrong, with nothing to flag it.
    // Only the newest batch can be undone; to unwind further, delete
    // repeatedly from the top.
    const newest = await PartsReportBatchModel.findOne({
      branchId: batch.branchId,
      isActive: true,
    })
      .sort({ createdAt: -1 })
      .select("batchId");

    if (newest && newest.batchId !== batchId) {
      res.status(409);
      throw new Error(
        "Only the most recent parts upload can be deleted — later uploads were compared against this one. Delete them first, newest first.",
      );
    }

    // Rows superseded before `supersededByBatch` existed can't be identified,
    // so restoring the previous snapshot would be guesswork. Refuse rather
    // than half-restore: the batch's own rows would vanish and the parts it
    // changed or removed would be left with no current row at all.
    const supersededTracked = await PartsReportModel.countDocuments({
      supersededByBatch: batchId,
    });
    const shouldHaveSuperseded = batch.changedRows + batch.removedRows;
    if (shouldHaveSuperseded > 0 && supersededTracked === 0) {
      res.status(409);
      throw new Error(
        "This upload predates delete support and cannot be reversed safely — the rows it replaced are no longer identifiable.",
      );
    }

    const result = await reversePartsBatch(
      batchId,
      batch.branchId,
      req.user!._id as any,
      getUserRole(req.user!),
    );

    res.status(200).json({
      success: true,
      message: `Parts batch ${batchId} deleted — ${result.rowsRemoved} row(s) removed, ${result.rowsRestored} restored`,
      data: result,
    });
  },
);
