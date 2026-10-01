import mongoose from "mongoose";
import { ROLES, UserRole } from "../../types/user.types";
import { BranchScope } from "./scope";
import { PartsReportModel } from "../../models/PartsReport";
import { ServiceInvoiceModel } from "../../models/ServiceInvoice/ServiceInvoice";
import { JobCardModel } from "../../models/ServiceM/JobCard";
import { StockConceptModel } from "../../models/BikeSystemModel2/StockConcept";
import { CustomerVehicleModel } from "../../models/BikeSystemModel2/CustomerVehicleModel";
import AccidentReportModel from "../../models/AdminFeatures/AccidentReport";
import BranchModel from "../../models/Branch";

/**
 * The KPI metric registry.
 *
 * This is the whitelist that makes prompt-driven dashboards safe. The LLM
 * never writes an aggregation pipeline and never produces a number — it only
 * picks a metric `id` from this catalogue and a date range (see kpiPlanner.ts).
 * Every figure the Super-Admin sees is computed here, by Mongo, from the same
 * collections and the same branch-scoping rule the dashboards use.
 *
 * Adding a KPI means adding one entry below. Nothing in kpiPlanner.ts or the
 * frontend changes — the planner reads its catalogue from this registry and
 * the UI renders whatever tiles come back.
 */

export type MetricDimension = "month" | "branch" | "status";
export type MetricUnit = "count" | "currency";

export interface MetricParams {
  from: Date;
  to: Date;
}

export interface SeriesPoint {
  label: string;
  value: number;
}

export interface MetricDefinition {
  id: string;
  label: string;
  /** Shown to the planner LLM so it can match a natural-language ask to this metric. */
  description: string;
  unit: MetricUnit;
  allowedRoles: UserRole[];
  /** Which groupings this metric can legally be broken down by. */
  dimensions: MetricDimension[];
  /** Single scalar over the window — what a KPI tile shows. */
  compute(scope: BranchScope, params: MetricParams): Promise<number>;
  /** Broken down by one dimension — what a chart shows. */
  series(
    scope: BranchScope,
    params: MetricParams,
    groupBy: MetricDimension,
  ): Promise<SeriesPoint[]>;
}

const registry = new Map<string, MetricDefinition>();

export function registerMetric(metric: MetricDefinition): void {
  if (registry.has(metric.id)) {
    throw new Error(`KPI metric "${metric.id}" is already registered`);
  }
  registry.set(metric.id, metric);
}

export function getMetric(id: string): MetricDefinition | undefined {
  return registry.get(id);
}

export function listMetrics(): MetricDefinition[] {
  return Array.from(registry.values());
}

export function metricsForRole(role: UserRole): MetricDefinition[] {
  return listMetrics().filter((m) => m.allowedRoles.includes(role));
}

// ─── Shared aggregation builder ───────────────────────────────────────────────

