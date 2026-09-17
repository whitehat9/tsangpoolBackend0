import asyncHandler from "express-async-handler";
import { Request, Response } from "express";

import logger from "../../utils/logger";
import { BaseCustomerModel } from "../../models/CustomerSystem/BaseCustomer";
import { CustomerProfileModel } from "../../models/CustomerSystem/CustomerProfile";
import { CustomerVehicleModel } from "../../models/BikeSystemModel2/CustomerVehicleModel";
import { ServiceInvoiceModel } from "../../models/ServiceInvoice/ServiceInvoice";
import { SalesReportModel } from "../../models/SalesReport";
import { normalizePhone } from "../../service/salesReport.service";
import {
  CUSTOMER_SOURCE_TAGS,
  CustomerSourceTag,
  buildCustomerSourceIndex,
  customerSourceFilter,
  customerSourceTags,
  isCustomerSourceTag,
} from "../../service/customerSources.service";
import admin from "firebase-admin";

/**
 * @desc    Save customer data after Firebase OTP verification
 * @route   POST /api/customer/save-auth-data
 * @access  Public
 */
export const saveAuthData = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      const { phoneNumber, firebaseUid } = req.body;

      if (!phoneNumber) {
        res.status(400);
        throw new Error("Phone number is required");
      }

      // Create or update base customer (only phone number and verification status)
      let customer = await BaseCustomerModel.findOne({ phoneNumber });

      if (customer) {
        // Update existing customer
        customer.isVerified = true;
        if (firebaseUid) {
          customer.firebaseUid = firebaseUid;
        }
        await customer.save();
      } else {
        // Create new customer
        customer = await BaseCustomerModel.create({
          phoneNumber,
          firebaseUid,
          isVerified: true,
        });
      }

      logger.info(`OTP verified for customer: ${phoneNumber}`);

      res.status(200).json({
        success: true,
        message: "OTP verification successful",
        data: {
          customer: {
            _id: customer._id,
            phoneNumber: customer.phoneNumber,
            isVerified: customer.isVerified,
            profileCompleted: false, // Profile not created yet
          },
        },
      });
    } catch (error) {
      console.warn("OTP verification error:", error);
      res.status(400);
      throw new Error("OTP verification failed");
    }
  }
);
/**
 * @desc    Branch-Admin registers a new customer without the OTP flow. Finds
 *          or creates a Firebase Auth user for the phone number and mints a
 *          custom token, which the Branch-Admin's browser silently exchanges
 *          for a real Firebase ID token (no SMS, no code entry). This keeps
 *          the rest of onboarding (profile/vehicle/VAS creation) working
 *          unchanged, since it still runs on a genuine Firebase session — a
 *          customer's own future login still goes through real OTP.
 * @route   POST /api/customer/branch-admin-register
 * @access  Private (Branch-Admin, Super-Admin)
 */
export const registerCustomerByBranchAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const { phoneNumber } = req.body;

    if (!phoneNumber || !/^[6-9]\d{9}$/.test(phoneNumber)) {
      res.status(400);
      throw new Error("Valid 10-digit phone number is required");
    }

    let customer = await BaseCustomerModel.findOne({ phoneNumber });

    let firebaseUid = customer?.firebaseUid;
    if (!firebaseUid) {
      const firebasePhone = `+91${phoneNumber}`;
      try {
        const existingFirebaseUser = await admin
          .auth()
          .getUserByPhoneNumber(firebasePhone);
        firebaseUid = existingFirebaseUser.uid;
      } catch (error: any) {
        if (error.code !== "auth/user-not-found") throw error;
        const newFirebaseUser = await admin.auth().createUser({
          phoneNumber: firebasePhone,
        });
        firebaseUid = newFirebaseUser.uid;
      }
    }

    if (!customer) {
      customer = await BaseCustomerModel.create({
        phoneNumber,
        firebaseUid,
        isVerified: true,
        creationSource: "branch_admin_manual",
      });
    } else if (!customer.firebaseUid) {
      customer.firebaseUid = firebaseUid;
      customer.isVerified = true;
      await customer.save();
    }

    const customToken = await admin.auth().createCustomToken(firebaseUid);
    const profile = await CustomerProfileModel.findOne({
      customer: customer._id,
    });

    logger.info(
      `Branch-Admin registered/linked customer ${phoneNumber} without OTP (by ${req.user?._id})`,
    );

    res.status(200).json({
      success: true,
      message: "Customer registered",
      data: {
        customer: {
          _id: customer._id,
          phoneNumber: customer.phoneNumber,
          isVerified: customer.isVerified,
          profileCompleted: !!profile?.profileCompleted,
        },
        customToken,
      },
    });
  },
);

