import mongoose from "mongoose";
import dotenv from "dotenv";
import BikeModel from "../models/BikeSystemModel/Bikes";

dotenv.config();

/**
 * Seeds the `bikes` catalogue with the current Honda line-up sold at Golaghat.
 *
 * The collection was empty, so every customer-facing catalogue page (ViewAllBikes,
 * BikeCard, CompareBike, EmiCalculator) had nothing to render. This writes the 13
 * models the dealership lists, priced for Golaghat, Assam.
 *
 * ── Where the prices come from ────────────────────────────────────────────────
 * Ex-showroom is the authoritative figure here; `onRoadPrice` is NOT stored by
 * this script — the pre-save hook on BikesSchema derives it as
 * exShowroom + rtoCharges + insuranceComprehensive.
 *
 * Three ex-showroom values were verified against this dealership's own sold units
 * in `salesreports` (whose "Booking Total" column is an EX-SHOWROOM figure, not an
 * on-road one — Activa STD 81,787.85, Activa DLX 92,315.73, Dio STD 77,891.99 all
 * match the published Golaghat ex-showroom to the rupee). Those are marked
 * `verified: "db"` below. The rest are published Golaghat figures, marked "web".
 *
 * Two models publish only a total on-road price, so their split is back-solved
 * from the base variant's own RTO rate and insurance — see `derivedFromOnRoad()`.
 * They are marked `verified: "derived"` and should be corrected from a real
 * dealer price list when one is to hand.
 *
 * ── Colours ───────────────────────────────────────────────────────────────────
 * Dealer stock stores colours as 20-character DMS truncations ("MAT AXIS GRAY
 * METALL", "PRL IGNS BLK+BLK"). Those are internal codes, not customer-facing, so
 * the catalogue carries the expanded official names instead. Every expansion used
 * here was confirmed against a published colour list, not guessed.
 *
 *   npx ts-node src/scripts/seedBikeCatalogue.ts --dry-run
 *   npx ts-node src/scripts/seedBikeCatalogue.ts
 *   npx ts-node src/scripts/seedBikeCatalogue.ts --force
 */

const YEAR = 2026;

type Verified = "db" | "web" | "derived";

interface SeedBike {
  modelName: string;
  mainCategory: "bike" | "scooter";
  category: string;
  engineSize: string;
  power: number;
  transmission: string;
  exShowroomPrice: number;
  rtoCharges: number;
  insuranceComprehensive: number;
  verified: Verified;
  colors: string[];
  features: string[];
  variants: { name: string; priceAdjustment: number; features: string[] }[];
  isNewModel?: boolean;
}

/**
 * Back-solve an ex-showroom / RTO split from a published on-road total.
 *
 * Assam RTO is charged as a percentage of ex-showroom, so the base variant's own
 * rate is the best available estimate for its siblings. Insurance barely moves
 * across variants of one model, so it is carried across unchanged.
 *
 *   ex * (1 + rtoRate) + insurance = onRoad
 */
function derivedFromOnRoad(
  onRoad: number,
  rtoRate: number,
  insurance: number,
): { exShowroomPrice: number; rtoCharges: number } {
  const ex = Math.round((onRoad - insurance) / (1 + rtoRate));
  return { exShowroomPrice: ex, rtoCharges: onRoad - insurance - ex };
}

const SHINE_100_RTO_RATE = 5521 / 67010; // 8.239%
const SHINE_125_RTO_RATE = 8411 / 86383; // 9.737%

const shine100Dx = derivedFromOnRoad(86810, SHINE_100_RTO_RATE, 5438);
const shine125Ltd = derivedFromOnRoad(105994, SHINE_125_RTO_RATE, 5521);

const COMMUTER_FEATURES = [
  "LED headlamp",
  "Digital-analogue console",
  "Combi Brake System",
  "Silent start ACG",
];

const SCOOTER_FEATURES = [
  "Combi Brake System",
  "External fuel filler cap",
  "Under-seat storage",
  "Silent start ACG",
];

