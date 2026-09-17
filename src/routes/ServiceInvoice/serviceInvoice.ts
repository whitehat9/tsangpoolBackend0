import express from "express";
import { protect, authorize } from "../../middleware/authmiddleware";
import { partsReportConfig, handleMulterError } from "../../config/multerConfig";
import {
  previewServiceInvoice,
  importServiceInvoice,
} from "../../controllers/ServiceInvoice/serviceInvoiceUpload.controller";
import {
  getServiceInvoiceStats,
  getAllServiceInvoices,
  getServiceInvoiceLineItems,
  getEffectiveStockStatus,
  getServiceInvoiceById,
} from "../../controllers/ServiceInvoice/serviceInvoiceStats.controller";
import { getServiceInvoiceTimeseries } from "../../controllers/ServiceInvoice/serviceInvoiceTimeseries.controller";
import { markLineAsAccessory } from "../../controllers/ServiceInvoice/serviceInvoiceClassify.controller";
import {
  deleteServiceInvoice,
  getDeletedServiceInvoices,
} from "../../controllers/ServiceInvoice/serviceInvoiceDelete.controller";

const router = express.Router();

router.use(protect);

// ─── Upload ────────────────────────────────────────────────────────────────
// Two-step: /preview parses and classifies without writing, /commit persists.
const UPLOAD_ROLES = ["Part-Admin", "Super-Admin", "Service-Admin"] as const;

router.post(
  "/preview",
  authorize(...UPLOAD_ROLES),
  partsReportConfig.single("file"),
  handleMulterError,
  previewServiceInvoice,
);

router.post(
  "/commit",
  authorize(...UPLOAD_ROLES),
  partsReportConfig.single("file"),
  handleMulterError,
  importServiceInvoice,
);

// ─── Reads ─────────────────────────────────────────────────────────────────
const READ_ROLES = [
  "Part-Admin",
  "Super-Admin",
  "Service-Admin",
  "Branch-Admin",
] as const;

router.get("/stats", authorize(...READ_ROLES), getServiceInvoiceStats);
router.get("/line-items", authorize(...READ_ROLES), getServiceInvoiceLineItems);
router.get(
  "/effective-stock",
  authorize(...READ_ROLES),
  getEffectiveStockStatus,
);
router.get(
  "/sales/timeseries",
  authorize(...READ_ROLES),
  getServiceInvoiceTimeseries,
);
router.get("/deleted", authorize("Super-Admin"), getDeletedServiceInvoices);

// Manual escape hatch for a pending line whose part is never stocked.
// Literal path, so it must stay above the /:id catch-all below.
router.patch(
  "/line-items/:lineItemId/accessory",
  authorize("Super-Admin", "Part-Admin", "Service-Admin"),
  markLineAsAccessory,
);

// ─── Delete ────────────────────────────────────────────────────────────────
router.delete(
  "/:invoiceId",
  authorize("Super-Admin", "Part-Admin"),
  deleteServiceInvoice,
);

// ─── Catch-alls ────────────────────────────────────────────────────────────
// IMPORTANT: these two must stay last. `/:id` would otherwise swallow every
// literal path above and answer with a domain 404 ("Service invoice not
// found") instead of a real one — the exact failure mode CLAUDE.md documents
// for the ~19 other routers that end in a generic /:id.
router.get("/:id", authorize(...READ_ROLES), getServiceInvoiceById);
router.get("/", authorize(...READ_ROLES), getAllServiceInvoices);

export default router;
