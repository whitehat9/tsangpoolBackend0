import express from "express";
import {
  bulkAdjustBikePrices,
  getBikePrices,
  updateBikePrice,
} from "../../controllers/BikeSystemController/bikePrices.controller";
import { authorize, protect } from "../../middleware/authmiddleware";

// Bike catalogue pricing ("Add New Price" page). Kept off /api/bikes, whose
// public GET /:id catch-all would swallow a literal path registered after it.
const router = express.Router();

router.use(protect, authorize("Super-Admin", "Branch-Admin"));

router.get("/", getBikePrices);
router.post("/bulk-adjust", bulkAdjustBikePrices);
router.patch("/:id", updateBikePrice);

export default router;