interface SimpleMetricConfig {
  id: string;
  label: string;
  description: string;
  unit: MetricUnit;
  allowedRoles: UserRole[];
  dimensions: MetricDimension[];
  model: mongoose.Model<any>;
  /** Dotted path to the branch ObjectId on this model. */
  branchField: string;
  /** Dotted path to the date this metric is windowed by. */
  dateField: string;
  /** Dotted path summed for the value. Omit to count documents instead. */
  valueField?: string;
  /** Dotted path used when grouping by "status". */
  statusField?: string;
  /** Always-applied match (e.g. soft-delete flags). */
  baseMatch?: Record<string, any>;
  /**
   * Stages prepended before any $match — for models where the rows being
   * measured are array elements, or where branch lives on a referenced doc
   * (CustomerVehicle, which must $lookup StockConcept to reach a branch).
   */
  prePipeline?: any[];
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function simpleMetric(cfg: SimpleMetricConfig): MetricDefinition {
  const valueExpr = cfg.valueField
    ? { $sum: { $ifNull: [`$${cfg.valueField}`, 0] } }
    : { $sum: 1 };

  const matchFor = (scope: BranchScope, params: MetricParams) => {
    const match: Record<string, any> = { ...(cfg.baseMatch ?? {}) };
    if (scope !== "all") match[cfg.branchField] = scope;
    match[cfg.dateField] = { $gte: params.from, $lte: params.to };
    return match;
  };

  return {
    id: cfg.id,
    label: cfg.label,
    description: cfg.description,
    unit: cfg.unit,
    allowedRoles: cfg.allowedRoles,
    dimensions: cfg.dimensions,

    async compute(scope, params) {
      const rows = await cfg.model.aggregate([
        ...(cfg.prePipeline ?? []),
        { $match: matchFor(scope, params) },
        { $group: { _id: null, value: valueExpr } },
      ]);
      return rows[0]?.value ?? 0;
    },

    async series(scope, params, groupBy) {
      if (!cfg.dimensions.includes(groupBy)) {
        throw new Error(
          `Metric "${cfg.id}" cannot be grouped by "${groupBy}"`,
        );
      }
      const match = matchFor(scope, params);

      if (groupBy === "month") {
        const rows = await cfg.model.aggregate([
          ...(cfg.prePipeline ?? []),
          { $match: match },
          {
            $group: {
              _id: {
                y: { $year: `$${cfg.dateField}` },
                m: { $month: `$${cfg.dateField}` },
              },
              value: valueExpr,
            },
          },
          { $sort: { "_id.y": 1, "_id.m": 1 } },
        ]);
        // Zero-fill every month in the window so a chart never shows a gap
        // as a missing point (which recharts would connect straight through).
        return fillMonths(params, rows);
      }

      if (groupBy === "status") {
        const rows = await cfg.model.aggregate([
          ...(cfg.prePipeline ?? []),
          { $match: match },
          { $group: { _id: `$${cfg.statusField}`, value: valueExpr } },
          { $sort: { value: -1 } },
        ]);
        return rows.map((r) => ({
          label: String(r._id ?? "Unknown"),
          value: r.value ?? 0,
        }));
      }

      // groupBy === "branch" — resolve ids to names so the chart is readable.
      const rows = await cfg.model.aggregate([
        ...(cfg.prePipeline ?? []),
        { $match: match },
        { $group: { _id: `$${cfg.branchField}`, value: valueExpr } },
        {
          $lookup: {
            from: BranchModel.collection.name,
            localField: "_id",
            foreignField: "_id",
            as: "branch",
          },
        },
        { $sort: { value: -1 } },
      ]);
      return rows.map((r) => ({
        label: r.branch?.[0]?.branchName ?? "Unknown branch",
        value: r.value ?? 0,
      }));
    },
  };
}

function fillMonths(
  params: MetricParams,
  rows: { _id: { y: number; m: number }; value: number }[],
): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  const cursor = new Date(
    Date.UTC(params.from.getUTCFullYear(), params.from.getUTCMonth(), 1),
  );
  const end = new Date(
    Date.UTC(params.to.getUTCFullYear(), params.to.getUTCMonth(), 1),
  );
  // Guard against a pathological range producing an unbounded label list.
  while (cursor <= end && out.length < 120) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const found = rows.find((r) => r._id.y === y && r._id.m === m);
    out.push({
      label: `${MONTH_LABELS[m - 1]} ${y}`,
      value: found?.value ?? 0,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

// ─── Registered metrics ───────────────────────────────────────────────────────

const ALL_ADMIN: UserRole[] = [ROLES.SUPER_ADMIN];

// Service revenue — from Honda DMS Tax Invoice PDFs. `derivedRevenue.*` is
// computed from the invoice's own line items at import time; `pendingRevenue`
// is deliberately excluded from the parts figure, since those lines haven't
// been matched to stock yet (see the Service Invoice module notes).
registerMetric(
  simpleMetric({
    id: "service.revenue.total",
    label: "Service Revenue",
    description:
      "Total invoiced service revenue (tax-inclusive) from closed job cards, by job card close date.",
    unit: "currency",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch"],
    model: ServiceInvoiceModel,
    branchField: "branchId",
    dateField: "jobCardClosedDate",
    valueField: "totalInvoiceAmount",
    baseMatch: { isActive: true, jobCardClosedDate: { $ne: null } },
  }),
);

registerMetric(
  simpleMetric({
    id: "service.revenue.parts",
    label: "Parts Revenue",
    description:
      "Revenue from parts sold on service invoices. Excludes parts still awaiting stock import (pending revenue) and hand-tagged accessories.",
    unit: "currency",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch"],
    model: ServiceInvoiceModel,
    branchField: "branchId",
    dateField: "jobCardClosedDate",
    valueField: "derivedRevenue.partsRevenue",
    baseMatch: { isActive: true, jobCardClosedDate: { $ne: null } },
  }),
);

registerMetric(
  simpleMetric({
    id: "service.revenue.labour",
    label: "Labour Revenue",
    description: "Revenue from labour/job codes billed on service invoices.",
    unit: "currency",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch"],
    model: ServiceInvoiceModel,
    branchField: "branchId",
    dateField: "jobCardClosedDate",
    valueField: "derivedRevenue.labourRevenue",
    baseMatch: { isActive: true, jobCardClosedDate: { $ne: null } },
  }),
);

registerMetric(
  simpleMetric({
    id: "service.revenue.pending",
    label: "Pending Parts Revenue",
    description:
      "Value of billed parts not yet matched to imported parts stock. Settles automatically on the next parts upload — a persistently high figure means stock uploads are lagging invoices.",
    unit: "currency",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch"],
    model: ServiceInvoiceModel,
    branchField: "branchId",
    dateField: "jobCardClosedDate",
    valueField: "derivedRevenue.pendingRevenue",
    baseMatch: { isActive: true, jobCardClosedDate: { $ne: null } },
  }),
);

registerMetric(
  simpleMetric({
    id: "service.invoice.count",
    label: "Invoices Closed",
    description:
      "Number of service invoices (one per closed job card) in the period.",
    unit: "count",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch"],
    model: ServiceInvoiceModel,
    branchField: "branchId",
    dateField: "jobCardClosedDate",
    baseMatch: { isActive: true, jobCardClosedDate: { $ne: null } },
  }),
);

// Live service management (job cards still open in the system, as opposed to
// the invoice records above, which are closed-and-billed).
registerMetric(
  simpleMetric({
    id: "jobcard.count",
    label: "Job Cards Created",
    description:
      "Number of live service job cards created in the period, across all statuses.",
    unit: "count",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch", "status"],
    model: JobCardModel,
    branchField: "branch",
    dateField: "createdAt",
    statusField: "status",
  }),
);

registerMetric(
  simpleMetric({
    id: "jobcard.revenue",
    label: "Job Card Value",
    description:
      "Sum of grand totals on live job cards created in the period. Use service.revenue.total instead for billed revenue.",
    unit: "currency",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch", "status"],
    model: JobCardModel,
    branchField: "branch",
    dateField: "createdAt",
    valueField: "grandTotal",
    statusField: "status",
  }),
);

// Vehicle sales — a StockConcept gains salesInfo.soldDate when assigned.
registerMetric(
  simpleMetric({
    id: "stock.sold.count",
    label: "Bikes Sold",
    description:
      "Number of bikes/scooties sold and assigned to customers in the period.",
    unit: "count",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch", "status"],
    model: StockConceptModel,
    branchField: "stockStatus.branchId",
    dateField: "salesInfo.soldDate",
    statusField: "salesInfo.paymentStatus",
  }),
);

registerMetric(
  simpleMetric({
    id: "stock.sales.revenue",
    label: "Vehicle Sales Revenue",
    description: "Total sale price of bikes sold to customers in the period.",
    unit: "currency",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch", "status"],
    model: StockConceptModel,
    branchField: "stockStatus.branchId",
    dateField: "salesInfo.soldDate",
    valueField: "salesInfo.salePrice",
    statusField: "salesInfo.paymentStatus",
  }),
);

// Value-added services. CustomerVehicle has no branch of its own — branch
// lives on the StockConcept it references — so both the unwind and the
// lookup have to run before any $match can be applied.
const VAS_PRE_PIPELINE = [
  { $unwind: "$activeValueAddedServices" },
  {
    $lookup: {
      from: StockConceptModel.collection.name,
      localField: "stockConcept",
      foreignField: "_id",
      as: "stock",
    },
  },
  { $unwind: "$stock" },
];

registerMetric(
  simpleMetric({
    id: "vas.activation.count",
    label: "VAS Activations",
    description:
      "Number of value-added services activated on customer vehicles in the period.",
    unit: "count",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch"],
    model: CustomerVehicleModel,
    branchField: "stock.stockStatus.branchId",
    dateField: "activeValueAddedServices.activatedDate",
    prePipeline: VAS_PRE_PIPELINE,
  }),
);

registerMetric(
  simpleMetric({
    id: "vas.revenue",
    label: "VAS Revenue",
    description: "Revenue from value-added services activated in the period.",
    unit: "currency",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch"],
    model: CustomerVehicleModel,
    branchField: "stock.stockStatus.branchId",
    dateField: "activeValueAddedServices.activatedDate",
    valueField: "activeValueAddedServices.purchasePrice",
    prePipeline: VAS_PRE_PIPELINE,
  }),
);

// Parts inventory activity. Note this counts import rows (added/changed
// events) in the window, which is upload activity — not current on-hand
// stock, which is an isCurrent:true snapshot with no meaningful date window.
registerMetric(
  simpleMetric({
    id: "parts.rows.imported",
    label: "Parts Rows Imported",
    description:
      "Number of parts stock rows added or changed by uploads in the period. This is import activity, not current on-hand stock.",
    unit: "count",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch"],
    model: PartsReportModel,
    branchField: "branchId",
    dateField: "importDate",
    baseMatch: { isActive: true },
  }),
);

registerMetric(
  simpleMetric({
    id: "accident.report.count",
    label: "Accident Reports",
    description: "Number of accident reports filed in the period.",
    unit: "count",
    allowedRoles: ALL_ADMIN,
    dimensions: ["month", "branch", "status"],
    model: AccidentReportModel,
    branchField: "branch",
    dateField: "createdAt",
    statusField: "status",
  }),
);
