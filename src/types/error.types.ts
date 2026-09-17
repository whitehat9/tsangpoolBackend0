export interface CustomError extends Error {
  statusCode?: number;
  /** Stable machine-readable code (see utils/errorResponse.ts ERROR_CODES). */
  code?: string;
}
