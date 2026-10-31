// service/salesReport/reverseSalesReportBatch.service.ts
//
// Undoes what a sales-report import did OUTSIDE the SalesReport collection.
//
// An import is not just rows: per row it can flip a stock unit to Sold, create
// a CustomerVehicle, and create a BaseCustomer (processSalesReportRow.service.ts).
// Soft-deleting only the report rows used to leave all of that behind, so a
// "deleted" batch still showed its bikes as Sold and its customers/vehicles,
// and a re-import then came back matched_already_sold / customer_conflict.
//
// Reversal is guarded: anything that has since been worked on downstream
// (service history, accessories, VAS, registration, a customer profile or OTP
// login) is KEPT and reported, never destroyed. Each undo is idempotent — it
// only acts while the record still looks like this import left it.

import mongoose from "mongoose";
import logger from "../../utils/logger";
import { SalesReportModel, ISalesReport } from "../../models/SalesReport";
import { StockConceptCSVModel } from "../../models/BikeSystemModel3/StockConceptCSV";
import { StockConceptModel } from "../../models/BikeSystemModel2/StockConcept";
import { CustomerVehicleModel } from "../../models/BikeSystemModel2/CustomerVehicleModel";
import { BaseCustomerModel } from "../../models/CustomerSystem/BaseCustomer";
import { CustomerProfileModel } from "../../models/CustomerSystem/CustomerProfile";

export interface ReverseSalesReportResult {
  stockRestored: number;
  vehiclesRemoved: number;
  customersRemoved: number;
  /** Things left in place because they have been used since, with the reason. */
  kept: { frameNo: string; reason: string }[];
}

/** Why a vehicle can't be safely removed, or null when it is still untouched. */
function vehicleInUse(v: any): string | null {
  const exp = v.serviceExpenses ?? {};
  if (
    (exp.partsRevenue ?? 0) > 0 ||
    (exp.lubesRevenue ?? 0) > 0 ||
    (exp.totalJobCardRevenue ?? 0) > 0 ||
    (v.serviceStatus?.serviceHistory ?? 0) > 0
  )
    return "vehicle has service history";
  if (v.accessories?.length) return "vehicle has accessories fitted";
  if (v.activeValueAddedServices?.length) return "vehicle has value-added services";
  if (v.numberPlate || v.registrationDate) return "vehicle has been registered";
  return null;
}

export async function reverseSalesReportRows(
  rows: ISalesReport[],
): Promise<ReverseSalesReportResult> {
  const result: ReverseSalesReportResult = {
    stockRestored: 0,
    vehiclesRemoved: 0,
    customersRemoved: 0,
    kept: [],
  };
  const batchRowIds = rows.map((r) => r._id);

  for (const row of rows) {
    try {
      if (
        row.matchOutcome !== "matched_status_flipped" &&
        row.matchOutcome !== "matched_manual_form_status_flipped"
      )
        continue; // matched_already_sold / unmatched / conflict changed no stock

      if (row.matchOutcome === "matched_manual_form_status_flipped") {
        const res = await StockConceptModel.updateOne(
          { _id: row.matchedStockId, "stockStatus.status": "Sold" },
          { $set: { "stockStatus.status": row.stockPreviousStatus || "Available" } },
        );
        result.stockRestored += res.modifiedCount;
        continue;
      }

      // CSV stock: the vehicle decides whether the sale is still untouched.
      if (row.customerVehicleId) {
        const vehicle = await CustomerVehicleModel.findById(row.customerVehicleId).lean();
        const inUse = vehicle && vehicleInUse(vehicle);
        if (inUse) {
          result.kept.push({ frameNo: row.frameNo, reason: inUse });
          continue; // stock stays Sold — it genuinely has an owner now
        }
        if (vehicle) {
          await CustomerVehicleModel.deleteOne({ _id: vehicle._id });
          result.vehiclesRemoved++;
        }
      }

      // Only restore stock that still points at this import's vehicle, so a
      // later re-sale of the same unit through another flow is never reverted.
      const res = await StockConceptCSVModel.updateOne(
        {
          _id: row.matchedStockId,
          "stockStatus.status": "Sold",
          $or: [
            { "salesInfo.customerVehicleId": row.customerVehicleId },
            { "salesInfo.customerVehicleId": { $exists: false } },
          ],
        },
        {
          $set: { "stockStatus.status": row.stockPreviousStatus || "Available" },
          $unset: { salesInfo: "" },
        },
      );
      result.stockRestored += res.modifiedCount;
    } catch (err) {
      logger.error(`SalesReport reverse: row ${row._id} failed: ${err}`);
      result.kept.push({ frameNo: row.frameNo, reason: "reversal errored — see logs" });
    }
  }

  // Customers last, once their vehicles are gone. Only ones this import
  // created (rows predating the flag are never deleted), and only while nothing
  // else holds them: another vehicle, another live report row, a profile, or a
  // real login.
  const created = [
    ...new Set(
      rows
        .filter((r) => r.customerCreatedByImport && r.customerId)
        .map((r) => String(r.customerId)),
    ),
  ];
  for (const id of created) {
    try {
      const [vehicle, otherRows, profile, customer] = await Promise.all([
        CustomerVehicleModel.exists({ customer: id }),
        SalesReportModel.exists({
          customerId: id,
          isActive: true,
          _id: { $nin: batchRowIds },
        }),
        CustomerProfileModel.exists({ customer: id }),
        BaseCustomerModel.findById(id).lean(),
      ]);
      if (
        !customer ||
        vehicle ||
        otherRows ||
        profile ||
        customer.isVerified ||
        customer.firebaseUid ||
        customer.creationSource !== "new_csv_sales_report"
      )
        continue;
      await BaseCustomerModel.deleteOne({ _id: id });
      result.customersRemoved++;
    } catch (err) {
      logger.error(`SalesReport reverse: customer ${id} failed: ${err}`);
    }
  }

  return result;
}
