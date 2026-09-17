import mongoose from "mongoose";
import dotenv from "dotenv";
import Admin from "../models/Admin";

dotenv.config();

const DEFAULT_NAME = "Honda-Golaghat";
const DEFAULT_EMAIL = "honda_golaghat@gmail.com";
const DEFAULT_PASSWORD = "admin123";

/**
 * One-off seed: recreates the Super-Admin account after the database was
 * wiped, so there is a way back into the admin area.
 *
 * Same account the existing `POST /api/auth/seed` route creates
 * (`AdminPrivilege/seeder.ts`), but runnable from a terminal: that route is
 * only registered when NODE_ENV === "development", so it does not exist on
 * the deployed Cloud Run revision and cannot be used to recover production.
 *
 * The password is hashed by the Admin schema's pre-save hook, so it must be
 * assigned and saved through the model — never written straight to the
 * collection, or login's bcrypt compare will always fail.
 *
 * Safe by default: if the account already exists it is left untouched and
 * reported. Use --reset-password to overwrite the password of an existing
 * account (the recovery case where the account survived but the password is
 * unknown).
 *
 *   npx ts-node src/scripts/seedSuperAdmin.ts --dry-run
 *   npx ts-node src/scripts/seedSuperAdmin.ts
 *   npx ts-node src/scripts/seedSuperAdmin.ts --email=you@example.com --password='…'
 *   npx ts-node src/scripts/seedSuperAdmin.ts --reset-password --password='…'
 */
function arg(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : undefined;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const resetPassword = process.argv.includes("--reset-password");

  const name = arg("name") ?? DEFAULT_NAME;
  const email = (arg("email") ?? DEFAULT_EMAIL).toLowerCase().trim();
  const password =
    arg("password") ?? process.env.SEED_ADMIN_PASSWORD ?? DEFAULT_PASSWORD;
  const usingDefaultPassword = password === DEFAULT_PASSWORD;

  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters (schema minimum)");
  }

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not configured");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle after connect");

  console.log(`${dryRun ? "[DRY RUN] " : ""}Database: ${db.databaseName}\n`);

  const total = await Admin.countDocuments();
  const existing = await Admin.findOne({ email });

  console.log(`  admin documents : ${total}`);
  console.log(`  name            : ${name}`);
  console.log(`  email           : ${email}`);
  console.log(`  role            : Super-Admin`);
  console.log(
    `  password        : ${usingDefaultPassword ? `"${DEFAULT_PASSWORD}" (default — change it after logging in)` : "(supplied)"}`,
  );
  console.log(
    `  action          : ${
      existing
        ? resetPassword
          ? "account exists -> reset password"
          : "account exists -> leave untouched (pass --reset-password to overwrite)"
        : "create account"
    }\n`,
  );

  if (dryRun) {
    console.log("[DRY RUN] Nothing written.");
    await mongoose.disconnect();
    return;
  }

  if (existing) {
    if (!resetPassword) {
      console.log("Super-Admin already exists. Nothing to do.");
      await mongoose.disconnect();
      return;
    }
    existing.password = password;
    existing.isActive = true;
    await existing.save();
    console.log(`Password reset for ${existing.email}.`);
  } else {
    const admin = await Admin.create({
      name,
      email,
      password,
      role: "Super-Admin",
    });
    console.log(`Super-Admin created: ${admin.email}`);
  }

  console.log("Log in at the Super-Admin login screen with that email + password.");

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("seedSuperAdmin failed:", err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
