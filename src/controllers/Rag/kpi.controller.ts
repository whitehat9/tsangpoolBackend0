import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import mongoose from "mongoose";
import {
  generateKpiDashboard,
  listKpiMetrics,
} from "../../service/rag/kpiPlanner";
import logger from "../../utils/logger";

/**
 * @desc    Build a KPI dashboard from a natural-language prompt
 * @route   POST /api/rag/kpi
 * @access  Super-Admin
 */
export const generateKpi = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401);
    throw new Error("Not authorized");
  }

  const { prompt, branchId } = req.body as {
    prompt?: string;
    branchId?: string;
  };

  if (!prompt || !prompt.trim()) {
    res.status(400);
    throw new Error("prompt is required");
  }

  if (branchId && !mongoose.Types.ObjectId.isValid(branchId)) {
    res.status(400);
    throw new Error("Invalid branchId");
  }

  try {
    const data = await generateKpiDashboard({
      prompt,
      user: req.user,
      branchId,
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "KPI generation failed";
    logger.error("KPI generation failed:", msg);
    // A prompt that maps to no metric is a user-input problem, not a server
    // fault — same 400/500 split the RAG query controller uses.
    const status =
      msg.includes("required") ||
      msg.includes("Branch could not be resolved") ||
      msg.includes("No KPI metrics") ||
      msg.includes("didn't map to any available KPI")
        ? 400
        : 500;
    res.status(status);
    throw new Error(msg);
  }
});

/**
 * @desc    List the KPI metrics the current role may ask about
 * @route   GET /api/rag/kpi/metrics
 * @access  Super-Admin
 */
export const getKpiMetrics = asyncHandler(
  async (req: Request, res: Response) => {
    if (!req.user) {
      res.status(401);
      throw new Error("Not authorized");
    }
    res.status(200).json({ success: true, data: listKpiMetrics(req.user) });
  },
);
