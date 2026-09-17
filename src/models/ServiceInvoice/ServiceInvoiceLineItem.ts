import mongoose, { Document, Schema } from "mongoose";

/**
 * One billed line from a service invoice.
 *
 * `kind` is what the invoice itself says the line is, read off the UoM column
 * ("No's" = a physical part, "Hrs" = labour/job code). `classification` is what
 * we concluded after checking the part number against parts stock:
 *
 *   LABOUR         - a job code; never touches inventory
 *   SOLD           - a part that exists in this branch's parts stock
 *   PENDING_STOCK  - a billed part that is not in parts stock YET. Service
 *                    invoices routinely arrive before the Part-Admin uploads
 *                    the stock file that contains the part, so "not found"
 *                    usually means "not imported yet", not "not a stock part".
 *                    The line is recorded and left pending; it takes no stock
 *                    and books no parts revenue until it resolves.
 *   ACCESSORY      - confirmed to be an accessory fitted to the bike by the
 *                    technician rather than a stock part. Never assigned
 *                    automatically — a person re-tags a PENDING_STOCK line
 *                    once they know the part is genuinely never stocked.
 *
 * A PENDING_STOCK line flips to SOLD automatically the next time a parts-stock
 * upload contains its part number (service/serviceInvoice/reconcilePendingStock.service.ts),
 * recording `soldAt` and keeping its invoice reference.
 */
export type LineItemKind = "PART" | "LABOUR";
export type LineItemClassification =
  | "SOLD"
  | "PENDING_STOCK"
  | "ACCESSORY"
  | "LABOUR";
export type PartMatchQuality = "exact" | "loose" | "none";

export interface IServiceInvoiceLineItem extends Document {
  invoiceId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;

  srNo: number;
  /** Part number or job code, uppercased with whitespace stripped. */
  partNo: string;
  /** Punctuation-stripped form used for tolerant stock matching. */
  matchKey: string;
  description: string;
  hsn: string;
  uom: string;
  kind: LineItemKind;

  qty: number;
  unitPrice?: number;
  discountPct?: number;
  discountRs?: number;
  /** Pre-tax amount for this line. */
  taxableAmount: number;

  classification: LineItemClassification;
  matchQuality: PartMatchQuality;
  /** The PartsReport row this matched, when it matched. */
  matchedPartId?: mongoose.Types.ObjectId | null;
  /** True for lubricants/oils (HSN chapter 2710) — split out of parts revenue. */
  isLube: boolean;

  /**
   * When this line was confirmed sold out of stock. Set at import for a line
   * that matched immediately, or at reconciliation for one that was
   * PENDING_STOCK until a later parts-stock upload covered it.
   */
  soldAt?: Date | null;
  /** When a PENDING_STOCK line was resolved, and by which parts batch. */
  reconciledAt?: Date | null;
  reconciledByBatch?: string | null;

  needsReview: boolean;
  isActive: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const ServiceInvoiceLineItemSchema = new Schema<IServiceInvoiceLineItem>(
  {
    invoiceId: {
      type: Schema.Types.ObjectId,
      ref: "ServiceInvoice",
      required: true,
      index: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },

    srNo: { type: Number, default: 0 },
    partNo: { type: String, required: true, trim: true, uppercase: true },
    matchKey: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, default: "", trim: true },
    hsn: { type: String, default: "", trim: true },
    uom: { type: String, default: "", trim: true },
    kind: { type: String, enum: ["PART", "LABOUR"], required: true },

    qty: { type: Number, default: 0 },
    unitPrice: { type: Number },
    discountPct: { type: Number },
    discountRs: { type: Number },
    taxableAmount: { type: Number, default: 0 },

    classification: {
      type: String,
      enum: ["SOLD", "PENDING_STOCK", "ACCESSORY", "LABOUR"],
      required: true,
      index: true,
    },
    matchQuality: {
      type: String,
      enum: ["exact", "loose", "none"],
      default: "none",
    },
    matchedPartId: { type: Schema.Types.ObjectId, ref: "PartsReport", default: null },
    isLube: { type: Boolean, default: false },

    soldAt: { type: Date, default: null },
    reconciledAt: { type: Date, default: null },
    reconciledByBatch: { type: String, default: null },

    needsReview: { type: Boolean, default: false, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

ServiceInvoiceLineItemSchema.index({ branchId: 1, partNo: 1 });
// Drives the reconciliation sweep after a parts-stock upload: find pending
// lines in this branch whose part number just arrived in stock.
ServiceInvoiceLineItemSchema.index({
  branchId: 1,
  classification: 1,
  matchKey: 1,
  isActive: 1,
});
ServiceInvoiceLineItemSchema.index({ branchId: 1, classification: 1, isActive: 1 });

export const ServiceInvoiceLineItemModel = mongoose.model<IServiceInvoiceLineItem>(
  "ServiceInvoiceLineItem",
  ServiceInvoiceLineItemSchema,
);
