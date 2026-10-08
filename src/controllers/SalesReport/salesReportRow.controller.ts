import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import mongoose from "mongoose";
import { SalesReportModel } from "../../models/SalesReport";
import { normalizePhone } from "../../service/salesReport.service";
import { getUserBranch, getUserRole, isAdmin } from "../../types/user.types";

/**
 * Load an active row by id and enforce branch scoping (Super-Admin: any
 * branch; Branch-Admin: own branch only). Sets the response status before
 * throwing so asyncHandler's error middleware reports the right code.
 */
async function loadScopedRow(req: Request, res: Response) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid sales report id");
  }
  const row = await SalesReportModel.findOne({ _id: id, isActive: true });
  if (!row) {
    res.status(404);
    throw new Error("Sales report record not found");
  }
  if (req.user && !isAdmin(req.user)) {
    const ownBranch = getUserBranch(req.user);
    if (!ownBranch || ownBranch.toString() !== row.branchId.toString()) {
      res.status(403);
      throw new Error("Not authorized to modify this branch's record");
    }
  }
  return row;
}

const str = (v: unknown) => String(v ?? "").trim();

/**
 * @desc    Edit one sales report row. Frame No is the dedup key and the key
 *          the stock/customer-vehicle match was made on, so it is NOT
 *          editable — delete the row and re-import to change it. Like batch
 *          delete, an edit only changes the report row; it does not re-run the
 *          stock match or rewrite the linked customer / vehicle.
 * @route   PATCH /api/sales-report/:id
 * @access  Super-Admin (any), Branch-Admin (own branch)
 */
export const updateSalesReportRow = asyncHandler(
  async (req: Request, res: Response) => {
    const row = await loadScopedRow(req, res);
    const body = req.body ?? {};

    // Date is mandatory — it must be present and valid on every edit.
    const saleDate = new Date(body.saleDate);
    if (!body.saleDate || Number.isNaN(saleDate.getTime())) {
      res.status(400);
      throw new Error('"Date" is required and must be a valid date');
    }
    row.saleDate = saleDate;

    if (body.modelName !== undefined) row.modelName = str(body.modelName);
    if (body.customerFirstName !== undefined)
      row.customerFirstName = str(body.customerFirstName);
    if (body.customerLastName !== undefined)
      row.customerLastName = str(body.customerLastName);
    if (body.location !== undefined) row.location = str(body.location);
    if (body.purchaseType !== undefined)
      row.purchaseType = str(body.purchaseType);
    if (body.engineNo !== undefined)
      row.engineNo = str(body.engineNo).toUpperCase();

    if (body.customerMobile !== undefined) {
      const raw = str(body.customerMobile);
      const phone = raw ? normalizePhone(raw) : "";
      if (raw && !phone) {
        res.status(400);
        throw new Error("Contact Mobile must be a valid 10-digit number");
      }
      row.customerMobile = phone ?? "";
    }

    if (body.totalPayment !== undefined && body.totalPayment !== "") {
      const n = Number(body.totalPayment);
      if (!Number.isFinite(n) || n < 0) {
        res.status(400);
        throw new Error("Total Payment must be a non-negative number");
      }
      row.totalPayment = n;
    }

    await row.save();

    res.status(200).json({
      success: true,
      message: "Sales report record updated",
      data: row,
    });
  },
);

/**
 * @desc    Soft delete a single sales report row, audited like the batch
 *          delete (and, like it, without reverting matched stock/customer
 *          records). Frees the Frame No for re-import.
 * @route   DELETE /api/sales-report/:id
 * @access  Super-Admin (any), Branch-Admin (own branch)
 */
export const deleteSalesReportRow = asyncHandler(
  async (req: Request, res: Response) => {
    const row = await loadScopedRow(req, res);

    row.isActive = false;
    row.deletedBy = req.user!._id as unknown as mongoose.Types.ObjectId;
    row.deletedByRole = getUserRole(req.user!);
    row.deletedAt = new Date();
    await row.save();

    res.status(200).json({
      success: true,
      message: "Sales report record deleted",
    });
  },
);
