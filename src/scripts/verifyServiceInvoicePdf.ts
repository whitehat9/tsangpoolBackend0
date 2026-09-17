// scripts/verifyServiceInvoicePdf.ts
//
// Dev utility: parse a Honda DMS service invoice PDF and print what the
// extractor found, without touching the database.
//
// There is no test runner configured in this package, so this doubles as the
// regression check for the PDF extractor — run it against a known invoice and
// confirm the header fields, the PART/LABOUR split and the reconciliation.
//
//   npm run invoice:verify -- "/path/to/INVOICE.PDF"

import * as fs from "fs";
import * as path from "path";
import {
  parseServiceInvoicePdf,
  InvoicePdfParseError,
} from "../service/serviceInvoice/invoicePdfExtractor";

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npm run invoice:verify -- <path-to-invoice.pdf>");
    process.exit(1);
  }

  const file = path.resolve(target);
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }

  const parsed = await parseServiceInvoicePdf(fs.readFileSync(file));

  console.log(`\n=== ${path.basename(file)} (${parsed.pageCount} pages) ===\n`);

  console.log("HEADER");
  for (const [k, v] of Object.entries(parsed.header)) {
    console.log(`  ${k.padEnd(20)} ${v instanceof Date ? v.toISOString().slice(0, 10) : String(v)}`);
  }

  console.log("\nCUSTOMER");
  for (const [k, v] of Object.entries(parsed.parties)) {
    console.log(`  ${k.padEnd(20)} ${String(v)}`);
  }

  console.log("\nTOTALS (as stated on the invoice)");
  for (const [k, v] of Object.entries(parsed.totals)) {
    console.log(`  ${k.padEnd(24)} ${String(v)}`);
  }

  console.log(`\nLINE ITEMS (${parsed.lineItems.length})`);
  console.log(
    "  " +
      "Sr".padStart(3) +
      "  " +
      "Kind".padEnd(7) +
      "Part/Jobcode".padEnd(20) +
      "Qty".padStart(4) +
      "Taxable".padStart(10) +
      "  HSN".padEnd(12) +
      "Description",
  );
  for (const l of parsed.lineItems) {
    console.log(
      "  " +
        String(l.srNo).padStart(3) +
        "  " +
        l.kind.padEnd(7) +
        l.partNo.padEnd(20) +
        String(l.qty).padStart(4) +
        l.taxableAmount.toFixed(2).padStart(10) +
        "  " +
        l.hsn.padEnd(10) +
        l.description.slice(0, 40),
    );
  }

  const parts = parsed.lineItems.filter((l) => l.kind === "PART");
  const labour = parsed.lineItems.filter((l) => l.kind === "LABOUR");
  console.log(
    `\n  => ${parts.length} PART / ${labour.length} LABOUR` +
      `  |  parts taxable ${parsed.reconciliation.partsTaxable.toFixed(2)}` +
      `  |  labour taxable ${parsed.reconciliation.labourTaxable.toFixed(2)}`,
  );

  console.log(`\nRECONCILIATION: ${parsed.reconciliation.ok ? "OK" : "MISMATCH"}`);
  for (const n of parsed.reconciliation.notes) console.log(`  - ${n}`);

  console.log(`\nNEEDS REVIEW: ${parsed.needsReview}`);
  for (const r of parsed.reviewReasons) console.log(`  - ${r}`);
  console.log();
}

main().catch((err) => {
  if (err instanceof InvoicePdfParseError) {
    console.error(`\nParse failed: ${err.message}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
