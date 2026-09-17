// scripts/migratePendingStock.ts
//
// One-off, idempotent migration for invoices imported BEFORE the
// PENDING_STOCK change.
//
// The old importer auto-classified any billed part it couldn't find in stock
// as ACCESSORY. That was wrong: most of those parts simply hadn't been
// uploaded yet. Those rows are now frozen in the wrong state — and because the
// reconciliation sweep only looks at PENDING_STOCK lines, they would never
// resolve when the Part-Admin finally uploads the stock.
//
// This converts them:
//
//   line      ACCESSORY (auto-assigned) -> PENDING_STOCK
//   invoice   accessoriesRevenue        -> pendingRevenue
//   invoice   old review wording        -> new "awaiting stock" wording
//   vehicle   accessories[] entry        -> removed (it was never an accessory)
//
// ...then runs the normal reconciliation, so anything already in stock is
// marked sold immediately with its date and invoice reference.
//
// Hand-tagged accessories are left alone: those are set via
// PATCH /service-invoice/line-items/:id/accessory, which clears `needsReview`,
// so `needsReview: true` is what identifies an auto-assigned row.
//
//   npm run invoice:migrate-pending          # report only
//   npm run invoice:migrate-pending -- --apply

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

import { ServiceInvoiceModel } from "../models/ServiceInvoice/ServiceInvoice";
import { ServiceInvoiceLineItemModel } from "../models/ServiceInvoice/ServiceInvoiceLineItem";
import { CustomerVehicleModel } from "../models/BikeSystemModel2/CustomerVehicleModel";
import { reconcilePendingStock } from "../service/serviceInvoice/reconcilePendingStock.service";

/** The wording the old importer wrote onto ServiceInvoice.reviewReasons. */
const OLD_REASON = /^"(.+)" is not in parts stock — recorded as an accessory fitted to the bike\.$/;

function newReason(partNo: string): string {
  return `"${partNo}" is not in parts stock yet — recorded against this invoice and awaiting a parts-stock upload, which will mark it sold.`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(apply ? "Running migration (--apply).\n" : "DRY RUN — pass --apply to write.\n");

  // Auto-assigned accessories only.
  const stale = await ServiceInvoiceLineItemModel.find({
    classification: "ACCESSORY",
    needsReview: true,
    isActive: true,
  }).lean();

  if (stale.length === 0) {
    console.log("Nothing to migrate — no auto-assigned ACCESSORY lines found.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${stale.length} auto-assigned ACCESSORY line(s):`);
  for (const l of stale as any[]) {
    console.log(`  ${l.partNo.padEnd(20)} ₹${l.taxableAmount}  invoice ${l.invoiceId}`);
  }

  // Group the revenue that has to move, per invoice.
  const perInvoice = new Map<string, number>();
  for (const l of stale as any[]) {
    const id = String(l.invoiceId);
    perInvoice.set(id, (perInvoice.get(id) ?? 0) + (l.taxableAmount ?? 0));
  }

  const invoices = await ServiceInvoiceModel.find({
    _id: { $in: [...perInvoice.keys()] },
  }).lean();
  const branches = new Set<string>();

  console.log(`\nAffecting ${invoices.length} invoice(s):`);
  for (const inv of invoices as any[]) {
    branches.add(String(inv.branchId));
    console.log(
      `  ${inv.invoiceNumber}  moving ₹${perInvoice.get(String(inv._id))?.toFixed(2)} accessories -> pending`,
    );
  }

  if (!apply) {
    console.log("\nDry run complete. Re-run with --apply to write these changes.");
    await mongoose.disconnect();
    return;
  }

  // ── 1. lines: ACCESSORY -> PENDING_STOCK ────────────────────────────────
  const lineIds = (stale as any[]).map((l) => l._id);
  const r1 = await ServiceInvoiceLineItemModel.updateMany(
    { _id: { $in: lineIds } },
    { classification: "PENDING_STOCK", soldAt: null },
  );
  console.log(`\nlines reclassified : ${r1.modifiedCount}`);

  // ── 2. invoices: move revenue + rewrite the stale wording ───────────────
  let reasonsFixed = 0;
  for (const inv of invoices as any[]) {
    const moved = perInvoice.get(String(inv._id)) ?? 0;
    await ServiceInvoiceModel.updateOne(
      { _id: inv._id },
      {
        $inc: {
          "derivedRevenue.accessoriesRevenue": -moved,
          "derivedRevenue.pendingRevenue": moved,
        },
      },
    );

    const rewritten = (inv.reviewReasons || []).map((r: string) => {
      const m = r.match(OLD_REASON);
      if (!m) return r;
      reasonsFixed += 1;
      return newReason(m[1]);
    });
    await ServiceInvoiceModel.updateOne(
      { _id: inv._id },
      { reviewReasons: rewritten },
    );
  }
  console.log(`invoices updated   : ${invoices.length}`);
  console.log(`review reasons fixed: ${reasonsFixed}`);

  // ── 3. vehicles: drop the accessory entries that were never accessories ──
  let accessoriesRemoved = 0;
  for (const inv of invoices as any[]) {
    if (!inv.customerVehicleId) continue;
    const partNos = (stale as any[])
      .filter((l) => String(l.invoiceId) === String(inv._id))
      .map((l) => l.partNo);
    const res = await CustomerVehicleModel.updateOne(
      { _id: inv.customerVehicleId },
      { $pull: { accessories: { invoiceId: inv._id, partNo: { $in: partNos } } } },
    );
    accessoriesRemoved += res.modifiedCount ?? 0;
  }
  console.log(`vehicles cleaned   : ${accessoriesRemoved}`);

  // ── 4. resolve anything already in stock ────────────────────────────────
  console.log("\nReconciling against current parts stock…");
  for (const branchId of branches) {
    const rec = await reconcilePendingStock(branchId, "MIGRATION");
    console.log(
      `  branch ${branchId}: examined=${rec.examined} resolved=${rec.resolved} stillPending=${rec.stillPending}`,
    );
    for (const l of rec.lines) {
      console.log(
        `      ${l.partNo.padEnd(20)} -> SOLD  invoice ${l.invoiceNumber}  ${l.soldAt.toISOString().slice(0, 10)}`,
      );
    }
  }

  console.log("\nDone.");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("FAILED:", err?.message);
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
