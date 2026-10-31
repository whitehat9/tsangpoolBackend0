import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { StockConceptCSVModel } from "../../models/BikeSystemModel3/StockConceptCSV";
import { StockConceptModel } from "../../models/BikeSystemModel2/StockConcept";
import { getUserBranch, isBranchManager } from "../../types/user.types";

const MAX_PER_SOURCE = 25;

/**
 * @desc    Global stock lookup by Engine or Chassis (Frame) number across BOTH
 *          stock sources — Daily Stock CSV imports and Manual stock entries.
 *          Contains-match, case-insensitive, 3+ chars; Branch-Admin is scoped
 *          to their own branch, Super-Admin may narrow with ?branchId=.
 * @route   GET /api/csv-stock/search?q=
 * @access  Super-Admin, Branch-Admin
 */
export const searchStock = asyncHandler(async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 3) {
    res.status(400);
    throw new Error("Search needs at least 3 characters");
  }
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  const branch =
    req.user && isBranchManager(req.user)
      ? getUserBranch(req.user)
      : (req.query.branchId as string) || undefined;
  const branchMatch = branch ? { "stockStatus.branchId": branch } : {};

  const [csv, manual] = await Promise.all([
    StockConceptCSVModel.find({
      isActive: { $ne: false },
      $or: [{ engineNumber: rx }, { frameNumber: rx }],
      ...branchMatch,
    })
      .populate("stockStatus.branchId", "branchName")
      .limit(MAX_PER_SOURCE)
      .lean(),
    StockConceptModel.find({
      isActive: true,
      $or: [{ engineNumber: rx }, { chassisNumber: rx }],
      ...branchMatch,
    })
      .populate("stockStatus.branchId", "branchName")
      .limit(MAX_PER_SOURCE)
      .lean(),
  ]);

  const branchName = (s: any) => s.stockStatus?.branchId?.branchName ?? "";
  const data = [
    ...csv.map((s: any) => ({
      source: "csv" as const,
      id: String(s._id),
      engineNumber: s.engineNumber,
      chassisNumber: s.frameNumber,
      model: s.modelVariant,
      colour: s.color,
      status: s.stockStatus?.status,
      location: s.stockStatus?.location,
      branchName: branchName(s),
      reference: s.csvImportBatch,
    })),
    ...manual.map((s: any) => ({
      source: "manual" as const,
      id: String(s._id),
      engineNumber: s.engineNumber,
      chassisNumber: s.chassisNumber,
      model: s.modelName,
      colour: s.color,
      status: s.stockStatus?.status,
      location: s.stockStatus?.location,
      branchName: branchName(s),
      reference: s.stockId,
    })),
  ];

  res.status(200).json({ success: true, data });
});
