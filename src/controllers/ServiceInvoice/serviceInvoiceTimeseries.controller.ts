import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import mongoose from "mongoose";
import { ServiceInvoiceModel } from "../../models/ServiceInvoice/ServiceInvoice";
import BranchModel from "../../models/Branch";
import { branchFilter } from "./serviceInvoiceStats.controller";

/**
 * Service revenue timeseries.
 *
 * Ported from the retired controllers/ServiceJobcard/serviceJobcardSalesTimeseries.controller.ts
 * and kept to the SAME output shape, because the RAG structured-query path
 * (service/rag/rag.service.ts) narrates these fields directly. The only change
 * is the source: invoices instead of imported XLSX job-card rows, so the
 * revenue splits now come from `derivedRevenue` (computed from the invoice's
 * own line items) rather than from pre-summed export columns.
 */
export type Granularity = "day" | "week" | "month" | "year";
const GRANULARITIES: Granularity[] = ["day", "week", "month", "year"];

const DATE_FIELD = "$jobCardClosedDate";

function bucketIdExpr(granularity: Granularity) {
  switch (granularity) {
    case "day":
      return {
        y: { $year: DATE_FIELD },
        m: { $month: DATE_FIELD },
        d: { $dayOfMonth: DATE_FIELD },
      };
    case "week":
      return { y: { $isoWeekYear: DATE_FIELD }, w: { $isoWeek: DATE_FIELD } };
    case "month":
      return { y: { $year: DATE_FIELD }, m: { $month: DATE_FIELD } };
    case "year":
    default:
      return { y: { $year: DATE_FIELD } };
  }
}

function formatBucketLabel(
  granularity: Granularity,
  id: { y: number; m?: number; d?: number; w?: number },
  bucketStart: Date,
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (granularity) {
    case "day":
      return bucketStart.toISOString().slice(0, 10);
    case "week":
      return `${id.y}-W${pad(id.w ?? 0)}`;
    case "month":
      return `${id.y}-${pad(id.m ?? 0)}`;
    case "year":
    default:
      return `${id.y}`;
  }
}

/**
 * Core aggregation, callable directly by the RAG structured path without
 * going through Express.
 *
 * `jobCardCount` keeps its name (rather than becoming `invoiceCount`) so the
 * RAG prompt templates and any consumer of this shape keep working — one
 * invoice is one closed job card, so the meaning is unchanged.
 */
export async function computeServiceInvoiceTimeseries(
  branch: mongoose.Types.ObjectId | "all",
  opts: { granularity: Granularity; from?: string; to?: string },
) {
  const { granularity, from, to } = opts;

  const match: Record<string, any> = {
    isActive: true,
    jobCardClosedDate: { $ne: null, $exists: true },
  };
  if (branch !== "all") match.branchId = branch;
  if (from) match.jobCardClosedDate.$gte = new Date(from);
  if (to) match.jobCardClosedDate.$lte = new Date(to);

  const groupRevenue = {
    totalRevenue: { $sum: "$totalInvoiceAmount" },
    labourRevenue: { $sum: "$derivedRevenue.labourRevenue" },
    partsRevenue: { $sum: "$derivedRevenue.partsRevenue" },
    lubesRevenue: { $sum: "$derivedRevenue.lubesRevenue" },
    accessoriesRevenue: { $sum: "$derivedRevenue.accessoriesRevenue" },
    jobCardCount: { $sum: 1 },
  };

  const [timeseriesRaw, byModelRaw, byBranchRaw, byTechnicianRaw] =
    await Promise.all([
      ServiceInvoiceModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: bucketIdExpr(granularity),
            bucketStart: { $min: "$jobCardClosedDate" },
            ...groupRevenue,
          },
        },
        { $sort: { "_id.y": 1, "_id.m": 1, "_id.w": 1, "_id.d": 1 } },
      ]),
      ServiceInvoiceModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$modelName",
            totalRevenue: { $sum: "$totalInvoiceAmount" },
            jobCardCount: { $sum: 1 },
          },
        },
        { $sort: { totalRevenue: -1 } },
        { $limit: 20 },
      ]),
      ServiceInvoiceModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$branchId",
            totalRevenue: { $sum: "$totalInvoiceAmount" },
            jobCardCount: { $sum: 1 },
          },
        },
        { $sort: { totalRevenue: -1 } },
      ]),
      ServiceInvoiceModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$technicianName",
            totalRevenue: { $sum: "$totalInvoiceAmount" },
            jobCardCount: { $sum: 1 },
          },
        },
        { $sort: { totalRevenue: -1 } },
        { $limit: 20 },
      ]),
    ]);

  const timeseries = timeseriesRaw.map((r: any) => ({
    bucket: formatBucketLabel(granularity, r._id, r.bucketStart),
    bucketStart: r.bucketStart,
    totalRevenue: r.totalRevenue ?? 0,
    labourRevenue: r.labourRevenue ?? 0,
    partsRevenue: r.partsRevenue ?? 0,
    lubesRevenue: r.lubesRevenue ?? 0,
    accessoriesRevenue: r.accessoriesRevenue ?? 0,
    jobCardCount: r.jobCardCount ?? 0,
  }));

  const byModel = byModelRaw.map((r: any) => ({
    modelName: r._id ?? "Unknown",
    totalRevenue: r.totalRevenue ?? 0,
    jobCardCount: r.jobCardCount ?? 0,
  }));

  const byTechnician = byTechnicianRaw.map((r: any) => ({
    technicianName: r._id ?? "Unknown",
    totalRevenue: r.totalRevenue ?? 0,
    jobCardCount: r.jobCardCount ?? 0,
  }));

  const branchIds = byBranchRaw.map((r: any) => r._id).filter(Boolean);
  const branches = await BranchModel.find({ _id: { $in: branchIds } }).select(
    "branchName",
  );
  const branchNameById = new Map(
    branches.map((b) => [String(b._id), b.branchName]),
  );
  const byBranch = byBranchRaw.map((r: any) => ({
    branchId: r._id,
    branchName: r._id
      ? branchNameById.get(r._id.toString()) ?? "Unknown"
      : "Unknown",
    totalRevenue: r.totalRevenue ?? 0,
    jobCardCount: r.jobCardCount ?? 0,
  }));

  return {
    granularity,
    from: from ?? null,
    to: to ?? null,
    timeseries,
    byModel,
    byBranch,
    byTechnician,
  };
}

/**
 * @desc    Service revenue timeseries bucketed by day/week/month/year, plus
 *          model / branch / technician breakdowns.
 * @route   GET /api/service-invoice/sales/timeseries?granularity=&from=&to=&branchId=
 */
export const getServiceInvoiceTimeseries = asyncHandler(
  async (req: Request, res: Response) => {
    const branch = branchFilter(req);
    if (branch === null) {
      res.status(400);
      throw new Error("Branch could not be resolved");
    }

    const granularityParam = (req.query.granularity as string) || "day";
    if (!GRANULARITIES.includes(granularityParam as Granularity)) {
      res.status(400);
      throw new Error("granularity must be one of day, week, month, year");
    }

    const data = await computeServiceInvoiceTimeseries(branch, {
      granularity: granularityParam as Granularity,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });

    res.status(200).json({ success: true, data });
  },
);