/**
 * @desc    Customer login
 * @route   POST /api/customer/login
 * @access  Public
 */
export const loginCustomer = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { idToken } = req.body;

    if (!idToken) {
      res.status(400);
      throw new Error("ID token is required");
    }

    try {
      // Verify Firebase token
      const decodedToken = await admin.auth().verifyIdToken(idToken);

      // Get phone number from verified token and normalize it
      let phoneNumber = decodedToken.phone_number;

      if (!phoneNumber) {
        res.status(400);
        throw new Error("Phone number not found in token");
      }

      // Normalize the phone number by removing the country code
      // If phone number starts with +91, remove it
      if (phoneNumber.startsWith("+91")) {
        phoneNumber = phoneNumber.substring(3); // Remove +91 prefix
      }

      // Find customer in your database with the normalized phone number
      const customer = await BaseCustomerModel.findOne({ phoneNumber });

      if (!customer) {
        res.status(404);
        throw new Error("Customer not found. Please register first.");
      }

      if (!customer.isVerified) {
        res.status(401);
        throw new Error("Customer account is not verified");
      }

      // Get profile
      const profile = await CustomerProfileModel.findOne({
        customer: customer._id,
      });

      res.status(200).json({
        success: true,
        message: "Login successful",
        data: {
          customer: {
            _id: customer._id,
            phoneNumber: customer.phoneNumber,
            isVerified: customer.isVerified,
            profileCompleted: !!profile?.profileCompleted,
          },
          token: idToken,
        },
      });
    } catch (error: unknown) {
      console.error("Login error:", error);

      if (error instanceof Error) {
        // If the error is already set with a specific status, don't change it
        if (!res.statusCode || res.statusCode === 200) {
          res.status(401);
        }
        throw error;
      } else {
        res.status(500);
        throw new Error("An unexpected error occurred during login");
      }
    }
  }
);
/** Escape user input before it becomes a RegExp, so "." or "+" can't widen the match. */
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @desc    List customers, newest first — shared across every admin/staff
 *          role (Super-Admin, Branch-Admin, Service-Admin, Part-Admin,
 *          Staff). Not branch-scoped: customers aren't modeled with a branch
 *          field, so this is a single cross-branch feed.
 *
 *          This is the combined view over all four pipelines that put a
 *          customer on record — uploaded sales reports, manual-form stock
 *          assignment, CSV/daily stock assignment, and service-invoice
 *          uploads (see service/customerSources.service.ts). Every row
 *          carries the tags it matches, `sourceCounts` totals each pipeline
 *          across the whole (search/date-filtered) set, and `?source=` narrows
 *          the list to one of them.
 *
 * @route   GET /api/customer/list?page=&limit=&days=&search=&source=
 * @access  Private (any authenticated admin/staff role)
 */
