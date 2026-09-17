// scripts/verifyServiceInvoiceImport.ts
//
// End-to-end check of the service-invoice pipeline against the real database:
// seeds a couple of parts-stock rows, imports an invoice PDF, and prints what
// landed — classification, consumption ledger, effective stock and the vehicle
// roll-up — then reverses it all and confirms the reversal.
//
// Everything it creates is namespaced to a throwaway branch and removed at the
// end, so it is safe to run against a working database.
//
//   npm run invoice:verify:e2e -- "/path/to/INVOICE.PDF"

import * as path from "path";
import * as fs from "fs";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

import { ServiceInvoiceModel } from "../models/ServiceInvoice/ServiceInvoice";
import { ServiceInvoiceLineItemModel } from "../models/ServiceInvoice/ServiceInvoiceLineItem";
import { PartsConsumptionModel } from "../models/ServiceInvoice/PartsConsumption";
import { PartsReportModel } from "../models/PartsReport";
import { CustomerVehicleModel } from "../models/BikeSystemModel2/CustomerVehicleModel";
import { StockConceptCSVModel } from "../models/BikeSystemModel3/StockConceptCSV";
import { BaseCustomerModel } from "../models/CustomerSystem/BaseCustomer";
import {
  commitInvoice,
  reverseInvoice,
} from "../service/serviceInvoice/importInvoice.service";
import { getEffectiveStock } from "../service/serviceInvoice/effectiveStock.service";
import { reconcilePendingStock } from "../service/serviceInvoice/reconcilePendingStock.service";
import { parseServiceInvoicePdf } from "../service/serviceInvoice/invoicePdfExtractor";

/** Parts from the reference invoice that we pretend are carried in stock. */
const SEEDED_STOCK = [
  { partNumber: "08233-2MB-F0LGF", description: "ENGINE OIL BPCL 600ML", quantity: 12, unitPrice: 325.56 },
  { partNumber: "90401-KWP-F00", description: "WASHER PLUG DRAIN 12MM", quantity: 40, unitPrice: 5.08 },
  { partNumber: "17210-K1J-D00", description: "ELEMENT AIR/C", quantity: 6, unitPrice: 204.23 },
];

