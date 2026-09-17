// scripts/backfillSalesReportCustomers.ts
//
// One-off, idempotent backfill for Sales Reports imported BEFORE customer
// creation was decoupled from the stock match.
//
// The old importer only created a BaseCustomer on the one path where the row
// also matched a StockConceptCSV unit that wasn't already Sold. Every other
// outcome — unmatched, matched_already_sold, matched_manual_form_status_flipped
// — recorded the row and threw the buyer away. A report whose frame numbers
// predated the stock import therefore produced zero customers, and because
// {branchId, frameNo} is a unique index over active rows, simply re-uploading
// the file is rejected as a duplicate. Hence this script.
//
// It ONLY creates/links customers:
//
//   row without customerId, with a usable mobile -> find-or-create
//                                                   BaseCustomer, write
//                                                   customerId onto the row
//
// It deliberately does NOT re-run stock matching or create CustomerVehicles.
// The original import already decided each row's stock outcome, and re-deciding
// it here would flip stock to "Sold" on a second, unaudited code path.
//
//   npm run sales-report:backfill-customers          # report only
//   npm run sales-report:backfill-customers -- --apply

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

import { SalesReportModel } from "../models/SalesReport";
import { BaseCustomerModel } from "../models/CustomerSystem/BaseCustomer";
import { normalizePhone } from "../service/salesReport.service";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(
    apply ? "Running backfill (--apply).\n" : "DRY RUN — pass --apply to write.\n",
  );

  const rows = await SalesReportModel.find({
    isActive: true,
    $or: [{ customerId: { $exists: false } }, { customerId: null }],
  }).select(
    "saleReportId frameNo customerFirstName customerLastName customerMobile importBatch",
  );

  console.log(`Sales report rows with no linked customer: ${rows.length}\n`);

  let created = 0;
  let linkedExisting = 0;
  let noPhone = 0;

  for (const row of rows) {
    const phoneNumber = normalizePhone(row.customerMobile);
    const name = `${row.customerFirstName ?? ""} ${row.customerLastName ?? ""}`.trim();

    if (!phoneNumber) {
      noPhone++;
      console.log(
        `  SKIP  ${row.frameNo.padEnd(20)} ${name || "(no name)"} — no usable mobile (${row.customerMobile || "blank"})`,
      );
      continue;
    }

    let customer = await BaseCustomerModel.findOne({ phoneNumber });
    const isNew = !customer;

    if (!customer && apply) {
      customer = await BaseCustomerModel.create({
        phoneNumber,
        isVerified: false,
        creationSource: "new_csv_sales_report",
      });
    }

    if (isNew) created++;
    else linkedExisting++;

    if (apply && customer) {
      row.customerId = customer._id as unknown as mongoose.Types.ObjectId;
      await row.save();
    }

    console.log(
      `  ${isNew ? "NEW " : "LINK"}  ${row.frameNo.padEnd(20)} ${phoneNumber}  ${name || "(no name)"}`,
    );
  }

  console.log("\n─────────────────────────────────");
  console.log(`rows examined       : ${rows.length}`);
  console.log(`customers created   : ${created}`);
  console.log(`linked to existing  : ${linkedExisting}`);
  console.log(`skipped (no mobile) : ${noPhone}`);
  if (!apply) console.log("\nDRY RUN — nothing was written.");

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
