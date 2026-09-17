import express from "express";
import { protect, authorize } from "../../middleware/authmiddleware";
import { partsReportConfig, handleMulterError } from "../../config/multerConfig";
import { importPartsReport } from "../../controllers/Parts/partsUpload.controller";
import {
  getPartsStats,
  getAllParts,
  getPartsBatches,
  getPartsBatchesByDate,
  getPartsStockStatus,
} from "../../controllers/Parts/partsStats.controller";
import { deletePartsBatch } from "../../controllers/Parts/partsBatchDelete.controller";
import { askPartsAi } from "../../controllers/Parts/partsAi.controller";

const router = express.Router();

router.use(protect);

// Upload a parts report (XLSX / CSV / PDF)
router.post(
  "/import",
  authorize("Part-Admin", "Super-Admin"),
  partsReportConfig.single("file"),
  handleMulterError,
  importPartsReport,
);

// Stats + lists (Part-Admin scoped to own branch; Super-Admin all or ?branchId=)
router.get("/stats", authorize("Part-Admin", "Super-Admin"), getPartsStats);
router.get("/batches", authorize("Part-Admin", "Super-Admin"), getPartsBatches);

// Registered alongside /batches; both are literal paths so ordering between
// them is not load-bearing, but keep it above the catch-all "/" below.
router.get(
  "/batches/by-date",
  authorize("Part-Admin", "Super-Admin"),
  getPartsBatchesByDate,
);
router.get(
  "/stock-status",
  authorize("Part-Admin", "Super-Admin"),
  getPartsStockStatus,
);

// Reverse a bad upload — Super-Admin (any branch), Part-Admin (own branch).
// Parameterized, so it sits below every literal /batches/* path. DELETE is the
// only verb here, but keeping the literal-first order matches the rest of the
// file and survives someone later adding a GET on the same pattern.
router.delete(
  "/batches/:batchId",
  authorize("Part-Admin", "Super-Admin"),
  deletePartsBatch,
);

// AI assistant (Super-Admin only)
router.post("/ai", authorize("Super-Admin"), askPartsAi);

// Paginated list — keep last so it doesn't shadow the specific routes above
router.get("/", authorize("Part-Admin", "Super-Admin"), getAllParts);

export default router;
