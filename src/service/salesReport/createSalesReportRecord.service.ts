import mongoose from "mongoose";
import { SalesReportModel } from "../../models/SalesReport";
import { CuratedSalesReportFields } from "../salesReport.service";
import { processSalesReportRow } from "./processSalesReportRow.service";

export interface CreateSalesReportRecordInput {
  curated: CuratedSalesReportFields;
  /** All three amounts, already checked present. */
  exShowroom: number;
  insuranceAmount: number;
  registrationAmount: number;
  rowData: Record<string, any>;
  detectedColumns: string[];
  sourceFormat: "xlsx" | "csv";
  importBatch: string;
  importDate: Date;
  fileName: string;
  branchId: string;
  uploadedBy: mongoose.Types.ObjectId;
}

/**
 * Writes one complete sales-register row: the duplicate check, the customer
 * find-or-create + stock match (processSalesReportRow), then the SalesReport
 * document, with totalPayment = EX SHOWROOM + INSURANCE + REGISTRATION. Shared
 * by the import (rows that arrive with all three amounts) and by completing a
 * pending row, so a row is added to the customer database the same way
 * whichever route it took. Throws on a duplicate Frame No.
 */
export async function createSalesReportRecord(input: CreateSalesReportRecordInput) {
  const { curated, branchId } = input;

  const existing = await SalesReportModel.findOne({
    branchId,
    frameNo: curated.frameNo,
    isActive: true,
  });
  if (existing) {
    // Name the batch so the user can find and delete it to re-import.
    throw new Error(
      `Duplicate row (Frame No "${curated.frameNo}" already imported in batch ${existing.importBatch})`,
    );
  }

  const totalPayment =
    input.exShowroom + input.insuranceAmount + input.registrationAmount;

  const outcome = await processSalesReportRow(
    {
      modelName: curated.modelName,
      modelVariant: curated.modelVariant,
      customerFirstName: curated.customerFirstName,
      customerLastName: curated.customerLastName,
      customerMobile: curated.customerMobile,
      location: curated.location,
      frameNo: curated.frameNo,
      engineNo: curated.engineNo,
      purchaseType: curated.purchaseType,
      totalPayment,
    },
    branchId,
    input.uploadedBy,
  );

  const needsReview = curated.needsReview || outcome.needsReview;

  const count = await SalesReportModel.countDocuments();
  const saleReportId = `SR-${Date.now()}-${String(count + 1).padStart(5, "0")}`;

  await SalesReportModel.create({
    saleReportId,
    rowData: input.rowData,
    detectedColumns: input.detectedColumns,
    sourceFormat: input.sourceFormat,
    modelName: curated.modelName,
    modelVariant: curated.modelVariant || outcome.modelVariant || "",
    customerFirstName: curated.customerFirstName,
    customerLastName: curated.customerLastName,
    customerMobile: curated.customerMobile,
    frameNo: curated.frameNo,
    engineNo: curated.engineNo,
    status: curated.status,
    purchaseType: curated.purchaseType,
    totalPayment,
    exShowroom: input.exShowroom,
    insuranceAmount: input.insuranceAmount,
    registrationAmount: input.registrationAmount,
    slNo: curated.slNo,
    saleDate: curated.saleDate,
    location: curated.location,
    colour: curated.colour,
    ew: curated.ew,
    amc: curated.amc,
    rsa: curated.rsa,
    joyClub: curated.joyClub,
    finance: curated.finance,
    executive: curated.executive,
    productCode: curated.productCode,
    rto: curated.rto,
    hsrp: curated.hsrp,
    matchOutcome: outcome.outcome,
    matched: outcome.matched,
    needsReview,
    matchedStockId: outcome.matchedStockId,
    matchedStockType: outcome.matchedStockType,
    customerId: outcome.customerId,
    customerVehicleId: outcome.customerVehicleId,
    stockPreviousStatus: outcome.stockPreviousStatus,
    customerCreatedByImport: outcome.customerCreated,
    importBatch: input.importBatch,
    importDate: input.importDate,
    fileName: input.fileName,
    branchId,
    uploadedBy: input.uploadedBy,
  });

  return { saleReportId, outcome, needsReview };
}
