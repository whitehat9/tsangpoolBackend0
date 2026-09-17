import mongoose from "mongoose";
import dotenv from "dotenv";
import BikeModel from "../models/BikeSystemModel/Bikes";
import BikeImageModel from "../models/BikeSystemModel/BikeImageModel";

dotenv.config();

/**
 * Attaches the catalogue photography to the models seeded by seedBikeCatalogue.ts,
 * and sets an opening stock figure on each.
 *
 * The images are already hosted on Cloudinary as AVIF. `cloudinaryPublicId` is the
 * path segment after the version prefix with the extension stripped — the same id
 * the delete path in the image controllers passes to `cloudinary.uploader.destroy`,
 * so these rows can be managed from the admin UI like any uploaded image.
 *
 * Note: "Shine 125 Limited Edition" has no image URL, so it is skipped here and
 * will render with whatever placeholder the frontend uses for an imageless bike.
 * Its stock is still set.
 *
 *   npx ts-node src/scripts/seedBikeImages.ts --dry-run
 *   npx ts-node src/scripts/seedBikeImages.ts
 *   npx ts-node src/scripts/seedBikeImages.ts --force
 */

const YEAR = 2026;
const OPENING_STOCK = 12;

const CLOUDINARY_BASE = "https://res.cloudinary.com/nhluwr6s/image/upload";

/** modelName (as seeded) -> [cloudinary version, public id] */
const IMAGES: Record<string, [string, string]> = {
  "Shine 100": ["v1789595306", "shine100-get-to-know-your-ride_hshmbm"],
  "Shine 100 DX": ["v1789595306", "Shine-100-DX_puoiys"],
  Livo: ["v1789595304", "Livo_frmvys"],
  "Shine 125": ["v1789595299", "ShineEXT_iw0hac"],
  SP125: ["v1789595305", "sp123_v7zeoq"],
  "CB125 Hornet": ["v1789595301", "hornet_kbw8ae"],
  Unicorn: ["v1789595301", "unicorn_rrndst"],
  "Activa 110": ["v1789595301", "activa110_nmakhd"],
  // Supplied asset is named activaPro125 — kept as given, but the filename does
  // not match the model it is attached to. Worth re-checking against the source.
  "Activa 110 Anniversary Edition": ["v1789595299", "activaPro125_pxpnjl"],
  "Dio 110": ["v1789595299", "dio110_oycizu"],
  "Activa 125": ["v1789595299", "activa125_r4ih7v"],
  "Dio 125": ["v1789595298", "dio125_cjdpcj"],
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");

  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.name}\n`);

  const bikes = await BikeModel.find({ year: YEAR });
  if (bikes.length === 0) {
    throw new Error(
      `No bikes found for year ${YEAR}. Run seedBikeCatalogue.ts first.`,
    );
  }

  let imagesCreated = 0;
  let imagesSkipped = 0;
  let stockUpdated = 0;

  for (const bike of bikes) {
    const entry = IMAGES[bike.modelName];

    // ── Stock ────────────────────────────────────────────────────────────────
    if (!dryRun && bike.stockAvailable !== OPENING_STOCK) {
      bike.stockAvailable = OPENING_STOCK;
      await bike.save();
      stockUpdated += 1;
    }

    if (!entry) {
      console.log(
        `no image    ${bike.modelName.padEnd(32)} stock=${OPENING_STOCK}`,
      );
      continue;
    }

    const [version, publicId] = entry;
    const src = `${CLOUDINARY_BASE}/${version}/${publicId}.avif`;
    const alt = `Honda ${bike.modelName} — ${bike.mainCategory} available at TsangPool Honda, Golaghat`;

    if (dryRun) {
      console.log(
        `would link  ${bike.modelName.padEnd(32)} stock=${OPENING_STOCK}  ${publicId}`,
      );
      continue;
    }

    const existing = await BikeImageModel.findOne({
      bikeId: bike._id,
      cloudinaryPublicId: publicId,
    });

    if (existing && !force) {
      console.log(
        `skip image  ${bike.modelName.padEnd(32)} stock=${OPENING_STOCK}  (already linked)`,
      );
      imagesSkipped += 1;
      continue;
    }

    if (existing) {
      existing.set({ src, alt, isPrimary: true, isActive: true });
      await existing.save();
      console.log(
        `updated     ${bike.modelName.padEnd(32)} stock=${OPENING_STOCK}  ${publicId}`,
      );
    } else {
      await BikeImageModel.create({
        bikeId: bike._id,
        src,
        alt,
        cloudinaryPublicId: publicId,
        isPrimary: true,
        isActive: true,
      });
      console.log(
        `linked      ${bike.modelName.padEnd(32)} stock=${OPENING_STOCK}  ${publicId}`,
      );
      imagesCreated += 1;
    }
  }

  if (!dryRun) {
    console.log(
      `\nDone. images created=${imagesCreated} skipped=${imagesSkipped}, stock updated on ${stockUpdated} bikes`,
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
