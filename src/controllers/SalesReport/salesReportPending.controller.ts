import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import mongoose from "mongoose";
import { SalesReportPendingModel } from "../../models/SalesReportPending";
import {
  extractCuratedFields,
  isMissingAmounts,
} from "../../service/salesReport.service";
import { matchSalesReportColumns } from "../../utils/salesReportColumnMatcher";
import { createSalesReportRecord } from "../../service/salesReport/createSalesReportRecord.service";
import { getUserBranch, isAdmin } from "../../types/user.types";

/** Own-branch scope; Super-Admin sees every branch. */
function branchFilter(req: Request): Record<string, any> {
  if (req.user && isAdmin(req.user)) return {};
  const branch = req.user ? getUserBranch(req.user) : null;
  return { branchId: branch ?? null };
}

async function loadPending(req: Request, res: Response) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid pending record id");
  }
  const row = await SalesReportPendingModel.findOne({ _id: id, ...branchFilter(req) });
  if (!row) {
    res.status(404);
    throw new Error("Pending record not found");
  }
  return row;
}

/** A blank cell is "not entered"; anything else must be a non-negative number. */
function parseAmount(
  res: Response,
  label: string,
  raw: unknown,
): number | null | undefined {
  if (raw === undefined) return undefined; // not part of this edit
  if (raw === null || raw === "") return null; // cleared
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    res.status(400);
    throw new Error(`${label} must be a non-negative number`);
  }
  return n;
}

/**
 * @desc    Rows waiting on EX SHOWROOM / INSURANCE / REGISTRATION.
 * @route   GET /api/sales-report/pending?batchId=
 * @access  Branch-Admin (own branch)
 */
export const getPendingSalesReports = asyncHandler(
  async (req: Request, res: Response) => {
    const filter: Record<string, any> = { ...branchFilter(req) };
    if (req.query.batchId) filter.importBatch = String(req.query.batchId);
    const data = await SalesReportPendingModel.find(filter)
      .sort({ importDate: 1, _id: 1 })
      .lean();
    res.status(200).json({ success: true, data });
  },
);

/**
 * @desc    Enter the three amounts on a pending row. Values are saved as
 *          typed; once all three are present the row is imported for real
 *          (customer added, stock matched) and removed from pending.
 * @route   PATCH /api/sales-report/pending/:id
 * @access  Branch-Admin (own branch)
 */
export const updatePendingSalesReport = asyncHandler(
  async (req: Request, res: Response) => {
    const row = await loadPending(req, res);
    const body = req.body ?? {};

    const next = {
      exShowroom: parseAmount(res, "EX SHOWROOM", body.exShowroom),
      insuranceAmount: parseAmount(res, "INSURANCE", body.insurance),
      registrationAmount: parseAmount(res, "REGISTRATION", body.registration),
    };
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) continue;
      (row as any)[key] = value === null ? undefined : value;
    }

    if (isMissingAmounts(row)) {
      await row.save();
      res.status(200).json({
        success: true,
        completed: false,
        message: "Saved — still missing an amount",
        data: row,
      });
      return;
    }

    // Re-derive the curated fields from the stored source row so completing
    // writes exactly what the import would have.
    const matchResult = matchSalesReportColumns(row.detectedColumns);
    const curated = extractCuratedFields(row.rowData, matchResult);

    let created;
    try {
      created = await createSalesReportRecord({
        curated,
        exShowroom: row.exShowroom!,
        insuranceAmount: row.insuranceAmount!,
        registrationAmount: row.registrationAmount!,
        rowData: row.rowData,
        detectedColumns: row.detectedColumns,
        sourceFormat: row.sourceFormat,
        importBatch: row.importBatch,
        importDate: row.importDate,
        fileName: row.fileName,
        branchId: row.branchId.toString(),
        uploadedBy: row.uploadedBy,
      });
    } catch (error) {
      // Keep the typed amounts so the user doesn't re-enter them.
      await row.save();
      res.status(409);
      throw error;
    }
    await row.deleteOne();

    res.status(200).json({
      success: true,
      completed: true,
      message: created.outcome.customerCreated
        ? "Record added and customer created"
        : "Record added",
      data: { saleReportId: created.saleReportId, outcome: created.outcome.outcome },
    });
  },
);

/**
 * @desc    Discard a pending row without importing it.
 * @route   DELETE /api/sales-report/pending/:id
 * @access  Branch-Admin (own branch)
 */
export const deletePendingSalesReport = asyncHandler(
  async (req: Request, res: Response) => {
    const row = await loadPending(req, res);
    await row.deleteOne();
    res.status(200).json({ success: true, message: "Pending record discarded" });
  },
);
