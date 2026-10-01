import multer from "multer";
import { Request } from "express";

// Enhanced file filter for multiple image types
const imageFileFilter = (
  req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  if (file.mimetype.startsWith("image/")) {
    const allowedImageTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "image/avif",
      "image/gif",
      "image/bmp",
      "image/tiff",
      "image/svg+xml",
    ];

    if (allowedImageTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Image format ${file.mimetype} not supported. 
Supported formats: JPEG, PNG, WebP, AVIF, GIF, BMP, TIFF, SVG`
        )
      );
    }
  } else {
    cb(new Error("Only image files are allowed"));
  }
};

const MB = 1024 * 1024;

/**
 * Each upload config stamps its own fileSize limit on the request so
 * handleMulterError can name the real number when a file is rejected.
 * multer's MulterError carries no limit value and the handler is shared by
 * every config below, so there is nothing else to derive it from — the
 * alternative is a hardcoded number in the handler that silently goes stale
 * the moment any single config's limit changes.
 *
 * fileFilter is the hook that has `req`, and multer always calls it when the
 * file part starts — i.e. before the size limit can trip — so the value is
 * always in place by the time LIMIT_FILE_SIZE fires.
 */
const recordUploadLimit = (req: Request, bytes: number) => {
  (req as any).uploadMaxBytes = bytes;
};

const formatMb = (bytes: number) => `${Math.round(bytes / MB)}MB`;

// Enhanced multer configuration for bike uploads
const BIKE_UPLOAD_MAX_BYTES = 10 * MB;

export const bikeUploadConfig = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: BIKE_UPLOAD_MAX_BYTES, // 10MB limit per image
    files: 10, // Maximum 10 images for bikes
  },
  fileFilter: (req, file, cb) => {
    recordUploadLimit(req, BIKE_UPLOAD_MAX_BYTES);
    imageFileFilter(req, file, cb);
  },
});

// Enhanced error handler for multer errors
export const handleMulterError = (
  error: any,
  req: Request,
  res: any,
  next: any
) => {
  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case "LIMIT_FILE_SIZE": {
        // The frontend surfaces `message`, not `error`, so the actual limit
        // has to be in the message — "File size too large" on its own leaves
        // the user guessing how much they need to trim.
        const maxBytes = (req as any).uploadMaxBytes as number | undefined;
        const limitText = maxBytes ? formatMb(maxBytes) : "the allowed size";
        return res.status(400).json({
          success: false,
          message: `File is too large — maximum ${limitText}`,
          error: `Maximum file size allowed is ${limitText}`,
        });
      }
      case "LIMIT_FILE_COUNT":
        return res.status(400).json({
          success: false,
          message: "Too many files",
          error: `Maximum ${
            req.route.path.includes("bike")
              ? "10"
              : req.route.path.includes("photo")
              ? "10"
              : req.route.path.includes("press")
              ? "5"
              : "2"
          } files allowed`,
        });
      case "LIMIT_UNEXPECTED_FILE":
        return res.status(400).json({
          success: false,
          message: "Unexpected field",
          error: "Only allowed file fields are accepted",
        });
      default:
        return res.status(400).json({
          success: false,
          message: "File upload error",
          error: error.message,
        });
    }
  }

  // Handle custom file filter errors
  if (
    error.message.includes("not supported") ||
    error.message.includes("required") ||
    error.message.includes("Only")
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid file type",
      error: error.message,
    });
  }

  // Pass other errors to the general error handler
  next(error);
};
// Stock CSV upload — accepts CSV and Excel (xls/xlsx) files.
const CSV_STOCK_EXTENSIONS = [".csv", ".xls", ".xlsx"];
const CSV_STOCK_MIME_TYPES = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

const CSV_STOCK_MAX_BYTES = 5 * MB;

export const csvUploadConfig = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: CSV_STOCK_MAX_BYTES,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    recordUploadLimit(req, CSV_STOCK_MAX_BYTES);
    const name = file.originalname.toLowerCase();
    const okByExt = CSV_STOCK_EXTENSIONS.some((ext) => name.endsWith(ext));
    const okByMime = CSV_STOCK_MIME_TYPES.includes(file.mimetype);
    if (okByExt || okByMime) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV, XLS, and XLSX files allowed"));
    }
  },
});

// Parts report upload — accepts spreadsheet (xlsx/csv) and PDF files.
const PARTS_REPORT_MIME_TYPES = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
];
const PARTS_REPORT_EXTENSIONS = [".csv", ".xls", ".xlsx", ".pdf"];

const PARTS_REPORT_MAX_BYTES = 10 * MB; // PDFs can be larger

export const partsReportConfig = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: PARTS_REPORT_MAX_BYTES,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    recordUploadLimit(req, PARTS_REPORT_MAX_BYTES);
    const name = file.originalname.toLowerCase();
    const okByExt = PARTS_REPORT_EXTENSIONS.some((ext) => name.endsWith(ext));
    const okByMime = PARTS_REPORT_MIME_TYPES.includes(file.mimetype);
    if (okByExt || okByMime) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV, XLSX, and PDF files allowed"));
    }
  },
});

// Counter sale report upload — accepts spreadsheet (xlsx/csv) files only.
const COUNTER_SALE_REPORT_MIME_TYPES = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const COUNTER_SALE_REPORT_EXTENSIONS = [".csv", ".xls", ".xlsx"];

const COUNTER_SALE_REPORT_MAX_BYTES = 10 * MB;

export const counterSaleReportConfig = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: COUNTER_SALE_REPORT_MAX_BYTES,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    recordUploadLimit(req, COUNTER_SALE_REPORT_MAX_BYTES);
    const name = file.originalname.toLowerCase();
    const okByExt = COUNTER_SALE_REPORT_EXTENSIONS.some((ext) =>
      name.endsWith(ext),
    );
    const okByMime = COUNTER_SALE_REPORT_MIME_TYPES.includes(file.mimetype);
    if (okByExt || okByMime) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV and XLSX files allowed"));
    }
  },
});

// Sales report upload (already-sold vehicles) — accepts spreadsheet
// (xlsx/xls/xlt/csv) files only.
//
// The legacy Excel *template* extensions (.xlt / .xltx / .xltm) are accepted
// alongside the workbook ones because older dealer export tools still emit
// them: an .xlt is an ordinary OLE2/CFB workbook with a template extension,
// and SheetJS reads it from the magic bytes without caring about the name
// (see dataImport.service.ts#parseSpreadsheet). Browsers are inconsistent
// about the mimetype they attach to these — .xlt may arrive as
// application/vnd.ms-excel, as the template type below, or as
// application/octet-stream — which is why the extension check is what
// actually admits them.
const SALES_REPORT_MIME_TYPES = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.template.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
];
const SALES_REPORT_EXTENSIONS = [
  ".csv",
  ".xls",
  ".xlsx",
  ".xlt",
  ".xltx",
  ".xltm",
];

/**
 * 25MB rather than the 10MB the other report imports use. Legacy Excel
 * exports (.xls/.xlt) are far bulkier than the equivalent .xlsx for the same
 * number of rows — BIFF8 stores uncompressed records with per-cell
 * formatting, and the mislabeled UTF-16 text dumps some dealer tools emit
 * carry two bytes per character. The same sold-vehicle report can therefore
 * clear 10MB in the old format while sitting comfortably under it as .xlsx.
 *
 * Kept well under Cloud Run's 32MB request body cap, which this upload has
 * no way to work around.
 */
const SALES_REPORT_MAX_BYTES = 25 * MB;

export const salesReportConfig = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: SALES_REPORT_MAX_BYTES,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    recordUploadLimit(req, SALES_REPORT_MAX_BYTES);
    const name = file.originalname.toLowerCase();
    const okByExt = SALES_REPORT_EXTENSIONS.some((ext) => name.endsWith(ext));
    const okByMime = SALES_REPORT_MIME_TYPES.includes(file.mimetype);
    if (okByExt || okByMime) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV, XLS/XLSX, and XLT files allowed"));
    }
  },
});
