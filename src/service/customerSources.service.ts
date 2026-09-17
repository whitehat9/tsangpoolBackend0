import { SalesReportModel } from "../models/SalesReport";
import { ServiceInvoiceModel } from "../models/ServiceInvoice/ServiceInvoice";
import { CustomerVehicleModel } from "../models/BikeSystemModel2/CustomerVehicleModel";
import { normalizePhone } from "./salesReport.service";

/**
 * The four independent pipelines that put a customer on record. These are
 * NOT the same thing as BaseCustomer.creationSource — that field records how
 * a customer FIRST entered the system and is written once, whereas a tag
 * here is "this customer is visible in that pipeline right now". One customer
 * can legitimately carry several: bought a bike on a sales report, had it
 * assigned off the CSV stock, and later showed up on a service invoice.
 *
 *   sales-report    a row in an uploaded Sales Report names their mobile
 *   manual-assign   a CustomerVehicle pointing at manual-form stock
 *                   (StockConcept)
 *   csv-assign      a CustomerVehicle pointing at CSV/daily stock
 *                   (StockConceptCSV)
 *   service-upload  a service Tax Invoice PDF was imported against their
 *                   mobile number
 */
export const CUSTOMER_SOURCE_TAGS = [
  "sales-report",
  "manual-assign",
  "csv-assign",
  "service-upload",
] as const;

export type CustomerSourceTag = (typeof CUSTOMER_SOURCE_TAGS)[number];

export function isCustomerSourceTag(value: string): value is CustomerSourceTag {
  return (CUSTOMER_SOURCE_TAGS as readonly string[]).includes(value);
}

export interface CustomerSourceIndex {
  salesReportIds: Set<string>;
  salesReportPhones: Set<string>;
  servicePhones: Set<string>;
  manualAssignIds: Set<string>;
  csvAssignIds: Set<string>;
}

/**
 * Normalize a batch of raw phone-ish values down to the 10-digit form
 * BaseCustomer stores. SalesReport keeps the mobile exactly as the dealer
 * export wrote it and ServiceInvoice keeps whatever the PDF said, so a raw
 * `$in` against BaseCustomer.phoneNumber quietly misses anything carrying a
 * country code or separators. Pulling the distinct values and normalizing
 * them here — rather than querying in the other direction — is what makes
 * the comparison symmetric.
 */
function normalizedPhoneSet(values: unknown[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const phone = normalizePhone(typeof value === "string" ? value : String(value ?? ""));
    if (phone) out.add(phone);
  }
  return out;
}

function idSet(values: unknown[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    if (value) out.add(String(value));
  }
  return out;
}

/**
 * Build the cross-pipeline index once per request. Deliberately one set of
 * `distinct()` calls rather than a per-customer lookup: the same index backs
 * the list's per-row tags, the `?source=` filter and the per-source counts,
 * so computing it once keeps all three consistent with each other. The
 * customer list is a low-traffic admin screen and these collections are
 * dealership-sized, which is what makes the full-collection distinct
 * acceptable here.
 */
export async function buildCustomerSourceIndex(): Promise<CustomerSourceIndex> {
  const [
    salesReportIds,
    salesReportMobiles,
    serviceMobiles,
    manualAssignIds,
    csvAssignIds,
  ] = await Promise.all([
    SalesReportModel.distinct("customerId", {
      isActive: true,
      customerId: { $ne: null },
    }),
    SalesReportModel.distinct("customerMobile", {
      isActive: true,
      customerMobile: { $nin: ["", null] },
    }),
    ServiceInvoiceModel.distinct("customerMobile", {
      isActive: true,
      customerMobile: { $nin: ["", null] },
    }),
    CustomerVehicleModel.distinct("customer", { stockType: "StockConcept" }),
    CustomerVehicleModel.distinct("customer", { stockType: "StockConceptCSV" }),
  ]);

  return {
    salesReportIds: idSet(salesReportIds),
    salesReportPhones: normalizedPhoneSet(salesReportMobiles),
    servicePhones: normalizedPhoneSet(serviceMobiles),
    manualAssignIds: idSet(manualAssignIds),
    csvAssignIds: idSet(csvAssignIds),
  };
}

/** A BaseCustomer query fragment selecting only customers carrying `tag`. */
export function customerSourceFilter(
  tag: CustomerSourceTag,
  index: CustomerSourceIndex,
): Record<string, any> {
  switch (tag) {
    case "sales-report":
      // Rows imported before customer creation was decoupled from the stock
      // match carry no customerId, so fall back to matching on the (already
      // normalized) mobile number.
      return {
        $or: [
          { _id: { $in: [...index.salesReportIds] } },
          { phoneNumber: { $in: [...index.salesReportPhones] } },
        ],
      };
    case "service-upload":
      return { phoneNumber: { $in: [...index.servicePhones] } };
    case "manual-assign":
      return { _id: { $in: [...index.manualAssignIds] } };
    case "csv-assign":
      return { _id: { $in: [...index.csvAssignIds] } };
  }
}

/** Every pipeline this customer currently appears in. */
export function customerSourceTags(
  customer: { _id: unknown; phoneNumber: string },
  index: CustomerSourceIndex,
): CustomerSourceTag[] {
  const id = String(customer._id);
  const phone = customer.phoneNumber;
  const tags: CustomerSourceTag[] = [];

  if (index.salesReportIds.has(id) || index.salesReportPhones.has(phone))
    tags.push("sales-report");
  if (index.manualAssignIds.has(id)) tags.push("manual-assign");
  if (index.csvAssignIds.has(id)) tags.push("csv-assign");
  if (index.servicePhones.has(phone)) tags.push("service-upload");

  return tags;
}
