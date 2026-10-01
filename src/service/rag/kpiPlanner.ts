import Anthropic from "@anthropic-ai/sdk";
import { AuthenticatedUser, getUserRole } from "../../types/user.types";
import { resolveBranchScope, BranchScope } from "./scope";
import { DashboardSpec } from "./dashboardSpec";
import {
  getMetric,
  metricsForRole,
  MetricDefinition,
  MetricDimension,
  MetricParams,
  MetricUnit,
} from "./metricRegistry";

/**
 * Prompt-driven KPI dashboards.
 *
 * The LLM's entire job here is *planning*: given a Super-Admin's question and
 * the metric catalogue, decide which registered metrics to show, over what
 * window, broken down how. It emits a JSON plan constrained by a schema whose
 * metricId enum comes from the registry itself, and that plan is then
 * re-validated against the registry before anything runs.
 *
 * The LLM never sees a row of data and never emits a number. Every figure in
 * the response is computed by Mongo in executeKpiPlan(). Branch scope is taken
 * from the caller's own token via resolveBranchScope() and is never read from
 * the model's output — a planned branch id would be a cross-tenant hole the
 * moment this panel is given to a branch-scoped role.
 */

// Planning is the step where a mistake silently produces a plausible-but-wrong
// dashboard, so this defaults to the strongest model rather than the cheap
// narration model the rest of the RAG layer uses. The call is small (a short
// catalogue in, a short plan out), so the cost difference is negligible.
const PLANNER_MODEL = process.env.ANTHROPIC_RAG_PLANNER_MODEL || "claude-opus-5";

const MAX_TILES = 6;
const MAX_CHARTS = 3;
/** Widest window a single plan may request, as a guard against a range that
 * would zero-fill hundreds of chart buckets. */
const MAX_RANGE_DAYS = 366 * 6;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

// ─── Public result shape ──────────────────────────────────────────────────────

export interface KpiTile {
  metricId: string;
  label: string;
  unit: MetricUnit;
  value: number;
  /** Same metric over the equal-length window immediately before this one. */
  previousValue?: number;
  /** Percent change vs. previousValue; null when the previous window was 0. */
  changePct?: number | null;
}

export interface KpiDashboard {
  title: string;
  period: { from: string; to: string; label: string };
  tiles: KpiTile[];
  /** Reuses the existing DashboardSpec shape so the frontend renders these
   * through the same DashboardChartPreview component as RAG chat charts. */
  charts: DashboardSpec[];
  model: string;
  /** Anything the planner asked for that the registry rejected. Surfaced so a
   * silently-dropped tile doesn't read as "we have no data for that". */
  warnings: string[];
}

export interface KpiRequestOptions {
  prompt: string;
  user: AuthenticatedUser;
  branchId?: string;
}

// ─── The plan the model is allowed to emit ────────────────────────────────────

interface RawPlan {
  title?: unknown;
  period?: { from?: unknown; to?: unknown; label?: unknown };
  compareToPreviousPeriod?: unknown;
  tiles?: unknown;
  charts?: unknown;
}

function planSchema(metrics: MetricDefinition[]) {
  const metricIds = metrics.map((m) => m.id);
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "period", "compareToPreviousPeriod", "tiles", "charts"],
    properties: {
      title: {
        type: "string",
        description: "Short dashboard heading, e.g. 'Q2 Service Performance'.",
      },
      period: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to", "label"],
        properties: {
          from: { type: "string", description: "Inclusive start date, YYYY-MM-DD." },
          to: { type: "string", description: "Inclusive end date, YYYY-MM-DD." },
          label: {
            type: "string",
            description: "Human-readable period, e.g. 'Apr–Jun 2026'.",
          },
        },
      },
      compareToPreviousPeriod: {
        type: "boolean",
        description:
          "True when the question implies a comparison over time (growth, trend, vs last year).",
      },
      tiles: {
        type: "array",
        description: `At most ${MAX_TILES} tiles.`,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["metricId"],
          properties: { metricId: { type: "string", enum: metricIds } },
        },
      },
      charts: {
        type: "array",
        description: `At most ${MAX_CHARTS} charts.`,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["metricId", "groupBy", "chartType"],
          properties: {
            metricId: { type: "string", enum: metricIds },
            groupBy: { type: "string", enum: ["month", "branch", "status"] },
            chartType: { type: "string", enum: ["bar", "line", "pie"] },
          },
        },
      },
    },
  };
}