function line(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: npm run invoice:verify:e2e -- "<path-to-invoice.pdf>"');
    process.exit(1);
  }
  const file = path.resolve(target);
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set — cannot run the end-to-end check.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected.");

  // A throwaway branch id keeps every write isolated from real data.
  const branchId = new mongoose.Types.ObjectId();
  const uploadedBy = new mongoose.Types.ObjectId();
  const buffer = fs.readFileSync(file);

  let invoiceId: string | undefined;
  // Captured before the reversal, which strips the links we'd otherwise use
  // to find these rows again during cleanup.
  let createdVehicleId: string | undefined;
  let createdCustomerId: string | undefined;

  try {
    line("SEED PARTS STOCK");
    const importDate = new Date(Date.now() - 86_400_000); // yesterday
    await PartsReportModel.insertMany(
      SEEDED_STOCK.map((p, i) => ({
        partId: `VERIFY-${Date.now()}-${String(i).padStart(6, "0")}`,
        rowData: { "Part Number": p.partNumber, Quantity: p.quantity },
        normalized: p,
        rowHash: `verify-${p.partNumber}-${Date.now()}`,
        detectedColumns: ["Part Number", "Description", "Quantity", "Unit Price"],
        sourceFormat: "xlsx",
        importBatch: `VERIFY-${Date.now()}`,
        importDate,
        fileName: "verify-seed.xlsx",
        branchId,
        uploadedBy,
        isActive: true,
        isCurrent: true,
      })),
    );
    for (const p of SEEDED_STOCK) {
      console.log(`  seeded ${p.partNumber.padEnd(20)} qty ${p.quantity}`);
    }

    line("PARSE");
    const parsed = await parseServiceInvoicePdf(buffer);
    console.log(
      `  invoice ${parsed.header.invoiceNumber} · frame ${parsed.header.frameNumber} · technician ${parsed.header.technicianName}`,
    );
    console.log(`  ${parsed.lineItems.length} line items`);

    line("IMPORT");
    const result = await commitInvoice({
      buffer,
      fileName: path.basename(file),
      branchId: String(branchId),
      uploadedBy,
      uploadedByRole: "Part-Admin",
    });
    invoiceId = result.invoiceId;
    createdVehicleId = result.autoRegistration?.vehicleId;
    createdCustomerId = result.autoRegistration?.customerId;
    console.log(`  duplicate       : ${result.duplicate}`);
    console.log(`  invoiceNumber   : ${result.invoiceNumber}`);
    console.log(`  counts          : ${JSON.stringify(result.counts)}`);
    console.log(`  revenue         : ${JSON.stringify(result.revenue)}`);
    console.log(`  autoRegistration: ${JSON.stringify(result.autoRegistration)}`);
    console.log(`  needsReview     : ${result.needsReview}`);
    for (const r of result.reviewReasons) console.log(`      - ${r}`);

    line("CLASSIFICATION (stored line items)");
    const stored = await ServiceInvoiceLineItemModel.find({ branchId })
      .sort({ srNo: 1 })
      .lean();
    for (const l of stored as any[]) {
      console.log(
        `  ${String(l.srNo).padStart(2)}  ${l.partNo.padEnd(18)} ${l.kind.padEnd(7)}` +
          `${l.classification.padEnd(10)} match=${l.matchQuality.padEnd(6)}` +
          `${l.isLube ? " LUBE" : ""}`,
      );
    }

    line("CONSUMPTION LEDGER");
    const ledger = await PartsConsumptionModel.find({ branchId }).lean();
    for (const c of ledger as any[]) {
      console.log(
        `  ${c.partNumber.padEnd(20)} qty ${c.qty}  by ${c.technicianName || "?"}  frame ${c.frameNumber || "?"}`,
      );
    }

    line("EFFECTIVE STOCK (stockQty - consumed)");
    const eff = await getEffectiveStock(String(branchId));
    for (const r of eff.rows) {
      console.log(
        `  ${r.partNumber.padEnd(20)} stock ${String(r.stockQty).padStart(3)}` +
          ` - consumed ${String(r.consumedQty).padStart(3)}` +
          ` = ${String(r.effectiveQty).padStart(3)}${r.oversold ? "  ** OVERSOLD **" : ""}`,
      );
    }

    line("VEHICLE ROLL-UP");
    const vehicle = await CustomerVehicleModel.findOne({
      _id: result.autoRegistration?.vehicleId,
    }).lean();
    if (vehicle) {
      console.log(`  serviceExpenses : ${JSON.stringify((vehicle as any).serviceExpenses)}`);
      const acc = (vehicle as any).accessories || [];
      console.log(`  accessories     : ${acc.length}`);
      for (const a of acc) {
        console.log(`      ${a.partNo} · ${a.description} · fitted by ${a.fittedBy || "?"}`);
      }
    } else {
      console.log("  (no vehicle linked)");
    }

    line("LATE PARTS-STOCK UPLOAD -> RECONCILE PENDING");
    // The three parts the invoice billed that were NOT seeded above — i.e.
    // exactly the "not in stock yet" case. Upload them now.
    const LATE_STOCK = [
      { partNumber: "91307-035-000", description: "ORING 18X3", quantity: 20, unitPrice: 5.93 },
      { partNumber: "SP0007", description: "OIL", quantity: 15, unitPrice: 107.74 },
      { partNumber: "SP001-GRS-100", description: "EP2 GREASE", quantity: 9, unitPrice: 17.79 },
    ];
    await PartsReportModel.insertMany(
      LATE_STOCK.map((p, i) => ({
        partId: `VERIFY-LATE-${Date.now()}-${String(i).padStart(6, "0")}`,
        rowData: { "Part Number": p.partNumber, Quantity: p.quantity },
        normalized: p,
        rowHash: `verify-late-${p.partNumber}-${Date.now()}`,
        detectedColumns: ["Part Number", "Description", "Quantity", "Unit Price"],
        sourceFormat: "xlsx",
        importBatch: `VERIFY-LATE-${Date.now()}`,
        importDate: new Date(),
        fileName: "verify-late-seed.xlsx",
        branchId,
        uploadedBy,
        isActive: true,
        isCurrent: true,
      })),
    );
    for (const p of LATE_STOCK) console.log(`  late-seeded ${p.partNumber}`);

    const rec = await reconcilePendingStock(String(branchId), "VERIFY-LATE-BATCH");
    console.log(`  examined=${rec.examined} resolved=${rec.resolved} stillPending=${rec.stillPending} invoices=${rec.invoicesTouched}`);
    for (const l of rec.lines) {
      console.log(`      ${l.partNo.padEnd(18)} -> SOLD  qty ${l.qty}  ₹${l.taxableAmount}  invoice ${l.invoiceNumber}  soldAt ${l.soldAt.toISOString().slice(0,10)}`);
    }

    const afterLines = await ServiceInvoiceLineItemModel.find({ branchId })
      .sort({ srNo: 1 })
      .lean();
    console.log("  classifications now:");
    for (const l of afterLines as any[]) {
      console.log(`      ${String(l.srNo).padStart(2)} ${l.partNo.padEnd(18)} ${l.classification}${l.soldAt ? "  soldAt=" + new Date(l.soldAt).toISOString().slice(0,10) : ""}`);
    }
    const invAfter: any = await ServiceInvoiceModel.findById(invoiceId).lean();
    console.log(`  invoice derivedRevenue: ${JSON.stringify(invAfter?.derivedRevenue)}`);
    console.log(`  invoice needsReview   : ${invAfter?.needsReview}  reasons=${(invAfter?.reviewReasons||[]).length}`);
    const vehAfter: any = await CustomerVehicleModel.findById(createdVehicleId).lean();
    console.log(`  vehicle serviceExpenses: ${JSON.stringify(vehAfter?.serviceExpenses)}`);

    line("EFFECTIVE STOCK AFTER BACK-FILL");
    // Subtle but important: the back-filled parts were consumed on the job
    // card's close date (14th) but only counted into stock on the upload date
    // (15th). That stock count ALREADY reflects the part having left, so the
    // consumption must NOT be subtracted again — expect consumed 0 for them.
    const effBack = await getEffectiveStock(String(branchId));
    for (const r of effBack.rows) {
      const late = ["91307-035-000", "SP0007", "SP001-GRS-100"].includes(r.partNumber);
      console.log(
        `  ${r.partNumber.padEnd(20)} stock ${String(r.stockQty).padStart(3)}` +
          ` - consumed ${String(r.consumedQty).padStart(3)}` +
          ` = ${String(r.effectiveQty).padStart(3)}` +
          (late ? "   <- back-filled (count post-dates the sale)" : ""),
      );
    }

    line("RECONCILE AGAIN (must be a no-op)");
    const rec2 = await reconcilePendingStock(String(branchId), "VERIFY-LATE-BATCH-2");
    const ledgerNow = await PartsConsumptionModel.countDocuments({ branchId, isActive: true });
    console.log(`  resolved=${rec2.resolved} (expected 0)   ledger rows=${ledgerNow} (expected 6)`);

    line("RE-IMPORT (must be a duplicate no-op)");
    const again = await commitInvoice({
      buffer,
      fileName: path.basename(file),
      branchId: String(branchId),
      uploadedBy,
      uploadedByRole: "Part-Admin",
    });
    const ledgerAfter = await PartsConsumptionModel.countDocuments({ branchId });
    console.log(`  duplicate: ${again.duplicate}  (expected true)`);
    // 3 written at import + 3 back-filled by the reconciliation above.
    console.log(
      `  ledger rows: ${ledgerAfter} (expected 6 — unchanged by the duplicate)`,
    );

    line("REVERSE (delete)");
    if (invoiceId) {
      const rev = await reverseInvoice({
        invoiceId,
        deletedBy: uploadedBy,
        deletedByRole: "Super-Admin",
      });
      console.log(`  reversed: ${JSON.stringify(rev)}`);
      const effAfter = await getEffectiveStock(String(branchId));
      for (const r of effAfter.rows) {
        console.log(
          `  ${r.partNumber.padEnd(20)} stock ${String(r.stockQty).padStart(3)}` +
            ` - consumed ${String(r.consumedQty).padStart(3)}` +
            ` = ${String(r.effectiveQty).padStart(3)}  (consumed should be 0)`,
        );
      }
      const veh = await CustomerVehicleModel.findById(
        result.autoRegistration?.vehicleId,
      ).lean();
      if (veh) {
        console.log(
          `  vehicle serviceExpenses after reversal: ${JSON.stringify((veh as any).serviceExpenses)}`,
        );
        console.log(
          `  vehicle accessories after reversal   : ${((veh as any).accessories || []).length}`,
        );
      }
    }
  } finally {
    line("CLEANUP");
    // EVERY delete here is scoped to `branchId` — a throwaway ObjectId created
    // at the top of this run. Never delete by a business field such as
    // `partNo` or `invoiceNumber`: real invoices share part numbers with this
    // sample (SP0007 and SP001-GRS-100 are generic Honda consumables), so an
    // unscoped filter silently destroys production rows.
    await Promise.all([
      ServiceInvoiceModel.deleteMany({ branchId }),
      ServiceInvoiceLineItemModel.deleteMany({ branchId }),
      PartsConsumptionModel.deleteMany({ branchId }),
      PartsReportModel.deleteMany({ branchId }),
    ]);

    // Auto-registration writes into the SHARED customer/vehicle/stock
    // collections, which carry no branch of this run's making — so delete by
    // the ids it reported rather than by any filter.
    if (createdVehicleId) {
      const vehicle = await CustomerVehicleModel.findById(createdVehicleId).lean();
      if (vehicle) {
        await StockConceptCSVModel.deleteOne({ _id: (vehicle as any).stockConcept });
        await CustomerVehicleModel.deleteOne({ _id: createdVehicleId });
      }
    }
    if (createdCustomerId) {
      await BaseCustomerModel.deleteOne({ _id: createdCustomerId });
    }
    console.log(
      "  removed this run's invoices, line items, ledger, seed stock, " +
        "and the customer/vehicle/stock rows auto-registration created.",
    );
    await mongoose.disconnect();
    console.log("  disconnected.\n");
  }
}

main().catch(async (err) => {
  console.error("\nFAILED:", err?.message);
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
