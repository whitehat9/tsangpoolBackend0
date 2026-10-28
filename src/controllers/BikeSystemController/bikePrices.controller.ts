import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import mongoose from "mongoose";
import BikeModel from "../../models/BikeSystemModel/Bikes";
import { getUserRole } from "../../types/user.types";
import logger from "../../utils/logger";

/**
 * Bike catalogue pricing for the "Add New Price" page. The catalogue is
 * shared: one ex-showroom price per model for every branch, the public site,
 * quotations and the sales-report price lookup — so a change here is global,
 * not branch-scoped. Only active models are listed and adjusted.
 *
 * Writes set onRoadPrice alongside exShowroomPrice. The model's pre-save hook
 * does that for save(), but these are plain updates (save() would also re-run
 * every unrelated validator and rewrite keySpecifications), so it is computed
 * here the same way: ex-showroom + RTO + insurance.
 */

type PriceAdjustMode = "percent" | "amount";

interface BikePriceDoc {
  _id: mongoose.Types.ObjectId;
  modelName: string;
  year: number;
  variants?: { name: string; priceAdjustment?: number }[];
  priceBreakdown: {
    exShowroomPrice: number;
    rtoCharges?: number;
    insuranceComprehensive?: number;
    onRoadPrice?: number;
  };
  updatedAt?: Date;
}

const PRICE_FIELDS =
  "modelName year variants.name variants.priceAdjustment priceBreakdown updatedAt";

/** Whole rupees, matching the client preview (Math.round both sides). */
function adjustedPrice(
  price: number,
  mode: PriceAdjustMode,
  value: number,
): number {
  return Math.round(mode === "percent" ? price * (1 + value / 100) : price + value);
}

function onRoadPrice(bike: BikePriceDoc, exShowroomPrice: number): number {
  const { rtoCharges = 0, insuranceComprehensive = 0 } = bike.priceBreakdown;
  return exShowroomPrice + rtoCharges + insuranceComprehensive;
}

function priceUpdate(bike: BikePriceDoc, exShowroomPrice: number) {
  return {
    $set: {
      "priceBreakdown.exShowroomPrice": exShowroomPrice,
      "priceBreakdown.onRoadPrice": onRoadPrice(bike, exShowroomPrice),
    },
  };
}

function toPriceRow(bike: BikePriceDoc) {
  return {
    _id: bike._id,
    modelName: bike.modelName,
    year: bike.year,
    exShowroomPrice: bike.priceBreakdown?.exShowroomPrice ?? 0,
    onRoadPrice: bike.priceBreakdown?.onRoadPrice ?? 0,
    variants: (bike.variants ?? []).map((v) => ({
      name: v.name,
      priceAdjustment: v.priceAdjustment ?? 0,
    })),
    updatedAt: bike.updatedAt,
  };
}

/**
 * @desc    Every active bike model with its price
 * @route   GET /api/bike-prices
 * @access  Super-Admin, Branch-Admin
 */
export const getBikePrices = asyncHandler(
  async (_req: Request, res: Response) => {
    const bikes = await BikeModel.find({ isActive: true })
      .select(PRICE_FIELDS)
      .sort({ modelName: 1, year: -1 })
      .lean<BikePriceDoc[]>();

    res.status(200).json({
      success: true,
      count: bikes.length,
      data: bikes.map(toPriceRow),
    });
  },
);

/**
 * @desc    Set one model's ex-showroom price
 * @route   PATCH /api/bike-prices/:id   body: { exShowroomPrice }
 * @access  Super-Admin, Branch-Admin
 */
export const updateBikePrice = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400);
      throw new Error("Invalid bike id");
    }

    const price = Number(req.body?.exShowroomPrice);
    if (!Number.isFinite(price) || price <= 0) {
      res.status(400);
      throw new Error("Ex-showroom price must be a positive number");
    }

    const bike = await BikeModel.findOne({ _id: id, isActive: true })
      .select(PRICE_FIELDS)
      .lean<BikePriceDoc>();
    if (!bike) {
      res.status(404);
      throw new Error("Bike model not found");
    }

    const newPrice = Math.round(price);
    await BikeModel.updateOne({ _id: id }, priceUpdate(bike, newPrice));

    logger.info(
      `Bike price set: ${bike.modelName} (${bike.year}) ${bike.priceBreakdown.exShowroomPrice} -> ${newPrice} by ${getUserRole(req.user!)} ${req.user!._id}`,
    );

    res.status(200).json({
      success: true,
      message: `${bike.modelName} price updated`,
      data: toPriceRow({
        ...bike,
        priceBreakdown: {
          ...bike.priceBreakdown,
          exShowroomPrice: newPrice,
          onRoadPrice: onRoadPrice(bike, newPrice),
        },
      }),
    });
  },
);

/**
 * @desc    Adjust every active model's price at once, by a percentage or a
 *          fixed amount (negative lowers). All-or-nothing on validation: if
 *          any model would end at zero or below, nothing is written.
 * @route   POST /api/bike-prices/bulk-adjust   body: { mode: "percent" | "amount", value }
 * @access  Super-Admin, Branch-Admin
 */
export const bulkAdjustBikePrices = asyncHandler(
  async (req: Request, res: Response) => {
    const mode = req.body?.mode as PriceAdjustMode;
    const value = Number(req.body?.value);

    if (mode !== "percent" && mode !== "amount") {
      res.status(400);
      throw new Error('mode must be "percent" or "amount"');
    }
    if (!Number.isFinite(value) || value === 0) {
      res.status(400);
      throw new Error("Enter a non-zero value");
    }

    const bikes = await BikeModel.find({ isActive: true })
      .select(PRICE_FIELDS)
      .lean<BikePriceDoc[]>();
    if (bikes.length === 0) {
      res.status(404);
      throw new Error("No active bike models to update");
    }

    const changes = bikes.map((bike) => ({
      bike,
      from: bike.priceBreakdown?.exShowroomPrice ?? 0,
      to: adjustedPrice(bike.priceBreakdown?.exShowroomPrice ?? 0, mode, value),
    }));

    const invalid = changes.find((c) => c.to <= 0);
    if (invalid) {
      res.status(400);
      throw new Error(
        `${invalid.bike.modelName} would drop to ₹${invalid.to} — no prices were changed`,
      );
    }

    const result = await BikeModel.bulkWrite(
      changes.map(({ bike, to }) => ({
        updateOne: { filter: { _id: bike._id }, update: priceUpdate(bike, to) },
      })),
    );

    logger.info(
      `Bike prices bulk-adjusted (${mode} ${value}) on ${changes.length} models by ${getUserRole(req.user!)} ${req.user!._id}`,
    );

    res.status(200).json({
      success: true,
      message: `Updated ${result.modifiedCount} of ${changes.length} model prices`,
      data: {
        mode,
        value,
        modified: result.modifiedCount,
        changes: changes.map(({ bike, from, to }) => ({
          _id: bike._id,
          modelName: bike.modelName,
          year: bike.year,
          from,
          to,
        })),
      },
    });
  },
);
