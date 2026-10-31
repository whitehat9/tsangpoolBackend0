import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { SalesReportModel } from "../../models/SalesReport";
import { reverseSalesReportRows } from "../../service/salesReport/reverseSalesReportBatch.service";
import { getUserBranch, getUserRole, isAdmin } from "../../types/user.types";

/**
 * @desc    Soft delete a sales report batch (all its rows), audited, and undo
 *          what the import did elsewhere: stock flipped to Sold goes back,
 *          the CustomerVehicle and BaseCustomer it created are removed. Each
 *          is skipped (and reported in `kept`) if it has been used since the
 *          sale — see service/salesReport/reverseSalesReportBatch.service.ts.
 * @route   DELETE /api/sales-report/batches/:batchId
 * @access  Super-Admin (any), Branch-Admin (own branch)
 */
export const deleteSalesReportBatch = asyncHandler(
  async (req: Request, res: Response) => {
    const { batchId } = req.params;

    const sample = await SalesReportModel.findOne({
      importBatch: batchId,
      isActive: true,
    });
    if (!sample) {
      res.status(404);
      throw new Error("Sales report batch not found");
    }

    if (req.user && !isAdmin(req.user)) {
      const ownBranch = getUserBranch(req.user);
      if (!ownBranch || ownBranch !== sample.branchId.toString()) {
        res.status(403);
        throw new Error("Not authorized to delete this branch's import batch");
      }
    }

    const rows = await SalesReportModel.find({
      importBatch: batchId,
      isActive: true,
    });
    const reversed = await reverseSalesReportRows(rows);

    await SalesReportModel.updateMany(
      { importBatch: batchId, isActive: true },
      {
        isActive: false,
        deletedBy: req.user!._id,
        deletedByRole: getUserRole(req.user!),
        deletedAt: new Date(),
      },
    );

    res.status(200).json({
      success: true,
      message: `Sales report batch ${batchId} deleted`,
      data: reversed,
    });
  },
);

/**
 * @desc    List soft-deleted sales report batches, with delete audit info.
 * @route   GET /api/sales-report/deleted-batches
 * @access  Super-Admin only
 */
export const getDeletedSalesReportBatches = asyncHandler(
  async (req: Request, res: Response) => {
    const batches = await SalesReportModel.aggregate([
      { $match: { isActive: false } },
      {
        $group: {
          _id: "$importBatch",
          fileName: { $first: "$fileName" },
          importDate: { $first: "$importDate" },
          branchId: { $first: "$branchId" },
          uploadedBy: { $first: "$uploadedBy" },
          totalRecords: { $sum: 1 },
          totalPayment: { $sum: { $ifNull: ["$totalPayment", 0] } },
          deletedBy: { $first: "$deletedBy" },
          deletedByRole: { $first: "$deletedByRole" },
          deletedAt: { $first: "$deletedAt" },
        },
      },
      { $sort: { deletedAt: -1 } },
      { $limit: 50 },
    ]);

    res.status(200).json({
      success: true,
      data: batches.map((b) => ({
        batchId: b._id,
        fileName: b.fileName,
        importDate: b.importDate,
        branchId: b.branchId,
        totalRecords: b.totalRecords,
        totalPayment: b.totalPayment,
        deletedBy: b.deletedBy,
        deletedByRole: b.deletedByRole,
        deletedAt: b.deletedAt,
      })),
    });
  },
);
