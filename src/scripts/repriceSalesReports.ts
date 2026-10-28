// scripts/repriceSalesReports.ts
//
// Idempotent re-pricing of active Sales Report rows whose Total Payment was
// derived from the bike catalogue or the CSV stock uploads (see
// lookupExShowroom) rather than read from the uploaded file. Run it after the
// catalogue or stock changes — a model added, a price updated — or after the
// matching itself improves, since rows already imported keep whatever price
// they were given at upload.
//
// A row is re-priced only when:
//   - its file carried no Total Payment of its own, and
//   - its current total is 0 or a price the catalogue / stock can produce.
//     Anything else was typed in through the row edit dialog and is left alone.
//
//   npm run sales-report:reprice          # report only
//   npm run sales-report:reprice -- --apply

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

import { SalesReportModel } from "../models/SalesReport";
import { StockConceptCSVModel } from "../models/BikeSystemModel3/StockConceptCSV";
import BikesModel from "../models/BikeSystemModel/Bikes";
import { lookupExShowroom } from "../service/salesReport/processSalesReportRow.service";
import {
  matchSalesReportColumns,
  buildSalesReportNormalizedRow,
} from "../utils/salesReportColumnMatcher";

/** Every price lookupExShowroom can produce: catalogue prices and stock cost prices. */
async function derivablePrices(): Promise<Set<number>> {
  const bikes = await BikesModel.find({})
    .select("variants priceBreakdown.exShowroomPrice")
    .lean();
  const prices = new Set<number>();
  for (const b of bikes as any[]) {
    const base = b.priceBreakdown?.exShowroomPrice ?? 0;
    prices.add(base);
    for (const v of b.variants ?? []) prices.add(base + (v.priceAdjustment ?? 0));
  }
  const costs = await StockConceptCSVModel.distinct("costPrice");
  for (const c of costs) if (typeof c === "number") prices.add(c);
  return prices;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(
    apply ? "Re-pricing (--apply).\n" : "DRY RUN — pass --apply to write.\n",
  );

  const derivable = await derivablePrices();
  const rows = await SalesReportModel.find({ isActive: true });

  let fromFile = 0;
  let handEdited = 0;
  let unchanged = 0;
  const changed: string[] = [];
  const stillUnpriced = new Map<string, number>();

  for (const row of rows) {
    const match = matchSalesReportColumns(row.detectedColumns ?? []);
    const fileTotal = buildSalesReportNormalizedRow(row.rowData ?? {}, match)
      .normalized.totalPayment;
    if (fileTotal && fileTotal > 0) {
      fromFile++;
      continue;
    }
    if (row.totalPayment > 0 && !derivable.has(row.totalPayment)) {
      handEdited++;
      continue;
    }

    const stockDoc =
      row.matchedStockId && row.matchedStockType !== "StockConcept"
        ? await StockConceptCSVModel.findById(row.matchedStockId).lean()
        : null;
    const price = await lookupExShowroom(stockDoc, row.modelName, row.engineNo);

    if (!price) {
      const model = row.modelName || "(blank model name)";
      stillUnpriced.set(model, (stillUnpriced.get(model) ?? 0) + 1);
    }
    if (price === row.totalPayment) {
      unchanged++;
      continue;
    }

    changed.push(
      `${row.saleReportId}  ${row.frameNo}  ${row.modelName}: ${row.totalPayment} -> ${price}`,
    );
    if (apply) {
      row.totalPayment = price;
      if (!price) row.needsReview = true;
      await row.save();
    }
  }

  console.log(changed.join("\n") || "(no prices change)");
  console.log(
    `\n${rows.length} active rows: ${changed.length} ${apply ? "re-priced" : "would be re-priced"}, ` +
      `${unchanged} already correct, ${fromFile} priced by their file, ${handEdited} hand-edited (left alone).`,
  );
  if (stillUnpriced.size) {
    console.log(
      "\nStill no price — these models are in neither the bike catalogue nor any stock upload:",
    );
    for (const [model, n] of stillUnpriced) console.log(`  ${model} — ${n} row(s)`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
