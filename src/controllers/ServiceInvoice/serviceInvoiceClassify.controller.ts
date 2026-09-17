import { Request, Response } from "express";
import mongoose from "mongoose";
import { isAdmin, getUserBranch } from "../../types/user.types";
import logger from "../../utils/logger";
import { ServiceInvoiceModel } from "../../models/ServiceInvoice/ServiceInvoice";
import { ServiceInvoiceLineItemModel } from "../../models/ServiceInvoice/ServiceInvoiceLineItem";
import { CustomerVehicleModel } from "../../models/BikeSystemModel2/CustomerVehicleModel";

/**
 * @desc    Re-tag a PENDING_STOCK line as a genuine accessory.
 *
 *          A pending line normally resolves itself: the next parts-stock
 *          upload that contains its part number flips it to SOLD. But some
 *          billed parts are never carried as stock at all — a bolt-on
 *          accessory the technician fitted — and those would otherwise sit in
 *          the review queue forever waiting for an upload that never comes.
 *          This is the manual escape hatch for that case.
 *
 *          Moving the line also moves its value out of `pendingRevenue` into
 *          `accessoriesRevenue` and records it on the customer's bike, which
 *          is what the automatic path used to do at import time.
 *
 * @route   PATCH /api/service-invoice/line-items/:lineItemId/accessory
 * @access  Super-Admin, Part-Admin, Service-Admin (own branch unless admin)
 */
export async function markLineAsAccessory(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { lineItemId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(lineItemId)) {
      res.status(400).json({ success: false, message: "Invalid line item id" });
      return;
    }

    const line = await ServiceInvoiceLineItemModel.findById(lineItemId);
    if (!line || !line.isActive) {
      res.status(404).json({ success: false, message: "Line item not found" });
      return;
    }

    if (!req.user || !isAdmin(req.user)) {
      const branch = getUserBranch(req.user!);
      if (!branch || String(line.branchId) !== String(branch)) {
        res.status(403).json({
          success: false,
          message: "You can only change lines from your own branch",
        });
        return;
      }
    }

    if (line.classification !== "PENDING_STOCK") {
      res.status(409).json({
        success: false,
        message: `Only a line awaiting stock can be re-tagged as an accessory (this one is ${line.classification}).`,
      });
      return;
    }

    const invoice = await ServiceInvoiceModel.findById(line.invoiceId);
    if (!invoice) {
      res.status(404).json({ success: false, message: "Invoice not found" });
      return;
    }

    line.classification = "ACCESSORY";
    line.needsReview = false;
    await line.save();

    // pending -> accessories
    await ServiceInvoiceModel.updateOne(
      { _id: invoice._id },
      {
        $inc: {
          "derivedRevenue.accessoriesRevenue": line.taxableAmount,
          "derivedRevenue.pendingRevenue": -line.taxableAmount,
        },
      },
    );

    // Record it on the bike, the same way the importer records accessories.
    if (invoice.customerVehicleId) {
      await CustomerVehicleModel.updateOne(
        { _id: invoice.customerVehicleId },
        {
          $push: {
            accessories: {
              partNo: line.partNo,
              description: line.description,
              qty: line.qty,
              amount: line.taxableAmount,
              invoiceId: invoice._id,
              invoiceNumber: invoice.invoiceNumber,
              fittedBy: invoice.technicianName,
              fittedAt: invoice.jobCardClosedDate || new Date(),
            },
          },
        },
      );
    }

    // Clear the invoice's "awaiting stock" note for this part.
    const remaining = (invoice.reviewReasons || []).filter(
      (r) => !(r.includes(line.partNo) && /is not in parts stock yet/i.test(r)),
    );
    invoice.reviewReasons = remaining;
    invoice.needsReview = remaining.length > 0;
    await invoice.save();

    logger.info(
      `Invoice ${invoice.invoiceNumber} line ${line.partNo} re-tagged PENDING_STOCK -> ACCESSORY by ${(req.user as any)?.role}`,
    );

    res.status(200).json({
      success: true,
      message: `"${line.partNo}" recorded as an accessory fitted to the bike.`,
      data: { lineItemId: String(line._id), classification: line.classification },
    });
  } catch (err: any) {
    logger.error(`markLineAsAccessory failed: ${err?.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to update the line item",
      error: err?.message,
    });
  }
}
