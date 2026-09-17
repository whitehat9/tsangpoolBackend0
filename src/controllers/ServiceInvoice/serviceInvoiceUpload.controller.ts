import { Request, Response } from "express";
import mongoose from "mongoose";
import { isAdmin, getUserBranch } from "../../types/user.types";
import logger from "../../utils/logger";
import { notify } from "../../service/pushNotification.service";
import { NotificationEvents } from "../../service/notificationTargeting";
import { InvoicePdfParseError } from "../../service/serviceInvoice/invoicePdfExtractor";
import {
  previewInvoice,
  commitInvoice,
} from "../../service/serviceInvoice/importInvoice.service";

/**
 * Resolve which branch this upload belongs to.
 * - Branch-scoped roles (Part-Admin / Service-Admin): always their own branch.
 * - Super-Admin: must pass a branchId (body or query).
 *
 * Mirrors resolveBranchId in controllers/Parts/partsUpload.controller.ts.
 */
function resolveBranchId(req: Request): string | null {
  if (req.user && isAdmin(req.user)) {
    const fromReq =
      (req.body?.branchId as string) || (req.query?.branchId as string);
    return fromReq || null;
  }
  const branch = req.user ? getUserBranch(req.user) : null;
  return branch ? branch.toString() : null;
}

function badBranch(res: Response): void {
  res.status(400).json({
    success: false,
    message:
      "A branch is required. Super-Admin must supply branchId; other roles must belong to a branch.",
  });
}

/** Translate extractor failures into a 400 the uploader can act on. */
function handleParseError(err: any, res: Response, fileName: string): boolean {
  if (err instanceof InvoicePdfParseError) {
    logger.warn(`Service invoice parse failed for ${fileName}: ${err.message}`);
    res.status(400).json({ success: false, message: err.message });
    return true;
  }
  return false;
}

/**
 * @desc    Parse a service invoice PDF and return what WOULD be imported,
 *          without writing anything. Backs the confirm step in the UI.
 * @route   POST /api/service-invoice/preview
 * @access  Part-Admin, Service-Admin, Super-Admin
 */
export async function previewServiceInvoice(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: "No file uploaded" });
      return;
    }

    const branchId = resolveBranchId(req);
    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
      badBranch(res);
      return;
    }

    const preview = await previewInvoice(req.file.buffer, branchId);

    res.status(200).json({
      success: true,
      data: {
        duplicate: preview.duplicate,
        existingInvoiceId: preview.existingInvoiceId,
        fileName: req.file.originalname,
        header: preview.parsed.header,
        customer: preview.parsed.parties,
        totals: preview.parsed.totals,
        reconciliation: preview.parsed.reconciliation,
        needsReview: preview.parsed.needsReview,
        reviewReasons: preview.parsed.reviewReasons,
        lineItems: preview.classification.lineItems,
        summary: preview.classification.summary,
        revenue: preview.classification.revenue,
      },
    });
  } catch (err: any) {
    if (handleParseError(err, res, req.file?.originalname || "upload")) return;
    logger.error(`previewServiceInvoice failed: ${err?.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to read the invoice PDF",
      error: err?.message,
    });
  }
}

/**
 * @desc    Import a service invoice PDF: store the invoice + line items,
 *          record parts consumption, and roll the spend up onto the vehicle.
 *          A re-upload of an invoice number already on record is a no-op.
 * @route   POST /api/service-invoice/commit
 * @access  Part-Admin, Service-Admin, Super-Admin
 */
export async function importServiceInvoice(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: "No file uploaded" });
      return;
    }

    const branchId = resolveBranchId(req);
    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
      badBranch(res);
      return;
    }

    const result = await commitInvoice({
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      branchId,
      uploadedBy: (req.user as any)._id,
      uploadedByRole: (req.user as any).role,
    });

    if (result.duplicate) {
      // Already on record — same contract the parts/jobcard importers use for
      // a no-change upload: 200, nothing written.
      res.status(200).json({
        success: true,
        data: { ...result, message: "This invoice has already been imported." },
      });
      return;
    }

    if (!result.invoiceId) {
      res.status(400).json({
        success: false,
        message: result.reviewReasons[0] || "Invoice could not be imported.",
        data: result,
      });
      return;
    }

    notify(
      NotificationEvents.serviceInvoiceUpload({
        fileName: req.file.originalname,
        invoiceNumber: result.invoiceNumber,
        soldCount: result.counts.sold,
        accessoryCount: result.counts.accessory,
        branch: branchId,
      }),
    ).catch((e) =>
      logger.error(`serviceInvoiceUpload notification failed: ${e?.message}`),
    );

    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    if (handleParseError(err, res, req.file?.originalname || "upload")) return;
    logger.error(`importServiceInvoice failed: ${err?.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to import the invoice",
      error: err?.message,
    });
  }
}