export const getNewCustomers = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Composed with $and rather than merged into one object: the date, search
    // and source clauses each want their own $or, and a plain merge would let
    // the last one silently overwrite the others.
    const filters: Record<string, any>[] = [];

    const days = req.query.days ? Number(req.query.days) : undefined;
    if (days && Number.isFinite(days) && days > 0) {
      filters.push({
        createdAt: {
          $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
        },
      });
    }

    // A customer's name is not stored on BaseCustomer — it comes from their
    // CustomerProfile, or (for customers auto-created by an import, who have
    // no profile yet) from the free-text name on the sales-report row or
    // service invoice that created them, matched by phone. Searching names
    // therefore means resolving all three to ids/phones first, then filtering
    // BaseCustomer by the union. Doing it here rather than client-side keeps
    // `total` and paging honest.
    const search = String(req.query.search ?? "").trim();
    if (search) {
      const tokens = search.split(/\s+/).filter(Boolean).map(escapeRegex);
      const wholeRegex = new RegExp(escapeRegex(search), "i");

      // Every token must hit a name field, so "Himanku Borah" matches a
      // profile split across firstName/lastName.
      const nameFilterFor = (first: string, last: string) => ({
        $and: tokens.map((token) => {
          const rx = new RegExp(token, "i");
          return { $or: [{ [first]: rx }, { [last]: rx }] };
        }),
      });

      const [matchedProfiles, matchedInvoicePhones, matchedSalesRows] =
        await Promise.all([
          CustomerProfileModel.find(
            nameFilterFor("firstName", "lastName"),
          )
            .select("customer")
            .lean(),
          ServiceInvoiceModel.distinct("customerMobile", {
            customerName: wholeRegex,
            isActive: true,
          }),
          SalesReportModel.find({
            isActive: true,
            ...nameFilterFor("customerFirstName", "customerLastName"),
          })
            .select("customerId customerMobile")
            .lean(),
        ]);

      const salesReportPhones = matchedSalesRows
        .map((row) => normalizePhone(row.customerMobile))
        .filter((phone): phone is string => Boolean(phone));

      filters.push({
        $or: [
          { phoneNumber: wholeRegex },
          { _id: { $in: matchedProfiles.map((p) => p.customer) } },
          { phoneNumber: { $in: matchedInvoicePhones } },
          {
            _id: {
              $in: matchedSalesRows
                .map((row) => row.customerId)
                .filter(Boolean),
            },
          },
          { phoneNumber: { $in: salesReportPhones } },
        ],
      });
    }

    const sourceIndex = await buildCustomerSourceIndex();

    const requestedSource = String(req.query.source ?? "").trim();
    if (requestedSource && !isCustomerSourceTag(requestedSource)) {
      res.status(400);
      throw new Error(
        `Unknown source "${requestedSource}" — expected one of ${CUSTOMER_SOURCE_TAGS.join(", ")}`,
      );
    }

    const toQuery = (clauses: Record<string, any>[]) =>
      clauses.length ? { $and: clauses } : {};

    // Counts are deliberately computed against the date/search filters but
    // WITHOUT the source filter, so the tab labels keep showing how many
    // customers each other pipeline holds while one tab is selected.
    const sourceCountEntries = await Promise.all(
      CUSTOMER_SOURCE_TAGS.map(async (tag) => {
        const count = await BaseCustomerModel.countDocuments(
          toQuery([...filters, customerSourceFilter(tag, sourceIndex)]),
        );
        return [tag, count] as const;
      }),
    );
    const sourceCounts = Object.fromEntries(sourceCountEntries) as Record<
      CustomerSourceTag,
      number
    >;

    if (requestedSource) {
      filters.push(
        customerSourceFilter(requestedSource as CustomerSourceTag, sourceIndex),
      );
    }

    const query = toQuery(filters);

    const [customers, total] = await Promise.all([
      BaseCustomerModel.find(query)
        .select("phoneNumber isVerified creationSource createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      BaseCustomerModel.countDocuments(query),
    ]);

    const customerIds = customers.map((c) => c._id);
    const phoneNumbers = customers.map((c) => c.phoneNumber);
    const [profiles, vehicles, invoiceRows, salesRows] = await Promise.all([
      CustomerProfileModel.find({ customer: { $in: customerIds } }).select(
        "customer firstName lastName",
      ),
      CustomerVehicleModel.find({ customer: { $in: customerIds } }).select(
        "customer stockType stockConcept",
      ).populate("stockConcept"),
      // Auto-registered customers (see serviceInvoice/autoRegister.service.ts)
      // have no CustomerProfile until they onboard themselves — fall back to
      // the free-text Customer Name on the service invoice that created them,
      // matched by phone number, most recent first.
      ServiceInvoiceModel.find({
        isActive: true,
        customerMobile: { $in: phoneNumbers },
        customerName: { $exists: true, $ne: "" },
      })
        .select("customerMobile customerName")
        .sort({ createdAt: -1 }),
      // Same idea for customers created from a Sales Report, which carries a
      // structured first/last name. Matched on customerId (exact, written by
      // the importer) with the raw mobile as a fallback for rows imported
      // before the importer linked one.
      SalesReportModel.find({
        isActive: true,
        $or: [
          { customerId: { $in: customerIds } },
          { customerMobile: { $in: phoneNumbers } },
        ],
      })
        .select("customerId customerMobile customerFirstName customerLastName")
        .sort({ createdAt: -1 }),
    ]);

    const profileByCustomer = new Map(
      profiles.map((p) => [p.customer.toString(), p]),
    );
    const vehicleCustomerIds = new Set(
      vehicles.map((v) => v.customer.toString()),
    );
    const vehicleByCustomer = new Map(
      vehicles.map((v) => [v.customer.toString(), v]),
    );
    const invoiceNameByPhone = new Map<string, string>();
    for (const row of invoiceRows) {
      const phone = row.customerMobile;
      const name = row.customerName;
      if (phone && name && !invoiceNameByPhone.has(phone)) {
        invoiceNameByPhone.set(phone, name);
      }
    }
    // Keyed by BOTH id and normalized phone so either match path resolves.
    const salesNameByKey = new Map<string, string>();
    for (const row of salesRows) {
      const name = `${row.customerFirstName ?? ""} ${row.customerLastName ?? ""}`.trim();
      if (!name) continue;
      const phone = normalizePhone(row.customerMobile);
      if (row.customerId && !salesNameByKey.has(row.customerId.toString())) {
        salesNameByKey.set(row.customerId.toString(), name);
      }
      if (phone && !salesNameByKey.has(phone)) salesNameByKey.set(phone, name);
    }

    const data = customers.map((c) => {
      const profile = profileByCustomer.get(c._id.toString());
      const profileName = profile
        ? `${profile.firstName} ${profile.lastName}`.trim()
        : "";
      return {
        _id: c._id,
        phoneNumber: c.phoneNumber,
        isVerified: c.isVerified,
        creationSource: c.creationSource,
        createdAt: c.createdAt,
        // Profile first (the customer's own, maintained record), then the
        // sales report's structured first/last name, then the invoice's
        // free-text one.
        name:
          profileName ||
          salesNameByKey.get(c._id.toString()) ||
          salesNameByKey.get(c.phoneNumber) ||
          invoiceNameByPhone.get(c.phoneNumber) ||
          null,
        sources: customerSourceTags(c, sourceIndex),
        hasVehicle: vehicleCustomerIds.has(c._id.toString()),
        vehicleSummary: (() => {
          const vehicle = vehicleByCustomer.get(c._id.toString()) as any;
          if (!vehicle?.stockConcept) return null;
          const stock = vehicle.stockConcept;

          return {
            // Both StockConcept and StockConceptCSV carry `engineNumber`, so it
            // identifies the vehicle across either stock type.
            engineNumber: stock.engineNumber ?? null,
            stockType: vehicle.stockType,
          };
        })(),
      };
    });

    res.status(200).json({
      success: true,
      data,
      sourceCounts,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  },
);
