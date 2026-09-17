// service/serviceInvoice/importInvoice.service.ts
//
// Orchestrates one service-invoice PDF through the pipeline:
//
//   parse (invoicePdfExtractor)
//     -> classify parts SOLD / PENDING_STOCK (partMatcher)
//       -> persist invoice + line items
//         -> append consumption ledger rows (never decrement stock)
//           -> auto-register customer/vehicle and roll up spend
//
// Preview runs the first two steps only, so the uploader can see exactly what
// will be recorded before anything is written.

import mongoose from "mongoose";
import logger from "../../utils/logger";
import { UserRole } from "../../types/user.types";
import {
  parseServiceInvoicePdf,
  ParsedServiceInvoice,
} from "./invoicePdfExtractor";
import {
  classifyLineItems,
  ClassifiedLineItem,
  ClassificationResult,
} from "./partMatcher.service";
import { ServiceInvoiceModel } from "../../models/ServiceInvoice/ServiceInvoice";
import { ServiceInvoiceLineItemModel } from "../../models/ServiceInvoice/ServiceInvoiceLineItem";
import { PartsConsumptionModel } from "../../models/ServiceInvoice/PartsConsumption";
import { CustomerVehicleModel } from "../../models/BikeSystemModel2/CustomerVehicleModel";
import {
  autoRegisterFromInvoice,
  disableFreeServicesIfPaid,
  AutoRegisterResult,
} from "./autoRegister.service";

export interface InvoicePreview {
  duplicate: boolean;
  /** Set when `duplicate` — the invoice already on record. */
  existingInvoiceId?: string;
  parsed: ParsedServiceInvoice;
  classification: ClassificationResult;
}

export interface InvoiceCommitResult {
  duplicate: boolean;
  invoiceId?: string;
  invoiceNumber: string;
  jobCardNumber?: string;
  counts: {
    lineItems: number;
    sold: number;
    /** Billed parts awaiting a parts-stock upload before they count as sold. */
    pending: number;
    accessory: number;
    labour: number;
    consumptionRows: number;
  };
  revenue: ClassificationResult["revenue"];
  autoRegistration?: AutoRegisterResult;
  freeServicesDisabled: boolean;
  needsReview: boolean;
  reviewReasons: string[];
}

/** Parse + classify without writing anything. */
export async function previewInvoice(
  buffer: Buffer,
  branchId: string,
): Promise<InvoicePreview> {
  const parsed = await parseServiceInvoicePdf(buffer);
  const classification = await classifyLineItems(branchId, parsed.lineItems);

  let duplicate = false;
  let existingInvoiceId: string | undefined;
  if (parsed.header.invoiceNumber) {
    const existing = await ServiceInvoiceModel.findOne({
      branchId,
      invoiceNumber: parsed.header.invoiceNumber.toUpperCase(),
      isActive: true,
    })
      .select("_id")
      .lean();
    if (existing) {
      duplicate = true;
      existingInvoiceId = String((existing as any)._id);
    }
  }

  return { duplicate, existingInvoiceId, parsed, classification };
}

/**
 * Persist one invoice.
 *
 * Writes are sequential and unguarded by a transaction, matching the existing
 * import controllers in this codebase (partsUpload, counterSaleUpload). The
 * ordering is chosen so a partial failure degrades safely: the invoice row —
 * which carries the dedup key — lands first, so a retry is rejected as a
 * duplicate rather than double-applying the ledger and the vehicle roll-up.
 */
