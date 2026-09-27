import { Request, Response } from "express";
import mongoose from "mongoose";
import { isAdmin, getUserBranch } from "../../types/user.types";
import logger from "../../utils/logger";
import { ServiceInvoiceModel } from "../../models/ServiceInvoice/ServiceInvoice";
import { ServiceInvoiceLineItemModel } from "../../models/ServiceInvoice/ServiceInvoiceLineItem";
import { getEffectiveStock } from "../../service/serviceInvoice/effectiveStock.service";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * - Super-Admin: all branches, or the one passed via `?branchId=`.
 * - Branch-scoped roles: forced to their own branch.
 * Returns `null` when a branch is required but missing.
 *
 * Mirrors branchFilter in controllers/Parts/partsStats.controller.ts.
 */
export function branchFilter(
  req: Request,
): mongoose.Types.ObjectId | null | "all" {
  if (req.user && isAdmin(req.user)) {
    const q = req.query.branchId as string | undefined;
    if (!q) return "all";
    if (!mongoose.Types.ObjectId.isValid(q)) return null;
    return new mongoose.Types.ObjectId(q);
  }
  const branch = req.user ? getUserBranch(req.user) : null;
  if (!branch || !mongoose.Types.ObjectId.isValid(branch)) return null;
  return new mongoose.Types.ObjectId(branch);
}

function scopeMatch(
  branch: mongoose.Types.ObjectId | "all",
): Record<string, any> {
  const m: Record<string, any> = { isActive: true };
  if (branch !== "all") m.branchId = branch;
  return m;
}

export interface ServiceInvoiceStats {
  year: number;
  monthly: Array<{
    month: string;
    invoiceCount: number;
    partsRevenue: number;
    labourRevenue: number;
    accessoriesRevenue: number;
    totalRevenue: number;
  }>;
  totals: {
    totalInvoices: number;
    totalRevenue: number;
    partsRevenue: number;
    lubesRevenue: number;
    accessoriesRevenue: number;
    /** Value of billed parts still awaiting a parts-stock upload. */
    pendingRevenue: number;
    labourRevenue: number;
    needsReview: number;
    partsSold: number;
    /** Billed parts still awaiting a parts-stock upload. */
    partsPendingStock: number;
    accessoriesFitted: number;
  };
  byTechnician: Array<{ technician: string; invoices: number; revenue: number }>;
  byModel: Array<{ model: string; invoices: number; revenue: number }>;
}

/**
 * Core service-invoice aggregation, factored out of the HTTP controller so the
 * RAG structured path can call it directly — same arrangement as
 * computePartsStats.
 */
