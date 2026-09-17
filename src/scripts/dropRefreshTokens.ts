import mongoose from "mongoose";
import dotenv from "dotenv";
import { ROLE_MODEL_LIST } from "../utils/roleModels";

dotenv.config();

/**
 * One-off cleanup: removes the leftover `refreshTokens` array from every
 * admin/staff account document.
 *
 * The refresh-token mechanism was deleted (single 200-day access token now,
 * no rotation, no server-side sessions), so the field is no longer declared
 * on any schema. Mongoose therefore ignores it, but the stored arrays — each
 * holding sha256 token hashes — stay on disk until unset. This script clears
 * them.
 *
 * Runs against the raw collections rather than the models on purpose: the
 * field is gone from the schemas, so a strict-mode Mongoose update would
 * silently strip the `$unset` path. Collection names are still taken from
 * ROLE_MODEL_LIST so this stays in sync if a role is ever added or renamed.
 *
 * Idempotent — a second run reports 0 documents.
 *
 *   npx ts-node src/scripts/dropRefreshTokens.ts --dry-run
 *   npx ts-node src/scripts/dropRefreshTokens.ts
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not configured");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle after connect");

  console.log(
    `${dryRun ? "[DRY RUN] " : ""}Database: ${db.databaseName}\n`,
  );

  let total = 0;

  for (const { role, model } of ROLE_MODEL_LIST) {
    const collection = db.collection(model.collection.name);
    const filter = { refreshTokens: { $exists: true } };

    const count = await collection.countDocuments(filter);
    total += count;

    if (count === 0) {
      console.log(`  ${role.padEnd(14)} ${model.collection.name.padEnd(16)} nothing to clear`);
      continue;
    }

    if (dryRun) {
      console.log(`  ${role.padEnd(14)} ${model.collection.name.padEnd(16)} ${count} document(s) would be cleared`);
      continue;
    }

    const result = await collection.updateMany(filter, {
      $unset: { refreshTokens: "" },
    });
    console.log(`  ${role.padEnd(14)} ${model.collection.name.padEnd(16)} cleared ${result.modifiedCount}/${count}`);
  }

  console.log(
    `\n${dryRun ? "[DRY RUN] " : ""}Total documents with a refreshTokens field: ${total}`,
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("dropRefreshTokens failed:", err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