export async function commitInvoice(params: {
  buffer: Buffer;
  fileName: string;
  branchId: string;
  uploadedBy: mongoose.Types.ObjectId;
  uploadedByRole: UserRole;
}): Promise<InvoiceCommitResult> {
  const { buffer, fileName, branchId, uploadedBy, uploadedByRole } = params;

  const parsed = await parseServiceInvoicePdf(buffer);
  const invoiceNumber = (parsed.header.invoiceNumber || "").toUpperCase();

  if (!invoiceNumber) {
    // Without the dedup key we cannot safely store or re-import this document.
    return {
      duplicate: false,
      invoiceNumber: "",
      counts: {
        lineItems: 0,
        sold: 0,
        pending: 0,
        accessory: 0,
        labour: 0,
        consumptionRows: 0,
      },
      revenue: {
        partsRevenue: 0,
        lubesRevenue: 0,
        accessoriesRevenue: 0,
        pendingRevenue: 0,
        labourRevenue: 0,
      },
      freeServicesDisabled: false,
      needsReview: true,
      reviewReasons: [
        "Invoice Number could not be read from this PDF, so it cannot be de-duplicated or stored.",
      ],
    };
  }

  const existing = await ServiceInvoiceModel.findOne({
    branchId,
    invoiceNumber,
    isActive: true,
  })
    .select("_id jobCardNumber")
    .lean();

  if (existing) {
    return {
      duplicate: true,
      invoiceId: String((existing as any)._id),
      invoiceNumber,
      jobCardNumber: (existing as any).jobCardNumber,
      counts: {
        lineItems: 0,
        sold: 0,
        pending: 0,
        accessory: 0,
        labour: 0,
        consumptionRows: 0,
      },
      revenue: {
        partsRevenue: 0,
        lubesRevenue: 0,
        accessoriesRevenue: 0,
        pendingRevenue: 0,
        labourRevenue: 0,
      },
      freeServicesDisabled: false,
      needsReview: false,
      reviewReasons: [],
    };
  }

  const soldAtDate =
    parsed.header.jobCardClosedDate || parsed.header.invoiceDate || new Date();
  const classification = await classifyLineItems(
    branchId,
    parsed.lineItems,
    soldAtDate,
  );

  // Line-level review flags roll up onto the invoice.
  const reviewReasons = parsed.reviewReasons.slice();
  for (const li of classification.lineItems) {
    if (li.reviewReason) reviewReasons.push(li.reviewReason);
  }

  const totals = parsed.totals;
  const header = parsed.header;
  const parties = parsed.parties;

  const invoice = await ServiceInvoiceModel.create({
    invoiceNumber,
    jobCardNumber: header.jobCardNumber,
    invoiceDate: header.invoiceDate ?? null,
    jobCardClosedDate: header.jobCardClosedDate ?? null,

    frameNumber: header.frameNumber,
    engineNumber: header.engineNumber,
    registrationNumber: header.registrationNumber,
    modelName: header.modelName,
    modelCode: header.modelCode,
    color: header.color,
    saleDate: header.saleDate ?? null,

    serviceType: header.serviceType,
    serviceKm: header.serviceKm,
    advisorName: header.advisorName,
    technicianName: header.technicianName,

    customerName: parties.customerName,
    customerMobile: parties.customerMobile,
    customerAccountId: parties.customerAccountId,
    customerAddress: parties.customerAddress,
    customerCity: parties.customerCity,
    customerPin: parties.customerPin,

    totalPartsAmount: totals.totalPartsAmount ?? 0,
    totalLabourAmount: totals.totalLabourAmount ?? 0,
    totalDiscountAmount: totals.totalDiscountAmount ?? 0,
    totalTaxAmount: totals.totalTaxAmount ?? 0,
    totalInvoiceAmount: totals.totalInvoiceAmount ?? 0,
    miscellaneousAmount: totals.miscellaneousAmount ?? 0,
    paymentMode: totals.paymentMode,

    derivedRevenue: classification.revenue,

    fileName,
    importDate: new Date(),
    branchId,
    uploadedBy,
    uploadedByRole,
    pageCount: parsed.pageCount,
    rawText: parsed.rawText,

    needsReview: reviewReasons.length > 0,
    reviewReasons,
    reconciled: parsed.reconciliation.ok,
  });

  const invoiceId = invoice._id as mongoose.Types.ObjectId;

  // ---- line items -------------------------------------------------------
  const lineDocs = classification.lineItems.map((li: ClassifiedLineItem) => ({
    invoiceId,
    branchId,
    srNo: li.srNo,
    partNo: li.partNo,
    matchKey: li.matchKey,
    description: li.description,
    hsn: li.hsn,
    uom: li.uom,
    kind: li.kind,
    qty: li.qty,
    unitPrice: li.unitPrice,
    discountPct: li.discountPct,
    discountRs: li.discountRs,
    taxableAmount: li.taxableAmount,
    classification: li.classification,
    matchQuality: li.matchQuality,
    matchedPartId: li.matchedPartId,
    isLube: li.isLube,
    soldAt: li.soldAt,
    needsReview: li.needsReview,
  }));
  const savedLines = await ServiceInvoiceLineItemModel.insertMany(lineDocs);

  // ---- consumption ledger ----------------------------------------------
  // Only SOLD lines consume stock. ACCESSORY lines were never in stock, so
  // there is nothing to net off; they are recorded on the vehicle instead.
  const consumedAt = header.jobCardClosedDate || header.invoiceDate || new Date();
  const consumptionDocs = savedLines
    .filter((l: any) => l.classification === "SOLD")
    .map((l: any) => ({
      partNumber: l.partNo,
      matchKey: l.matchKey,
      qty: l.qty,
      taxableAmount: l.taxableAmount,
      invoiceId,
      lineItemId: l._id,
      matchedPartId: l.matchedPartId,
      branchId,
      consumedAt,
      frameNumber: header.frameNumber,
      technicianName: header.technicianName,
    }));
  if (consumptionDocs.length > 0) {
    await PartsConsumptionModel.insertMany(consumptionDocs);
  }

  // ---- customer / vehicle ----------------------------------------------
  let autoRegistration: AutoRegisterResult | undefined;
  let freeServicesDisabled = false;
  try {
    autoRegistration = await autoRegisterFromInvoice(
      {
        customerName: parties.customerName,
        customerMobile: parties.customerMobile,
        frameNumber: header.frameNumber,
        modelName: header.modelName,
        modelVariant: header.modelCode,
        currentKms: header.serviceKm,
        jobCardClosedDate: header.jobCardClosedDate,
        partsRevenue: classification.revenue.partsRevenue,
        lubesRevenue: classification.revenue.lubesRevenue,
        totalJobCardRevenue: totals.totalInvoiceAmount ?? 0,
      },
      branchId,
      uploadedBy,
    );

    if (autoRegistration.customerId || autoRegistration.vehicleId) {
      await ServiceInvoiceModel.updateOne(
        { _id: invoiceId },
        {
          customerId: autoRegistration.customerId || null,
          customerVehicleId: autoRegistration.vehicleId || null,
        },
      );
    }

    if (autoRegistration.vehicleId) {
      await recordAccessoriesOnVehicle(
        autoRegistration.vehicleId,
        invoiceId,
        invoiceNumber,
        header.technicianName,
        savedLines,
      );
    }

    freeServicesDisabled = await disableFreeServicesIfPaid(
      parties.customerMobile,
      header.serviceType,
    );
  } catch (err: any) {
    // The invoice and its parts data are already safely stored; a failure to
    // attach it to a customer/vehicle must not fail the whole import.
    logger.error(
      `Service invoice ${invoiceNumber}: auto-registration failed — ${err?.message}`,
    );
    reviewReasons.push(
      `Customer/vehicle linking failed: ${err?.message || "unknown error"}.`,
    );
    await ServiceInvoiceModel.updateOne(
      { _id: invoiceId },
      { needsReview: true, reviewReasons },
    );
  }

  return {
    duplicate: false,
    invoiceId: String(invoiceId),
    invoiceNumber,
    jobCardNumber: header.jobCardNumber,
    counts: {
      lineItems: savedLines.length,
      sold: classification.summary.sold,
      pending: classification.summary.pending,
      accessory: classification.summary.accessory,
      labour: classification.summary.labour,
      consumptionRows: consumptionDocs.length,
    },
    revenue: classification.revenue,
    autoRegistration,
    freeServicesDisabled,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
  };
}