export async function computeServiceInvoiceStats(
  branch: mongoose.Types.ObjectId | "all",
  year: number,
): Promise<ServiceInvoiceStats> {
  const base = scopeMatch(branch);
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1));

  const [monthlyRaw, totalsRaw, lineTotals, byTechnician, byModel] =
    await Promise.all([
      ServiceInvoiceModel.aggregate([
        {
          $match: {
            ...base,
            jobCardClosedDate: { $gte: yearStart, $lt: yearEnd },
          },
        },
        {
          $group: {
            _id: { $month: "$jobCardClosedDate" },
            invoiceCount: { $sum: 1 },
            partsRevenue: { $sum: "$derivedRevenue.partsRevenue" },
            lubesRevenue: { $sum: "$derivedRevenue.lubesRevenue" },
            labourRevenue: { $sum: "$derivedRevenue.labourRevenue" },
            accessoriesRevenue: { $sum: "$derivedRevenue.accessoriesRevenue" },
            totalRevenue: { $sum: "$totalInvoiceAmount" },
          },
        },
      ]),

      ServiceInvoiceModel.aggregate([
        { $match: base },
        {
          $group: {
            _id: null,
            totalInvoices: { $sum: 1 },
            totalRevenue: { $sum: "$totalInvoiceAmount" },
            partsRevenue: { $sum: "$derivedRevenue.partsRevenue" },
            lubesRevenue: { $sum: "$derivedRevenue.lubesRevenue" },
            accessoriesRevenue: { $sum: "$derivedRevenue.accessoriesRevenue" },
            pendingRevenue: { $sum: "$derivedRevenue.pendingRevenue" },
            labourRevenue: { $sum: "$derivedRevenue.labourRevenue" },
            needsReview: { $sum: { $cond: ["$needsReview", 1, 0] } },
          },
        },
      ]),

      ServiceInvoiceLineItemModel.aggregate([
        { $match: base },
        { $group: { _id: "$classification", n: { $sum: 1 } } },
      ]),

      ServiceInvoiceModel.aggregate([
        { $match: { ...base, technicianName: { $nin: [null, ""] } } },
        {
          $group: {
            _id: "$technicianName",
            invoices: { $sum: 1 },
            revenue: { $sum: "$totalInvoiceAmount" },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 15 },
      ]),

      ServiceInvoiceModel.aggregate([
        { $match: { ...base, modelName: { $nin: [null, ""] } } },
        {
          $group: {
            _id: "$modelName",
            invoices: { $sum: 1 },
            revenue: { $sum: "$totalInvoiceAmount" },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 15 },
      ]),
    ]);

  const monthlyByIndex = new Map(monthlyRaw.map((m: any) => [m._id, m]));
  const monthly = MONTHS.map((label, idx) => {
    const m: any = monthlyByIndex.get(idx + 1);
    return {
      month: label,
      invoiceCount: m?.invoiceCount ?? 0,
      partsRevenue: (m?.partsRevenue ?? 0) + (m?.lubesRevenue ?? 0),
      labourRevenue: m?.labourRevenue ?? 0,
      accessoriesRevenue: m?.accessoriesRevenue ?? 0,
      totalRevenue: m?.totalRevenue ?? 0,
    };
  });

  const t: any = totalsRaw[0] || {};
  const lineCount = (key: string): number =>
    (lineTotals.find((l: any) => l._id === key) as any)?.n ?? 0;

  return {
    year,
    monthly,
    totals: {
      totalInvoices: t.totalInvoices ?? 0,
      totalRevenue: t.totalRevenue ?? 0,
      partsRevenue: t.partsRevenue ?? 0,
      lubesRevenue: t.lubesRevenue ?? 0,
      accessoriesRevenue: t.accessoriesRevenue ?? 0,
      pendingRevenue: t.pendingRevenue ?? 0,
      labourRevenue: t.labourRevenue ?? 0,
      needsReview: t.needsReview ?? 0,
      partsSold: lineCount("SOLD"),
      partsPendingStock: lineCount("PENDING_STOCK"),
      accessoriesFitted: lineCount("ACCESSORY"),
    },
    byTechnician: byTechnician.map((b: any) => ({
      technician: b._id,
      invoices: b.invoices,
      revenue: b.revenue,
    })),
    byModel: byModel.map((b: any) => ({
      model: b._id,
      invoices: b.invoices,
      revenue: b.revenue,
    })),
  };
}

function requireBranch(
  req: Request,
  res: Response,
): mongoose.Types.ObjectId | "all" | undefined {
  const branch = branchFilter(req);
  if (branch === null) {
    res.status(400).json({ success: false, message: "A valid branch is required" });
    return undefined;
  }
  return branch;
}

/**
 * @desc    KPI stats for the service-invoice dashboards
 * @route   GET /api/service-invoice/stats?year=&branchId=
 */
export async function getServiceInvoiceStats(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const branch = requireBranch(req, res);
    if (branch === undefined) return;
    const year = Number(req.query.year) || new Date().getFullYear();
    const data = await computeServiceInvoiceStats(branch, year);
    res.status(200).json({ success: true, data });
  } catch (err: any) {
    logger.error(`getServiceInvoiceStats failed: ${err?.message}`);
    res.status(500).json({ success: false, message: "Failed to load stats" });
  }
}

/**
 * @desc    Paginated invoice list
 * @route   GET /api/service-invoice?page=&limit=&needsReview=&q=&branchId=
 */
