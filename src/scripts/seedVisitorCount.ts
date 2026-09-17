import mongoose from "mongoose";
import dotenv from "dotenv";
import VisitorModel from "../models/visitor";

dotenv.config();

const DEFAULT_BASELINE = 927;

/**
 * One-off seed: restores the site-wide visitor counter to a known baseline
 * after the database was wiped.
 *
 * The counter lives in a single document in the `visitors` collection
 * (`totalVisitors`), created lazily by POST /api/visitor/increment-counter.
 * With the collection gone, the next visit would restart the public counter
 * at 1. This writes the pre-wipe total back so the existing increment path
 * carries on from there — after seeding 927, the next visit records 928.
 *
 * Only `totalVisitors` is seeded. `dailyVisits` stays as-is (empty after the
 * wipe): those per-day rows are real observations, and inventing a day's
 * worth of history would corrupt the stats/growth numbers on the dashboard.
 * The lost daily history simply starts accumulating again from today.
 *
 * Default mode SETS the total, so re-running is idempotent. Use --add only
 * if visits have already been recorded since the wipe and you want the
 * baseline added on top of them.
 *
 *   npx ts-node src/scripts/seedVisitorCount.ts --dry-run
 *   npx ts-node src/scripts/seedVisitorCount.ts
 *   npx ts-node src/scripts/seedVisitorCount.ts --count=1500
 *   npx ts-node src/scripts/seedVisitorCount.ts --add
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const add = process.argv.includes("--add");

  const countArg = process.argv.find((a) => a.startsWith("--count="));
  const baseline = countArg
    ? Number(countArg.split("=")[1])
    : DEFAULT_BASELINE;

  if (!Number.isInteger(baseline) || baseline < 0) {
    throw new Error(
      `--count must be a non-negative integer, got "${countArg?.split("=")[1]}"`,
    );
  }

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not configured");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle after connect");

  console.log(`${dryRun ? "[DRY RUN] " : ""}Database: ${db.databaseName}\n`);

  const existing = await VisitorModel.findOne();
  const current = existing ? existing.totalVisitors : 0;
  const next = add ? current + baseline : baseline;

  console.log(`  current totalVisitors : ${existing ? current : "(no document)"}`);
  console.log(`  mode                  : ${add ? "add" : "set"}`);
  console.log(`  new totalVisitors     : ${next}`);
  console.log(`  dailyVisits entries   : ${existing ? existing.dailyVisits.length : 0} (left untouched)`);

  if (dryRun) {
    console.log(`\n[DRY RUN] Nothing written.`);
    await mongoose.disconnect();
    return;
  }

  if (existing) {
    existing.totalVisitors = next;
    await existing.save();
  } else {
    await VisitorModel.create({
      totalVisitors: next,
      lastVisit: new Date(),
      dailyVisits: [],
    });
  }

  console.log(`\nVisitor counter seeded. Next visit will record ${next + 1}.`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("seedVisitorCount failed:", err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
