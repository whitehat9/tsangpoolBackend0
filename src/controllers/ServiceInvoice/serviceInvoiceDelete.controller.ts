import { Request, Response } from "express";
import mongoose from "mongoose";
import { isAdmin, getUserBranch } from "../../types/user.types";
import logger from "../../utils/logger";
import { ServiceInvoiceModel } from "../../models/ServiceInvoice/ServiceInvoice";
import { reverseInvoice } from "../../service/serviceInvoice/importInvoice.service";

/**
 * @desc    Soft-delete a service invoice and undo everything it applied:
 *          its consumption ledger rows (so effective stock goes back up),
 *          the accessories it recorded on the bike, and its contribution to
 *          the vehicle's rolled-up service spend.
 *
 *          Deleting also releases the invoice number, so a corrected copy of
 *          the same invoice can be re-imported afterwards.
 * @route   DELETE /api/service-invoice/:invoiceId
 * @access  Super-Admin (any branch), Part-Admin (own branch only)
 */
export async function deleteServiceInvoice(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { invoiceId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
      res.status(400).json({ success: false, message: "Invalid invoice id" });
      return;
    }

    const invoice = await ServiceInvoiceModel.findById(invoiceId).lean();
    if (!invoice || !(invoice as any).isActive) {
      res.status(404).json({ success: false, message: "Service invoice not found" });
      return;
    }

    // Branch-scoped roles may only delete their own branch's invoices.
    if (!req.user || !isAdmin(req.user)) {
      const branch = req.user ? getUserBranch(req.user) : null;
      if (!branch || String((invoice as any).branchId) !== String(branch)) {
        res.status(403).json({
          success: false,
          message: "You can only delete invoices from your own branch",
        });
        return;
      }
    }

    const result = await reverseInvoice({
      invoiceId,
      deletedBy: (req.user as any)._id,
      deletedByRole: (req.user as any).role,
    });

    logger.info(
      `Service invoice ${(invoice as any).invoiceNumber} deleted by ${(req.user as any).role} — ` +
        `${result.reversedConsumption} consumption row(s) and ${result.reversedAccessories} accessory record(s) reversed`,
    );

    res.status(200).json({
      success: true,
      message: "Invoice deleted and its stock/vehicle effects reversed",
      data: result,
    });
  } catch (err: any) {
    logger.error(`deleteServiceInvoice failed: ${err?.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to delete the invoice",
      error: err?.message,
    });
  }
}

/**
 * @desc    Audit trail of deleted invoices.
 * @route   GET /api/service-invoice/deleted
 * @access  Super-Admin only
 */
export async function getDeletedServiceInvoices(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const filter: Record<string, any> = { isActive: false };
    const branchId = req.query.branchId as string | undefined;
    if (branchId && mongoose.Types.ObjectId.isValid(branchId)) {
      filter.branchId = new mongoose.Types.ObjectId(branchId);
    }

    const rows = await ServiceInvoiceModel.find(filter, { rawText: 0 })
      .populate("branchId", "branchName")
      .sort({ deletedAt: -1 })
      .limit(100)
      .lean();

    res.status(200).json({ success: true, data: { rows, count: rows.length } });
  } catch (err: any) {
    logger.error(`getDeletedServiceInvoices failed: ${err?.message}`);
    res
      .status(500)
      .json({ success: false, message: "Failed to load deleted invoices" });
  }
}
