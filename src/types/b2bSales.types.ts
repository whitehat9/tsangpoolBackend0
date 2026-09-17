// ─── Request DTOs ──────────────────────────────────────────────────────────

export interface StockItemInput {
  stockConceptCSVId: string;
  quantity: number;
  /**
   * Per-challan price override. B2B deals are negotiated, so the price on a
   * challan is often not the stock's book cost. Omit it and the server falls
   * back to StockConceptCSV.costPrice, which is the historical behaviour.
   *
   * This never writes back to the stock record — inventory cost is unchanged;
   * only this challan's line price differs.
   */
  costPrice?: number;
}

export interface ExtraItemInput {
  name: string;
  unitPrice: number;
  quantity: number;
}

export interface CreateB2BSaleBody {
  to: string;
  topHeading?: string;
  stockItems: StockItemInput[];
  extraItems?: ExtraItemInput[];
  tcsAmount?: number;
  payablePrice?: number;
}

export interface UpdateB2BSaleBody {
  to?: string;
  topHeading?: string;
  stockItems?: StockItemInput[];
  extraItems?: ExtraItemInput[];
  tcsAmount?: number;
  payablePrice?: number;
}

// ─── Response DTOs ─────────────────────────────────────────────────────────

export interface StockSearchResult {
  _id: string;
  modelName: string;
  engineNumber: string;
  chassisNumber: string;
  costPrice: number;
  status: string;
  location: string;
}

export interface B2BSalesMonthlyTrendPoint {
  month: string; // "YYYY-MM"
  challanCount: number;
  totalPrice: number;
  payablePrice: number;
}

export interface B2BSalesTopItem {
  modelName: string;
  totalQuantity: number;
}

export interface B2BSalesBranchBreakdown {
  branchId: string;
  branchName?: string;
  challanCount: number;
  totalPrice: number;
  payablePrice: number;
}

export interface B2BSalesKPIs {
  totalChallans: number;
  totalSalesValue: number;
  totalPayableValue: number;
  averageChallanValue: number;
  monthlyTrend: B2BSalesMonthlyTrendPoint[];
  topItems: B2BSalesTopItem[];
  branchBreakdown?: B2BSalesBranchBreakdown[];
}

export interface B2BSalesListFilters {
  page?: number;
  limit?: number;
  branchId?: string;
}