export async function getAllServiceInvoices(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const branch = requireBranch(req, res);
    if (branch === undefined) return;

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const filter: Record<string, any> = scopeMatch(branch);
    if (req.query.needsReview === "true") filter.needsReview = true;
    const q = (req.query.q as string | undefined)?.trim();
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { invoiceNumber: rx },
        { jobCardNumber: rx },
        { frameNumber: rx },
        { registrationNumber: rx },
        { customerName: rx },
        { customerMobile: rx },
        { technicianName: rx },
      ];
    }

    const [rows, total] = await Promise.all([
      ServiceInvoiceModel.find(filter, { rawText: 0 })
        .populate("branchId", "branchName")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ServiceInvoiceModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: { rows, total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err: any) {
    logger.error(`getAllServiceInvoices failed: ${err?.message}`);
    res.status(500).json({ success: false, message: "Failed to load invoices" });
  }
}

/**
 * @desc    Line items, optionally filtered to one invoice or classification.
 * @route   GET /api/service-invoice/line-items?invoiceId=&classification=&branchId=
 */
export async function getServiceInvoiceLineItems(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const branch = requireBranch(req, res);
    if (branch === undefined) return;

    const filter: Record<string, any> = scopeMatch(branch);
    const invoiceId = req.query.invoiceId as string | undefined;
    if (invoiceId) {
      if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
        res.status(400).json({ success: false, message: "Invalid invoiceId" });
        return;
      }
      filter.invoiceId = new mongoose.Types.ObjectId(invoiceId);
    }
    const classification = req.query.classification as string | undefined;
    if (classification) filter.classification = classification;

    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const rows = await ServiceInvoiceLineItemModel.find(filter)
      .sort({ invoiceId: -1, srNo: 1 })
      .limit(limit)
      .lean();

    res.status(200).json({ success: true, data: { rows, count: rows.length } });
  } catch (err: any) {
    logger.error(`getServiceInvoiceLineItems failed: ${err?.message}`);
    res.status(500).json({ success: false, message: "Failed to load line items" });
  }
}

/**
 * @desc    On-hand stock net of service consumption.
 * @route   GET /api/service-invoice/effective-stock?branchId=&partNumber=
 */
export async function getEffectiveStockStatus(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const branch = branchFilter(req);
    if (branch === null || branch === "all") {
      // Effective stock is inherently per-branch: stock rows and consumption
      // are both branch-scoped, so an "all branches" view would sum unrelated
      // inventories. Super-Admin must pick one.
      res.status(400).json({
        success: false,
        message: "Effective stock is per-branch — supply ?branchId=",
      });
      return;
    }

    const data = await getEffectiveStock(String(branch), {
      partNumber: req.query.partNumber as string | undefined,
    });
    res.status(200).json({ success: true, data });
  } catch (err: any) {
    logger.error(`getEffectiveStockStatus failed: ${err?.message}`);
    res
      .status(500)
      .json({ success: false, message: "Failed to compute effective stock" });
  }
}

/**
 * @desc    One invoice with its line items.
 * @route   GET /api/service-invoice/:id
 */
export async function getServiceInvoiceById(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const branch = requireBranch(req, res);
    if (branch === undefined) return;

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, message: "Invalid invoice id" });
      return;
    }

    const filter: Record<string, any> = { _id: id, isActive: true };
    if (branch !== "all") filter.branchId = branch;

    const invoice = await ServiceInvoiceModel.findOne(filter)
      .populate("branchId", "branchName")
      .lean();
    if (!invoice) {
      res.status(404).json({ success: false, message: "Service invoice not found" });
      return;
    }

    const lineItems = await ServiceInvoiceLineItemModel.find({
      invoiceId: invoice._id,
    })
      .sort({ srNo: 1 })
      .lean();

    res.status(200).json({ success: true, data: { invoice, lineItems } });
  } catch (err: any) {
    logger.error(`getServiceInvoiceById failed: ${err?.message}`);
    res.status(500).json({ success: false, message: "Failed to load invoice" });
  }
}
