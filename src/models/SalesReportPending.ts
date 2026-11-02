import mongoose, { Document, Schema } from "mongoose";

/**
 * SalesReportPending — a sales-register row whose EX SHOWROOM / INSURANCE /
 * REGISTRATION were not all filled in at upload. It is held here, apart from
 * SalesReport, so it touches nothing else (no customer, no stock flip, no
 * KPI) until the Branch-Admin enters the three amounts; completing it creates
 * the real SalesReport row via service/salesReport/createSalesReportRecord.service.ts
 * and deletes the pending one.
 *
 * Every curated field is stored flat (strict: false) so completing a row can
 * replay exactly what the import would have written.
 */
export interface ISalesReportPending extends Document {
  rowData: Record<string, any>;
  detectedColumns: string[];
  sourceFormat: "xlsx" | "csv";
  frameNo: string;
  engineNo: string;
  modelName: string;
  customerFirstName: string;
  customerLastName: string;
  customerMobile: string;
  saleDate?: Date;
  needsReview: boolean;
  /** Whatever of the three amounts has been entered so far. */
  exShowroom?: number;
  insuranceAmount?: number;
  registrationAmount?: number;
  importBatch: string;
  importDate: Date;
  fileName: string;
  branchId: mongoose.Types.ObjectId;
  uploadedBy: mongoose.Types.ObjectId;
  createdAt: Date;
}

const SalesReportPendingSchema = new Schema<ISalesReportPending>(
  {
    rowData: { type: Schema.Types.Mixed, required: true },
    detectedColumns: { type: [String], default: [] },
    sourceFormat: { type: String, enum: ["xlsx", "csv"], required: true },
    frameNo: { type: String, required: true, uppercase: true, index: true },
    engineNo: { type: String, default: "", uppercase: true },
    modelName: { type: String, default: "" },
    customerFirstName: { type: String, default: "" },
    customerLastName: { type: String, default: "" },
    customerMobile: { type: String, default: "" },
    saleDate: { type: Date },
    needsReview: { type: Boolean, default: false },
    exShowroom: { type: Number },
    insuranceAmount: { type: Number },
    registrationAmount: { type: Number },
    importBatch: { type: String, required: true, index: true },
    importDate: { type: Date, required: true },
    fileName: { type: String, required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    uploadedBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true, strict: false },
);

// One pending row per Frame No per branch — a re-upload can't queue it twice.
SalesReportPendingSchema.index({ branchId: 1, frameNo: 1 }, { unique: true });

export const SalesReportPendingModel = mongoose.model<ISalesReportPending>(
  "SalesReportPending",
  SalesReportPendingSchema,
);