/** Append this invoice's ACCESSORY lines to the bike they were fitted to. */
async function recordAccessoriesOnVehicle(
  vehicleId: string,
  invoiceId: mongoose.Types.ObjectId,
  invoiceNumber: string,
  technicianName: string | undefined,
  savedLines: any[],
): Promise<void> {
  const accessories = savedLines
    .filter((l) => l.classification === "ACCESSORY")
    .map((l) => ({
      partNo: l.partNo,
      description: l.description,
      qty: l.qty,
      amount: l.taxableAmount,
      invoiceId,
      invoiceNumber,
      fittedBy: technicianName,
      fittedAt: new Date(),
    }));

  if (accessories.length === 0) return;

  await CustomerVehicleModel.updateOne(
    { _id: vehicleId },
    { $push: { accessories: { $each: accessories } } },
  );
}

/**
 * Soft-delete an invoice and undo everything it applied.
 *
 * Reversal order mirrors the write order in reverse so that, if this is
 * interrupted, what remains is a still-active invoice rather than an active
 * invoice whose effects have already been stripped.
 */
export async function reverseInvoice(params: {
  invoiceId: string;
  deletedBy: mongoose.Types.ObjectId;
  deletedByRole: UserRole;
}): Promise<{ reversedConsumption: number; reversedAccessories: number }> {
  const { invoiceId, deletedBy, deletedByRole } = params;

  const invoice = await ServiceInvoiceModel.findById(invoiceId);
  if (!invoice || !invoice.isActive) {
    throw new Error("Invoice not found or already deleted");
  }

  // 1. Undo the vehicle roll-up and remove this invoice's accessories.
  let reversedAccessories = 0;
  if (invoice.customerVehicleId) {
    const vehicle = await CustomerVehicleModel.findById(invoice.customerVehicleId);
    if (vehicle) {
      const before = (vehicle as any).accessories?.length ?? 0;
      (vehicle as any).accessories = ((vehicle as any).accessories || []).filter(
        (a: any) => String(a.invoiceId) !== String(invoice._id),
      );
      reversedAccessories = before - (vehicle as any).accessories.length;

      const se = vehicle.serviceExpenses || ({} as any);
      se.partsRevenue = Math.max(
        0,
        (se.partsRevenue ?? 0) - (invoice.derivedRevenue?.partsRevenue ?? 0),
      );
      se.lubesRevenue = Math.max(
        0,
        (se.lubesRevenue ?? 0) - (invoice.derivedRevenue?.lubesRevenue ?? 0),
      );
      se.totalJobCardRevenue = Math.max(
        0,
        (se.totalJobCardRevenue ?? 0) - (invoice.totalInvoiceAmount ?? 0),
      );
      vehicle.serviceExpenses = se;
      await vehicle.save();
    }
  }

  // 2. Reverse the consumption ledger so effective stock goes back up.
  const consumption = await PartsConsumptionModel.updateMany(
    { invoiceId: invoice._id, isActive: true },
    { isActive: false, reversedAt: new Date() },
  );

  // 3. Retire the line items.
  await ServiceInvoiceLineItemModel.updateMany(
    { invoiceId: invoice._id },
    { isActive: false },
  );

  // 4. Finally release the dedup key so the invoice can be re-imported.
  invoice.isActive = false;
  invoice.deletedBy = deletedBy;
  invoice.deletedByRole = deletedByRole;
  invoice.deletedAt = new Date();
  await invoice.save();

  return {
    reversedConsumption: consumption.modifiedCount ?? 0,
    reversedAccessories,
  };
}