function catalogueText(metrics: MetricDefinition[]): string {
  return metrics
    .map(
      (m) =>
        `- ${m.id} — ${m.label} (${m.unit}). ${m.description} Can be grouped by: ${m.dimensions.join(", ")}.`,
    )
    .join("\n");
}

const PLANNER_SYSTEM_INTRO = `You plan KPI dashboards for a Honda motorcycle dealership's Super-Admin.

You do NOT have access to any data and you must NEVER state or estimate a figure. Your only job is to choose which pre-defined metrics to display, over which date range, and how to break them down. The application computes every number from the database after you answer.

Rules:
- Only use metric ids from the catalogue below. Never invent one.
- Only use a groupBy the catalogue lists for that metric.
- Pick 2-4 tiles that directly answer the question. Do not pad the dashboard with loosely related metrics.
- Add a chart only when a breakdown genuinely helps. Use "line" for month trends, "bar" for branch or status comparisons, "pie" only for status splits of a whole.
- Resolve relative periods ("this year", "last quarter", "past 6 months") against today's date, which is given in the user message.
- When no period is implied, default to the current calendar year to date.
- Set compareToPreviousPeriod to true when the question is about growth, trends, or a comparison over time.

Metric catalogue:
`;

// ─── Planning ─────────────────────────────────────────────────────────────────

async function planDashboard(
  prompt: string,
  metrics: MetricDefinition[],
): Promise<RawPlan> {
  const message = await getClient().messages.create({
    model: PLANNER_MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: PLANNER_SYSTEM_INTRO + catalogueText(metrics),
        // The catalogue is byte-stable between requests, so it caches; today's
        // date and the question deliberately live in the user message, after
        // this breakpoint, so they can't invalidate the prefix.
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      format: { type: "json_schema", schema: planSchema(metrics) },
    },
    messages: [
      {
        role: "user",
        content: `Today is ${new Date().toISOString().slice(0, 10)}.\n\n${prompt}`,
      },
    ],
  });

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  try {
    return JSON.parse(text) as RawPlan;
  } catch {
    throw new Error("The assistant returned an unreadable dashboard plan");
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function resolvePeriod(
  raw: RawPlan,
  warnings: string[],
): { from: Date; to: Date; label: string } {
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const defaultTo = now;

  let from = parseDate(raw.period?.from);
  let to = parseDate(raw.period?.to);

  if (!from || !to) {
    warnings.push("Could not read the requested period; used the current year to date.");
    from = defaultFrom;
    to = defaultTo;
  } else if (from > to) {
    [from, to] = [to, from];
  }

  // End-of-day so an inclusive "to" actually includes that day's records.
  to = new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1);

  const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    warnings.push(
      `Requested period was longer than ${Math.floor(MAX_RANGE_DAYS / 366)} years; it was shortened.`,
    );
    from = new Date(to.getTime() - MAX_RANGE_DAYS * 86_400_000);
  }

  const label =
    typeof raw.period?.label === "string" && raw.period.label.trim()
      ? raw.period.label.trim()
      : `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`;

  return { from, to, label };
}

/** Resolves a planned metric id against the registry and the caller's role. */
function allowedMetric(
  id: unknown,
  allowed: Map<string, MetricDefinition>,
  warnings: string[],
): MetricDefinition | null {
  if (typeof id !== "string") return null;
  const metric = allowed.get(id);
  if (!metric) {
    // Covers both an unregistered id and one this role may not see. Either way
    // the tile is dropped rather than computed.
    warnings.push(`Metric "${id}" is not available, so it was left out.`);
    return null;
  }
  return metric;
}

// ─── Execution ────────────────────────────────────────────────────────────────

