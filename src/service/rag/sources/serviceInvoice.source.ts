import {
  ServiceInvoiceModel,
  IServiceInvoice,
} from "../../../models/ServiceInvoice/ServiceInvoice";
import { ROLES } from "../../../types/user.types";
import { extractBranchId } from "../../../types/user.types";
import { registerSource } from "../sourceRegistry";

/**
 * RAG source for imported service invoices.
 *
 * Replaces the `jobcard-revenue-import` source, which read the retired
 * ServiceJobcardRecord collection. The source type name is kept unchanged so
 * already-registered dashboards, `sourcesForRole` wiring and any stored
 * embeddings metadata keep resolving — only the underlying collection moved.
 *
 * customerName/customerMobile are deliberately excluded from the embedded text
 * below — they're PII, and RAG answers can surface embedded text to any role
 * in allowedRoles. Only vehicle identifiers and revenue figures are embedded.
 *
 * Part-Admin is included in allowedRoles (the old source was Super-Admin +
 * Service-Admin) because invoices are now what drives parts consumption, and
 * Part-Admin owns that data.
 */
registerSource({
  sourceType: "jobcard-revenue-import",
  model: ServiceInvoiceModel,
  displayName: "Service Invoice",
  selectFields:
    "invoiceNumber jobCardNumber frameNumber modelName serviceType jobCardClosedDate technicianName derivedRevenue totalInvoiceAmount branchId createdAt",

  toChunk(doc: IServiceInvoice) {
    const r = doc.derivedRevenue || ({} as IServiceInvoice["derivedRevenue"]);
    return {
      text:
        `Service invoice ${doc.invoiceNumber ?? "unknown"} for job card ${doc.jobCardNumber ?? "unknown"}, ` +
        `vehicle frame ${doc.frameNumber ?? "unknown"}, model ${doc.modelName ?? "unknown"}, ` +
        `service type ${doc.serviceType ?? "unknown"}, closed ${doc.jobCardClosedDate?.toString?.().slice(0, 10) ?? "unknown"}. ` +
        `Revenue — labour: ${r.labourRevenue ?? 0}, parts: ${r.partsRevenue ?? 0}, lubes: ${r.lubesRevenue ?? 0}, ` +
        `accessories: ${r.accessoriesRevenue ?? 0}, total: ${doc.totalInvoiceAmount ?? 0}. ` +
        `Technician: ${doc.technicianName ?? "unknown"}.`,
      metadata: {
        invoiceNumber: doc.invoiceNumber,
        jobCardNumber: doc.jobCardNumber,
        frameNumber: doc.frameNumber,
        totalJobCardRevenue: doc.totalInvoiceAmount,
      },
    };
  },

  listForIndex(filter) {
    // Deleted invoices are reversed out of stock and the vehicle roll-up, so
    // they must not be indexed as if they still counted.
    const query: Record<string, any> = { isActive: true };
    if (filter.branchId) query.branchId = filter.branchId;
    if (filter.since) query.createdAt = { $gte: filter.since };
    return query;
  },

  scope: {
    branchField: "branchId",
    allowedRoles: [ROLES.SUPER_ADMIN, ROLES.SERVICE_ADMIN, ROLES.PART_ADMIN],
    extractBranchId: (doc: IServiceInvoice) => extractBranchId(doc.branchId),
  },
});
