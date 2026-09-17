import mongoose, { Document, Schema } from "mongoose";
import { UserRole } from "../../types/user.types";

/**
 * ServiceInvoice — one uploaded Honda DMS service Tax Invoice PDF (i.e. one
 * closed job card). The individual billed lines live in ServiceInvoiceLineItem.
 *
 * Dedup key is `invoiceNumber`, not the job card number: a job card can be
 * re-invoiced (revision/correction) and would then legitimately appear twice,
 * whereas the DMS invoice number is unique per document. Scoped per branch and
 * partial over `isActive` so a soft-deleted invoice can be re-imported — the
 * same trick CounterSaleReport uses.
 */
export interface IServiceInvoice extends Document {
  // Identity
  invoiceNumber: string;
  jobCardNumber?: string;
  invoiceDate?: Date | null;
  jobCardClosedDate?: Date | null;

  // Vehicle
  frameNumber?: string;
  engineNumber?: string;
  registrationNumber?: string;
  modelName?: string;
  modelCode?: string;
  color?: string;
  saleDate?: Date | null;

  // Service
  serviceType?: string;
  serviceKm?: number;
  advisorName?: string;
  technicianName?: string;

  // Customer (as printed on the invoice — the right-hand party column)
  customerName?: string;
  customerMobile?: string;
  customerAccountId?: string;
  customerAddress?: string;
  customerCity?: string;
  customerPin?: string;

  // Money, as stated on the invoice (tax-inclusive)
  totalPartsAmount: number;
  totalLabourAmount: number;
  totalDiscountAmount: number;
  totalTaxAmount: number;
  totalInvoiceAmount: number;
  miscellaneousAmount: number;
  paymentMode?: string;

  /**
   * Revenue split derived from the line items, used for the vehicle roll-up.
   *
   * `pendingRevenue` is the value of billed parts not yet in stock. It is held
   * apart from partsRevenue precisely because it is not yet attributable — it
   * moves into partsRevenue/lubesRevenue when the part arrives in a stock
   * upload and the line reconciles to SOLD.
   */
  derivedRevenue: {
    partsRevenue: number;
    lubesRevenue: number;
    accessoriesRevenue: number;
    pendingRevenue: number;
    labourRevenue: number;
  };

  // Linkage resolved at import time (may stay null when no match exists)
  customerId?: mongoose.Types.ObjectId | null;
  customerVehicleId?: mongoose.Types.ObjectId | null;

  // Import metadata
  fileName: string;
  importDate: Date;
  branchId: mongoose.Types.ObjectId;
  uploadedBy: mongoose.Types.ObjectId;
  uploadedByRole: UserRole;
  pageCount: number;
  rawText?: string;

  // Review / integrity
  needsReview: boolean;
  reviewReasons: string[];
  reconciled: boolean;

  isActive: boolean;
  deletedBy?: mongoose.Types.ObjectId;
  deletedByRole?: UserRole;
  deletedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const ServiceInvoiceSchema = new Schema<IServiceInvoice>(
  {
    invoiceNumber: {
      type: String,
      required: [true, "Invoice Number is required"],
      trim: true,
      uppercase: true,
      index: true,
    },
    jobCardNumber: { type: String, trim: true, uppercase: true, index: true },
    invoiceDate: { type: Date, default: null },
    jobCardClosedDate: { type: Date, default: null },

    frameNumber: { type: String, trim: true, uppercase: true, index: true },
    engineNumber: { type: String, trim: true, uppercase: true },
    registrationNumber: { type: String, trim: true, uppercase: true },
    modelName: { type: String, trim: true },
    modelCode: { type: String, trim: true },
    color: { type: String, trim: true },
    saleDate: { type: Date, default: null },

    serviceType: { type: String, trim: true },
    serviceKm: { type: Number, min: 0 },
    advisorName: { type: String, trim: true },
    technicianName: { type: String, trim: true, index: true },

    customerName: { type: String, trim: true },
    customerMobile: { type: String, trim: true, index: true },
    customerAccountId: { type: String, trim: true },
    customerAddress: { type: String, trim: true },
    customerCity: { type: String, trim: true },
    customerPin: { type: String, trim: true },

    totalPartsAmount: { type: Number, default: 0, min: 0 },
    totalLabourAmount: { type: Number, default: 0, min: 0 },
    totalDiscountAmount: { type: Number, default: 0, min: 0 },
    totalTaxAmount: { type: Number, default: 0, min: 0 },
    totalInvoiceAmount: { type: Number, default: 0, min: 0 },
    miscellaneousAmount: { type: Number, default: 0, min: 0 },
    paymentMode: { type: String, trim: true },

    derivedRevenue: {
      partsRevenue: { type: Number, default: 0, min: 0 },
      lubesRevenue: { type: Number, default: 0, min: 0 },
      accessoriesRevenue: { type: Number, default: 0, min: 0 },
      pendingRevenue: { type: Number, default: 0, min: 0 },
      labourRevenue: { type: Number, default: 0, min: 0 },
    },

    customerId: { type: Schema.Types.ObjectId, ref: "BaseCustomer", default: null },
    customerVehicleId: {
      type: Schema.Types.ObjectId,
      ref: "CustomerVehicle",
      default: null,
    },

    fileName: { type: String, required: true, trim: true },
    importDate: { type: Date, default: Date.now },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: [true, "Branch is required"],
      index: true,
    },
    uploadedBy: { type: Schema.Types.ObjectId, required: true },
    uploadedByRole: { type: String, required: true },
    pageCount: { type: Number, default: 0 },
    rawText: { type: String },

    needsReview: { type: Boolean, default: false, index: true },
    reviewReasons: { type: [String], default: [] },
    reconciled: { type: Boolean, default: true },

    isActive: { type: Boolean, default: true, index: true },
    deletedBy: { type: Schema.Types.ObjectId },
    deletedByRole: { type: String },
    deletedAt: { type: Date },
  },
  {
    timestamps: true,
    strict: false, // keep any extra fields a future template might add
  },
);

// One live invoice per invoice number per branch.
ServiceInvoiceSchema.index(
  { branchId: 1, invoiceNumber: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);
ServiceInvoiceSchema.index({ branchId: 1, createdAt: -1 });
ServiceInvoiceSchema.index({ branchId: 1, jobCardClosedDate: -1 });

export const ServiceInvoiceModel = mongoose.model<IServiceInvoice>(
  "ServiceInvoice",
  ServiceInvoiceSchema,
);
