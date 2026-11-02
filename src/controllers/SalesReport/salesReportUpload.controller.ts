import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import mongoose from "mongoose";
import { SalesReportModel } from "../../models/SalesReport";
import {
  parseSalesReport,
  extractCuratedFields,
  carryDateForward,
  isPlaceholderRow,
  isMissingAmounts,
} from "../../service/salesReport.service";
import { matchSalesReportColumns } from "../../utils/salesReportColumnMatcher";
import { SalesReportPendingModel } from "../../models/SalesReportPending";
import { createSalesReportRecord } from "../../service/salesReport/createSalesReportRecord.service";
import { getUserBranch, isAdmin } from "../../types/user.types";
import logger from "../../utils/logger";
import { notify } from "../../service/pushNotification.service";
import { NotificationEvents } from "../../service/notificationTargeting";

/**
 * Resolve which branch this upload belongs to. Upload is Branch-Admin only,
 * so in practice this always resolves via getUserBranch — the isAdmin branch
 * exists only for parity with the rest of the codebase's branch-resolution
 * helpers (see counterSaleUpload.controller.ts's identical pattern).
 */
function resolveBranchId(req: Request): string | null {
  if (req.user && isAdmin(req.user)) {
    const fromReq =
      (req.body?.branchId as string) || (req.query?.branchId as string);
    return fromReq || null;
  }
  const branch = req.user ? getUserBranch(req.user) : null;
  return branch ? branch.toString() : null;
}

/**
 * @desc    Import a Sales Report of already-sold vehicles (XLSX / CSV).
 *          A row missing any of EX SHOWROOM / INSURANCE / REGISTRATION is not
 *          imported yet: it is held as pending (warning in the response) until
 *          the amounts are entered via /api/sales-report/pending.
 *          Every other row with a usable mobile number creates (or re-uses) a
 *          BaseCustomer — see processSalesReportRow.service.ts — regardless
 *          of whether its vehicle is found in stock. Rows that DO match
 *          StockConceptCSV by Frame No or Engine No additionally flip that
 *          stock to "Sold" and get a CustomerVehicle linked.
 * @route   POST /api/sales-report/import
 * @access  Branch-Admin
 */
