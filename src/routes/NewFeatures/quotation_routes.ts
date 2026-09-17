// routes/NewFeatures/quotation_routes.ts
import express from "express";
import { protect, authorize } from "../../middleware/authmiddleware";
import {
  createQuotation,
  getQuotations,
  getQuotationById,
  updateQuotation,
  deleteQuotation,
  bulkExpireQuotationsBeforeDate,
  getPublicQuotation,
} from "../../controllers/NewFeatures/quotation_controller";

const router = express.Router();

// Anonymous share-link read — must stay above router.use(protect) below.
router.get("/public/:quotationNo/:token", getPublicQuotation);

router.use(protect);
// Super-Admin included so bulkExpireQuotationsBeforeDate's body.branch path
// (and the isAdmin() branching already in getQuotations/getQuotationById/
// updateQuotation/deleteQuotation) is actually reachable.
// Staff included because the model, CREATOR_MODEL_MAP and createQuotation have
// always supported a Staff creator — only this guard kept them out. Staff is
// branch-scoped by getQuotations/canAccessBranch like the other branch roles.
router.use(authorize("Branch-Admin", "Super-Admin", "Staff"));

// The two destructive endpoints stay admin-only. Router-level middleware runs
// first, so these narrower lists are what actually reject a Staff caller.
const adminOnly = authorize("Branch-Admin", "Super-Admin");

router.post("/", createQuotation);
router.get("/", getQuotations);
// Literal path — must stay above the "/:id" routes below, or Express would
// match "bulk-expire" as an :id and hit updateQuotation instead.
router.patch("/bulk-expire", adminOnly, bulkExpireQuotationsBeforeDate);
router.get("/:id", getQuotationById);
router.patch("/:id", updateQuotation);
router.delete("/:id", adminOnly, deleteQuotation);

export default router;
