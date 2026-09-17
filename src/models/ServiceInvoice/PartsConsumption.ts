import mongoose, { Document, Schema } from "mongoose";

/**
 * PartsConsumption — an append-only ledger of parts consumed by service work.
 *
 * WHY A LEDGER AND NOT A DECREMENT
 * --------------------------------
 * The obvious implementation is to subtract the sold quantity from the parts
 * stock row. That does not work here. Parts stock is *diff-based*: every
 * dealer stock upload is compared against the current rows and supersedes the
 * ones whose values changed, and `service/partsStockDiff.service.ts` lists
 * "quantity" in COMPARE_FIELDS. So writing a decrement into
 * `PartsReport.normalized.quantity` would
 *
 *   1. be silently reverted by the next stock upload (which carries the
 *      dealer's own authoritative quantity), and
 *   2. make the diff engine see a spurious "changed" row and supersede it.
 *
 * Instead we never touch the stock row. Consumption is recorded here, and
 * effective on-hand is derived:
 *
 *   effectiveQty = stockQty - SUM(consumed where consumedAt >= stock importDate)
 *
 * The `consumedAt >= importDate` window is what keeps this correct across
 * re-uploads: once a fresh stock count arrives, consumption recorded before it
 * is already reflected in the dealer's number and must not be subtracted twice.
 *
 * Rows are reversed (isActive: false) when their invoice is deleted rather
 * than being removed, so the history stays auditable.
 */
export interface IPartsConsumption extends Document {
  /** Part number exactly as stored on PartsReport (trim + uppercase). */
  partNumber: string;
  /** Punctuation-stripped form, for tolerant matching. */
  matchKey: string;

  qty: number;
  /** Pre-tax value of the consumed line, for reporting. */
  taxableAmount: number;

  invoiceId: mongoose.Types.ObjectId;
  lineItemId: mongoose.Types.ObjectId;
  /** The stock row this was matched against, when one existed. */
  matchedPartId?: mongoose.Types.ObjectId | null;

  branchId: mongoose.Types.ObjectId;
  consumedAt: Date;

  // Denormalised context — who fitted it, and to which bike
  frameNumber?: string;
  technicianName?: string;

  isActive: boolean;
  reversedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const PartsConsumptionSchema = new Schema<IPartsConsumption>(
  {
    partNumber: { type: String, required: true, trim: true, uppercase: true },
    matchKey: { type: String, required: true, trim: true, uppercase: true },

    qty: { type: Number, required: true, default: 0 },
    taxableAmount: { type: Number, default: 0 },

    invoiceId: {
      type: Schema.Types.ObjectId,
      ref: "ServiceInvoice",
      required: true,
      index: true,
    },
    lineItemId: {
      type: Schema.Types.ObjectId,
      ref: "ServiceInvoiceLineItem",
      required: true,
    },
    matchedPartId: { type: Schema.Types.ObjectId, ref: "PartsReport", default: null },

    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    consumedAt: { type: Date, required: true, default: Date.now },

    frameNumber: { type: String, trim: true, uppercase: true },
    technicianName: { type: String, trim: true },

    isActive: { type: Boolean, default: true, index: true },
    reversedAt: { type: Date },
  },
  { timestamps: true },
);

// Drives the effective-stock aggregation.
PartsConsumptionSchema.index({ branchId: 1, partNumber: 1, consumedAt: -1 });
PartsConsumptionSchema.index({ branchId: 1, isActive: 1, consumedAt: -1 });

export const PartsConsumptionModel = mongoose.model<IPartsConsumption>(
  "PartsConsumption",
  PartsConsumptionSchema,
);