export const importSalesReport = asyncHandler(
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400);
      throw new Error("Sales report file required");
    }

    const branchId = resolveBranchId(req);
    if (!branchId) {
      res.status(400);
      throw new Error("Branch could not be resolved for this upload");
    }
    if (!mongoose.Types.ObjectId.isValid(branchId)) {
      res.status(400);
      throw new Error("Invalid branchId");
    }

    const parsed = await parseSalesReport(
      file.buffer,
      file.originalname,
      file.mimetype,
    );

    if (parsed.rows.length === 0) {
      res.status(400);
      throw new Error("No rows could be extracted from the file");
    }

    // Mandatory field checker — gate the whole upload before touching any
    // rows, and report exactly which required columns are missing.
    const matchResult = matchSalesReportColumns(parsed.columns);
    if (!matchResult.isValid) {
      res.status(400);
      throw new Error(
        `Missing required columns: ${matchResult.missingRequired
          .map((f) => f.label)
          .join(", ")}`,
      );
    }

    carryDateForward(parsed.rows, matchResult);

    // Pre-formatted rows past the register's last sale (SL NO. only) are
    // skipped up front so they neither fail nor inflate the row total.
    const placeholder = parsed.rows.map(({ data }) =>
      isPlaceholderRow(data, matchResult),
    );
    const skippedRows = placeholder.filter(Boolean).length;
    if (skippedRows === parsed.rows.length) {
      res.status(400);
      throw new Error("No rows could be extracted from the file");
    }

    const batchId = `SR-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase()}`;
    const importDate = new Date();

    const results = {
      success: false,
      totalRows: parsed.rows.length - skippedRows,
      /** Empty pre-formatted rows (SL NO. only) — ignored, not failed. */
      skippedRows,
      successCount: 0,
      failureCount: 0,
      reviewCount: 0,
      matchedCount: 0,
      unmatchedCount: 0,
      conflictCount: 0,
      customersCreated: 0,
      batchId,
      sourceFormat: parsed.format,
      detectedColumns: parsed.columns,
      errors: [] as {
        row: number;
        data: Record<string, any>;
        error: string;
      }[],
      created: [] as string[],
      /** Rows held because EX SHOWROOM / INSURANCE / REGISTRATION were not all filled in. */
      pendingCount: 0,
      warning: null as string | null,
    };

    for (let i = 0; i < parsed.rows.length; i++) {
      if (placeholder[i]) continue;
      const { data } = parsed.rows[i];
      const rowNumber = i + 2; // header is row 1

      try {
        const curated = extractCuratedFields(data, matchResult);

        if (isMissingAmounts(curated)) {
          // Held apart — no customer, no stock flip — until the three amounts
          // are entered (see salesReportPending.controller.ts).
          const [done, queued] = await Promise.all([
            SalesReportModel.findOne({ branchId, frameNo: curated.frameNo, isActive: true }),
            SalesReportPendingModel.findOne({ branchId, frameNo: curated.frameNo }),
          ]);
          const dup = done?.importBatch ?? queued?.importBatch;
          if (dup) {
            throw new Error(
              `Duplicate row (Frame No "${curated.frameNo}" already imported in batch ${dup})`,
            );
          }
          await SalesReportPendingModel.create({
            ...curated,
            rowData: data,
            detectedColumns: parsed.columns,
            sourceFormat: parsed.format,
            importBatch: batchId,
            importDate,
            fileName: file.originalname,
            branchId,
            uploadedBy: req.user!._id,
          });
          results.pendingCount++;
          continue;
        }

        const { saleReportId, outcome, needsReview } = await createSalesReportRecord({
          curated,
          exShowroom: curated.exShowroom!,
          insuranceAmount: curated.insuranceAmount!,
          registrationAmount: curated.registrationAmount!,
          rowData: data,
          detectedColumns: parsed.columns,
          sourceFormat: parsed.format,
          importBatch: batchId,
          importDate,
          fileName: file.originalname,
          branchId,
          uploadedBy: req.user!._id as unknown as mongoose.Types.ObjectId,
        });

        results.created.push(saleReportId);
        results.successCount++;
        if (needsReview) results.reviewCount++;
        if (
          outcome.outcome === "matched_status_flipped" ||
          outcome.outcome === "matched_manual_form_status_flipped"
        )
          results.matchedCount++;
        if (outcome.outcome === "unmatched") results.unmatchedCount++;
        if (outcome.outcome === "customer_conflict") results.conflictCount++;
        if (outcome.customerCreated) results.customersCreated++;
      } catch (error) {
        results.failureCount++;
        results.errors.push({
          row: rowNumber,
          data,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    if (results.pendingCount > 0) {
      results.warning = `${results.pendingCount} rows without EX SHOWROOM, INSURANCE, REGISTRATION`;
    }
    results.success = results.failureCount === 0;

    logger.info(
      `Sales report imported: ${results.successCount}/${results.totalRows} (batch ${batchId}, branch ${branchId}, ${results.customersCreated} new customers)`,
    );

    if (results.successCount > 0) {
      notify(
        NotificationEvents.salesReportUpload({
          branch: branchId,
          fileName: file.originalname,
          rowCount: results.successCount,
        }),
      ).catch((err) => logger.error(`salesReport notify failed: ${err}`));
    }

    res.status(results.success ? 201 : 207).json({
      success: true,
      message: `Imported ${results.successCount}/${results.totalRows} sales report records (${results.customersCreated} new customers)${results.warning ? ` — ${results.warning}` : ""}`,
      data: results,
    });
  },
);