const BIKES: SeedBike[] = [
  // ── Motorcycles ─────────────────────────────────────────────────────────────
  {
    modelName: "Shine 100",
    mainCategory: "bike",
    category: "commuter",
    engineSize: "98.98 cc",
    power: 7.28,
    transmission: "4-Speed Manual",
    exShowroomPrice: 67010,
    rtoCharges: 5521,
    insuranceComprehensive: 5438,
    verified: "web",
    colors: [
      "Black with Orange",
      "Black with Green",
      "Black with Grey",
      "Black with Blue",
      "Black with Red",
      "Geny Grey Metallic",
      "Athletic Blue Metallic",
      "Pearl Igneous Black",
      "Imperial Red Metallic",
    ],
    features: COMMUTER_FEATURES,
    variants: [{ name: "Standard", priceAdjustment: 0, features: ["Drum brakes", "Alloy wheels"] }],
  },
  {
    modelName: "Shine 100 DX",
    mainCategory: "bike",
    category: "commuter",
    engineSize: "98.98 cc",
    power: 7.28,
    transmission: "4-Speed Manual",
    exShowroomPrice: shine100Dx.exShowroomPrice,
    rtoCharges: shine100Dx.rtoCharges,
    insuranceComprehensive: 5438,
    verified: "derived",
    colors: [
      "Black with Orange",
      "Black with Green",
      "Black with Blue",
      "Geny Grey Metallic",
      "Athletic Blue Metallic",
      "Pearl Igneous Black",
    ],
    features: [...COMMUTER_FEATURES, "Fully digital console", "Tubeless tyres"],
    variants: [{ name: "DX", priceAdjustment: 0, features: ["Drum brakes", "Alloy wheels", "Digital console"] }],
    isNewModel: true,
  },
  {
    modelName: "Livo",
    mainCategory: "bike",
    category: "commuter",
    engineSize: "109.51 cc",
    power: 8.79,
    transmission: "4-Speed Manual",
    exShowroomPrice: 83992,
    rtoCharges: 8219,
    insuranceComprehensive: 5605,
    verified: "web",
    colors: [
      "Pearl Siren Blue",
      "Pearl Igneous Black with Blue Stripes",
      "Pearl Igneous Black with Orange Stripes",
    ],
    features: COMMUTER_FEATURES,
    variants: [
      { name: "Drum", priceAdjustment: 0, features: ["Drum brakes", "Alloy wheels"] },
      { name: "Disc", priceAdjustment: 2450, features: ["Disc brakes", "Alloy wheels"] },
    ],
  },
  {
    modelName: "Shine 125",
    mainCategory: "bike",
    category: "commuter",
    engineSize: "123.94 cc",
    power: 10.59,
    transmission: "5-Speed Manual",
    exShowroomPrice: 86383,
    rtoCharges: 8411,
    insuranceComprehensive: 5521,
    verified: "web",
    colors: [
      "Pearl Siren Blue",
      "Pearl Igneous Black",
      "Decent Blue Metallic",
      "Geny Grey Metallic",
      "Matte Axis Grey Metallic",
      "Rebel Red Metallic",
    ],
    features: COMMUTER_FEATURES,
    variants: [
      { name: "Drum", priceAdjustment: 0, features: ["Drum brakes", "Alloy wheels"] },
      { name: "Disc", priceAdjustment: 4190, features: ["Disc brakes", "Alloy wheels"] },
    ],
  },
  {
    modelName: "Shine 125 Limited Edition",
    mainCategory: "bike",
    category: "commuter",
    engineSize: "123.94 cc",
    power: 10.59,
    transmission: "5-Speed Manual",
    exShowroomPrice: shine125Ltd.exShowroomPrice,
    rtoCharges: shine125Ltd.rtoCharges,
    insuranceComprehensive: 5521,
    verified: "derived",
    colors: ["Pearl Siren Blue - Limited Edition"],
    features: [...COMMUTER_FEATURES, "Bronze alloy wheels", "Limited Edition graphics"],
    variants: [
      { name: "Limited Edition", priceAdjustment: 0, features: ["Disc brakes", "Bronze alloy wheels"] },
    ],
    isNewModel: true,
  },
  {
    modelName: "SP125",
    mainCategory: "bike",
    category: "commuter",
    engineSize: "123.94 cc",
    power: 10.72,
    transmission: "5-Speed Manual",
    exShowroomPrice: 91764,
    rtoCharges: 8841,
    insuranceComprehensive: 5412,
    verified: "web",
    colors: [
      "Matte Marvel Blue Metallic",
      "Black",
      "Pearl Siren Blue",
      "Matte Axis Grey Metallic",
      "Imperial Red Metallic",
    ],
    features: [...COMMUTER_FEATURES, "Fully digital console", "Side-stand engine inhibitor"],
    variants: [
      { name: "Drum", priceAdjustment: 0, features: ["Drum brakes", "Alloy wheels"] },
      // DB-verified: SP125 DLX DISK sold at ex-showroom 99,350.93 in Golaghat.
      { name: "Disc", priceAdjustment: 7587, features: ["Disc brakes", "Alloy wheels"] },
    ],
  },
  {
    modelName: "CB125 Hornet",
    mainCategory: "bike",
    category: "naked",
    engineSize: "123.94 cc",
    power: 11,
    transmission: "5-Speed Manual",
    exShowroomPrice: 115485,
    rtoCharges: 9238,
    insuranceComprehensive: 6744,
    verified: "web",
    colors: [
      "Pearl Igneous Black",
      "Pearl Siren Blue with Lemon Ice Yellow",
      "Pearl Siren Blue with Sports Red",
      "Pearl Siren Blue with Athletic Blue Metallic",
    ],
    features: [
      "Full LED lighting",
      "5-inch TFT display",
      "Bluetooth connectivity",
      "Dual-channel ABS",
      "USD front forks",
    ],
    variants: [{ name: "Standard", priceAdjustment: 0, features: ["Disc brakes", "Alloy wheels"] }],
    isNewModel: true,
  },
  {
    modelName: "Unicorn",
    mainCategory: "bike",
    category: "commuter",
    engineSize: "162.71 cc",
    power: 12.73,
    transmission: "5-Speed Manual",
    exShowroomPrice: 117517,
    rtoCharges: 10901,
    insuranceComprehensive: 11662,
    verified: "web",
    // Only "P BLACK" appears in Golaghat stock; other factory colours unconfirmed.
    colors: ["Black"],
    features: [...COMMUTER_FEATURES, "Single-channel ABS", "Tubeless tyres"],
    variants: [{ name: "Standard", priceAdjustment: 0, features: ["Disc brakes", "Alloy wheels"] }],
  },

  // ── Scooters ────────────────────────────────────────────────────────────────
  {
    modelName: "Activa 110",
    mainCategory: "scooter",
    category: "automatic",
    engineSize: "109.51 cc",
    power: 7.79,
    transmission: "CVT Automatic",
    exShowroomPrice: 81788,
    rtoCharges: 6543,
    insuranceComprehensive: 6102,
    verified: "db",
    colors: [
      "Matte Axis Grey Metallic",
      "Black",
      "Pearl Siren Blue",
      "Pearl Precious White",
      "Rebel Red Metallic",
      "Decent Blue Metallic",
    ],
    features: SCOOTER_FEATURES,
    variants: [
      { name: "STD", priceAdjustment: 0, features: ["Drum brakes", "Steel wheels"] },
      // DB-verified: ACTIVA DLX-OBD2B sold at ex-showroom 92,315.73 in Golaghat.
      { name: "DLX", priceAdjustment: 10528, features: ["Drum brakes", "Alloy wheels"] },
      { name: "H-Smart", priceAdjustment: 14081, features: ["Smart key", "Alloy wheels"] },
    ],
  },
  {
    modelName: "Activa 110 Anniversary Edition",
    mainCategory: "scooter",
    category: "automatic",
    engineSize: "109.51 cc",
    power: 7.79,
    transmission: "CVT Automatic",
    exShowroomPrice: 91044,
    rtoCharges: 7283,
    insuranceComprehensive: 6279,
    verified: "web",
    colors: ["Matte Steel Black Metallic"],
    features: [...SCOOTER_FEATURES, "25-Year Anniversary badging", "Chrome accents"],
    variants: [
      { name: "25-Year Anniversary Edition", priceAdjustment: 0, features: ["Alloy wheels", "Anniversary badging"] },
    ],
    isNewModel: true,
  },
  {
    modelName: "Dio 110",
    mainCategory: "scooter",
    category: "automatic",
    engineSize: "109.51 cc",
    power: 7.76,
    transmission: "CVT Automatic",
    exShowroomPrice: 77892,
    rtoCharges: 7731,
    insuranceComprehensive: 5981,
    verified: "db",
    colors: [
      "Pearl Igneous Black",
      "Pearl Igneous Black with Grey Stripes",
      "Matte Axis Grey Metallic",
      "Matte Marvel Blue Metallic",
    ],
    features: [...SCOOTER_FEATURES, "Fully digital console", "LED headlamp"],
    variants: [
      { name: "STD", priceAdjustment: 0, features: ["Drum brakes", "Steel wheels"] },
      // DB-verified: DIO DLX-OBD2B sold at ex-showroom 90,194.55 in Golaghat.
      { name: "DLX", priceAdjustment: 12303, features: ["Drum brakes", "Alloy wheels"] },
    ],
  },
  {
    modelName: "Activa 125",
    mainCategory: "scooter",
    category: "automatic",
    engineSize: "123.92 cc",
    power: 8.29,
    transmission: "CVT Automatic",
    // DB-verified: ACTIVA 125 DISC OBD2B sold at ex-showroom 97,667.96 in Golaghat.
    exShowroomPrice: 97668,
    rtoCharges: 9314,
    insuranceComprehensive: 5759,
    verified: "db",
    colors: [
      "Matte Axis Grey Metallic",
      "Black",
      "Pearl Siren Blue",
      "Pearl Precious White",
      "Rebel Red Metallic",
    ],
    features: [...SCOOTER_FEATURES, "LED headlamp", "Digital console"],
    variants: [
      { name: "DLX", priceAdjustment: 0, features: ["Disc brakes", "Alloy wheels"] },
      { name: "H-Smart", priceAdjustment: 4877, features: ["Smart key", "Disc brakes", "Alloy wheels"] },
    ],
  },
  {
    modelName: "Dio 125",
    mainCategory: "scooter",
    category: "automatic",
    engineSize: "123.92 cc",
    power: 8.29,
    transmission: "CVT Automatic",
    exShowroomPrice: 92253,
    rtoCharges: 8880,
    insuranceComprehensive: 5756,
    verified: "web",
    colors: [
      "Pearl Deep Ground Grey",
      "Imperial Red Metallic",
      "Pearl Igneous Black",
      "Pearl Sports Yellow",
      "Matte Marvel Blue Metallic",
      "Matte Sangria Red Metallic",
      "Pearl Siren Blue with Pearl Deep Ground Grey",
    ],
    features: [...SCOOTER_FEATURES, "Fully digital console", "LED headlamp"],
    variants: [
      { name: "X Edition", priceAdjustment: 0, features: ["Disc brakes", "Alloy wheels"] },
      { name: "STD", priceAdjustment: 406, features: ["Disc brakes", "Alloy wheels"] },
      { name: "H-Smart", priceAdjustment: 5757, features: ["Smart key", "Disc brakes", "Alloy wheels"] },
    ],
  },
];

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");

  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.name}\n`);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const b of BIKES) {
    const doc = {
      modelName: b.modelName,
      mainCategory: b.mainCategory,
      category: b.category,
      year: YEAR,
      variants: b.variants,
      priceBreakdown: {
        exShowroomPrice: b.exShowroomPrice,
        rtoCharges: b.rtoCharges,
        insuranceComprehensive: b.insuranceComprehensive,
      },
      engineSize: b.engineSize,
      power: b.power,
      transmission: b.transmission,
      fuelNorms: "BS6 Phase 2" as const,
      isE20Efficiency: true,
      features: b.features,
      colors: b.colors,
      stockAvailable: 0,
      isNewModel: b.isNewModel ?? false,
      isActive: true,
    };

    const onRoad =
      b.exShowroomPrice + b.rtoCharges + b.insuranceComprehensive;
    const label = `${b.modelName.padEnd(32)} ex ${b.exShowroomPrice
      .toLocaleString("en-IN")
      .padStart(9)}  on-road ${onRoad.toLocaleString("en-IN").padStart(9)}  [${b.verified}]`;

    if (dryRun) {
      console.log(`would seed  ${label}`);
      continue;
    }

    const existing = await BikeModel.findOne({
      modelName: b.modelName,
      year: YEAR,
    });

    if (existing && !force) {
      console.log(`skip        ${label}  (already present, use --force)`);
      skipped += 1;
      continue;
    }

    if (existing) {
      existing.set(doc);
      await existing.save(); // pre-save hook recomputes onRoadPrice
      console.log(`updated     ${label}`);
      updated += 1;
    } else {
      await new BikeModel(doc).save();
      console.log(`created     ${label}`);
      created += 1;
    }
  }

  if (!dryRun) {
    console.log(
      `\nDone. created=${created} updated=${updated} skipped=${skipped}`,
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