async function buildTiles(
  plan: RawPlan,
  scope: BranchScope,
  period: MetricParams,
  compare: boolean,
  allowed: Map<string, MetricDefinition>,
  warnings: string[],
): Promise<KpiTile[]> {
  const requested = Array.isArray(plan.tiles) ? plan.tiles.slice(0, MAX_TILES) : [];

  const metrics = requested
    .map((t: any) => allowedMetric(t?.metricId, allowed, warnings))
    .filter((m): m is MetricDefinition => m !== null);

  // Equal-length window immediately before this one.
  const span = period.to.getTime() - period.from.getTime();
  const previous: MetricParams = {
    from: new Date(period.from.getTime() - span - 1),
    to: new Date(period.from.getTime() - 1),
  };

  return Promise.all(
    metrics.map(async (metric) => {
      const [value, previousValue] = await Promise.all([
        metric.compute(scope, period),
        compare ? metric.compute(scope, previous) : Promise.resolve(undefined),
      ]);

      const tile: KpiTile = {
        metricId: metric.id,
        label: metric.label,
        unit: metric.unit,
        value,
      };
      if (previousValue !== undefined) {
        tile.previousValue = previousValue;
        tile.changePct =
          previousValue === 0
            ? null
            : ((value - previousValue) / previousValue) * 100;
      }
      return tile;
    }),
  );
}

async function buildCharts(
  plan: RawPlan,
  scope: BranchScope,
  period: MetricParams,
  allowed: Map<string, MetricDefinition>,
  warnings: string[],
): Promise<DashboardSpec[]> {
  const requested = Array.isArray(plan.charts)
    ? plan.charts.slice(0, MAX_CHARTS)
    : [];

  const specs = await Promise.all(
    requested.map(async (c: any): Promise<DashboardSpec | null> => {
      const metric = allowedMetric(c?.metricId, allowed, warnings);
      if (!metric) return null;

      const groupBy = c?.groupBy as MetricDimension;
      if (!metric.dimensions.includes(groupBy)) {
        warnings.push(
          `"${metric.label}" cannot be broken down by ${groupBy}, so that chart was left out.`,
        );
        return null;
      }

      const chartType: DashboardSpec["chartType"] =
        c?.chartType === "line" || c?.chartType === "pie" ? c.chartType : "bar";

      const data = await metric.series(scope, period, groupBy);
      if (data.length === 0) return null;

      return {
        title: `${metric.label} by ${groupBy}`,
        chartType,
        // SeriesPoint is {label, value}, so the axis keys are fixed — this is
        // what lets these charts reuse DashboardChartPreview unchanged.
        data: data as unknown as Record<string, string | number>[],
        xKey: "label",
        yKey: "value",
      };
    }),
  );

  return specs.filter((s): s is DashboardSpec => s !== null);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function generateKpiDashboard(
  opts: KpiRequestOptions,
): Promise<KpiDashboard> {
  const { prompt, user } = opts;
  if (!prompt?.trim()) {
    throw new Error("A prompt is required");
  }

  const scope = resolveBranchScope(user, opts.branchId);
  if (scope === null) {
    throw new Error("Branch could not be resolved");
  }

  const metrics = metricsForRole(getUserRole(user));
  if (metrics.length === 0) {
    throw new Error("No KPI metrics are available for this role");
  }
  const allowed = new Map(metrics.map((m) => [m.id, m]));

  const plan = await planDashboard(prompt.trim(), metrics);

  const warnings: string[] = [];
  const period = resolvePeriod(plan, warnings);
  const params: MetricParams = { from: period.from, to: period.to };
  const compare = plan.compareToPreviousPeriod === true;

  const [tiles, charts] = await Promise.all([
    buildTiles(plan, scope, params, compare, allowed, warnings),
    buildCharts(plan, scope, params, allowed, warnings),
  ]);

  if (tiles.length === 0 && charts.length === 0) {
    throw new Error(
      "That question didn't map to any available KPI. Try asking about service revenue, job cards, bike sales, VAS, parts imports, or accident reports.",
    );
  }

  return {
    title:
      typeof plan.title === "string" && plan.title.trim()
        ? plan.title.trim()
        : "Dealership KPIs",
    period: {
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      label: period.label,
    },
    tiles,
    charts,
    model: PLANNER_MODEL,
    warnings,
  };
}

/** Catalogue for the UI — lets the panel show what can be asked about. */
export function listKpiMetrics(user: AuthenticatedUser) {
  return metricsForRole(getUserRole(user)).map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
    unit: m.unit,
    dimensions: m.dimensions,
  }));
}
