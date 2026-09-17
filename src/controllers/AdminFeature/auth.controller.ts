import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import Admin from "../../models/Admin";
import BranchManager from "../../models/BranchManager";
import ServiceAdmin from "../../models/ServiceAdmin";
import PartAdmin from "../../models/PartAdmin";
import Developer from "../../models/Developer";
import Staff from "../../models/Staff";
import logger from "../../utils/logger";
import { findAccountByPhone } from "../../utils/roleModels";
import firebaseAdmin from "../../config/firebaseAdmin";

// ─── Super-Admin Login ───────────────────────────────────────────────────────

export const loginSuperAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || !password) {
      res
        .status(400)
        .json({ success: false, message: "Email and password are required" });
      return;
    }

    const admin = await Admin.findOne({ email }).select("+password");

    if (!admin || !(await admin.matchPassword(password))) {
      logger.info(`Failed login attempt for email: ${email}`);
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    if (!admin.isActive) {
      res
        .status(403)
        .json({ success: false, message: "Account is deactivated" });
      return;
    }

    const token = admin.getSignedJwtToken();
    logger.info(`Admin logged in: ${admin.email}`);

    res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        token,
      },
    });
  },
);

// ─── Super-Admin Logout ──────────────────────────────────────────────────────

export const logoutSuperAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    // Stateless JWT — nothing to revoke server-side; see `logout` below.
    logger.info(`Admin logged out: ${(req as any).user?.email || "unknown"}`);

    res.status(200).json({
      success: true,
      message: "Logout successful",
      data: { loggedOutAt: new Date().toISOString() },
    });
  },
);

// ─── Branch-Admin Login ──────────────────────────────────────────────────────

export const loginBranchAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const { phoneNumber, password } = req.body;

    if (!phoneNumber || !password) {
      res.status(400).json({
        success: false,
        message: "Phone number and password are required",
      });
      return;
    }

    const bm = await BranchManager.findOne({ phoneNumber }).select("+password");

    if (!bm || !(await bm.matchPassword(password))) {
      logger.info(`Failed Branch-Admin login: ${phoneNumber}`);
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    if (!bm.isActive) {
      res
        .status(403)
        .json({ success: false, message: "Account is deactivated" });
      return;
    }

    await bm.populate("branch", "branchName address");
    const token = bm.getSignedJwtToken();
    logger.info(`Branch-Admin logged in: ${bm.phoneNumber}`);

    res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        id: bm._id,
        name: bm.name,
        phoneNumber: bm.phoneNumber,
        branch: bm.branch,
        role: "Branch-Admin",
        token,
      },
    });
  },
);

// ─── Service-Admin Login ─────────────────────────────────────────────────────

export const loginServiceAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const { phoneNumber, password } = req.body;

    if (!phoneNumber || !password) {
      res.status(400).json({
        success: false,
        message: "Phone number and password are required",
      });
      return;
    }

    const sa = await ServiceAdmin.findOne({ phoneNumber }).select("+password");

    if (!sa || !(await sa.matchPassword(password))) {
      logger.info(`Failed Service-Admin login: ${phoneNumber}`);
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    if (!sa.isActive) {
      res
        .status(403)
        .json({ success: false, message: "Account is deactivated" });
      return;
    }

    await sa.populate("branch", "branchName address");
    const token = sa.getSignedJwtToken();
    logger.info(`Service-Admin logged in: ${sa.phoneNumber}`);

    res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        id: sa._id,
        name: sa.name,
        phoneNumber: sa.phoneNumber,
        branch: sa.branch,
        role: "Service-Admin",
        token,
      },
    });
  },
);

// ─── Part-Admin Login ────────────────────────────────────────────────────────

export const loginPartAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    const { phoneNumber, password } = req.body;

    if (!phoneNumber || !password) {
      res.status(400).json({
        success: false,
        message: "Phone number and password are required",
      });
      return;
    }

    const pa = await PartAdmin.findOne({ phoneNumber }).select("+password");

    if (!pa || !(await pa.matchPassword(password))) {
      logger.info(`Failed Part-Admin login: ${phoneNumber}`);
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    if (!pa.isActive) {
      res
        .status(403)
        .json({ success: false, message: "Account is deactivated" });
      return;
    }

    await pa.populate("branch", "branchName address");
    const token = pa.getSignedJwtToken();
    logger.info(`Part-Admin logged in: ${pa.phoneNumber}`);

    res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        id: pa._id,
        name: pa.name,
        phoneNumber: pa.phoneNumber,
        branch: pa.branch,
        role: "Part-Admin",
        token,
      },
    });
  },
);

// ─── Developer Login ─────────────────────────────────────────────────────────

/**
 * @desc    Developer login. Email-based (not phone) — Developer is a
 *          project-wide technical account, like Super-Admin, rather than a
 *          branch role.
 * @route   POST /api/auth/developer/login
 * @access  Public
 */
export const loginDeveloper = asyncHandler(
  async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
      return;
    }

    const dev = await Developer.findOne({
      email: String(email).toLowerCase().trim(),
    }).select("+password");

    if (!dev || !(await dev.matchPassword(password))) {
      logger.info(`Failed Developer login: ${email}`);
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    if (!dev.isActive) {
      res
        .status(403)
        .json({ success: false, message: "Account is deactivated" });
      return;
    }

    const token = dev.getSignedJwtToken();
    logger.info(`Developer logged in: ${dev.email}`);

    res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        id: dev._id,
        name: dev.name,
        email: dev.email,
        phoneNumber: dev.phoneNumber,
        role: "Developer",
        token,
      },
    });
  },
);

// ─── Staff Login ─────────────────────────────────────────────────────────────

export const loginStaff = asyncHandler(async (req: Request, res: Response) => {
  const { phoneNumber, password } = req.body;

  if (!phoneNumber || !password) {
    res.status(400).json({
      success: false,
      message: "Phone number and password are required",
    });
    return;
  }

  const staff = await Staff.findOne({ phoneNumber }).select("+password");

  if (!staff || !(await staff.matchPassword(password))) {
    logger.info(`Failed Staff login: ${phoneNumber}`);
    res.status(401).json({ success: false, message: "Invalid credentials" });
    return;
  }

  if (!staff.isActive) {
    res.status(403).json({ success: false, message: "Account is deactivated" });
    return;
  }

  await staff.populate("branch", "branchName address");
  const token = staff.getSignedJwtToken();
  logger.info(`Staff logged in: ${staff.phoneNumber}`);

  res.status(200).json({
    success: true,
    message: "Login successful",
    data: {
      id: staff._id,
      name: staff.name,
      phoneNumber: staff.phoneNumber,
      branch: staff.branch,
      position: staff.position,
      role: "Staff",
      token,
    },
  });
});

// ─── OTP Login (Super-Admin, Branch-Admin, Service-Admin, Part-Admin, Staff) ─
// Phone number must already be registered on an existing role record (set at
// account-creation time, or self-added via profile update). Unregistered
// phone numbers are rejected — OTP proves phone ownership, not identity.

export const checkOtpPhone = asyncHandler(
  async (req: Request, res: Response) => {
    const { phoneNumber } = req.body;

    if (!phoneNumber || !/^[6-9]\d{9}$/.test(phoneNumber)) {
      res
        .status(400)
        .json({ success: false, exists: false, message: "Invalid phone number format" });
      return;
    }

    const match = await findAccountByPhone(phoneNumber);

    res.status(200).json({
      success: true,
      exists: !!match,
      message: match ? "Phone number found" : "Phone number not found",
    });
  },
);

export const otpLogin = asyncHandler(async (req: Request, res: Response) => {
  const { idToken } = req.body;

  if (!idToken) {
    res.status(400).json({ success: false, message: "ID token is required" });
    return;
  }

  let decodedToken;
  try {
    decodedToken = await firebaseAdmin.auth().verifyIdToken(idToken);
  } catch (error) {
    logger.info("OTP login rejected — invalid Firebase token");
    res.status(401).json({ success: false, message: "Invalid or expired OTP session" });
    return;
  }

  let phoneNumber = decodedToken.phone_number;
  if (!phoneNumber) {
    res.status(400).json({ success: false, message: "Phone number not found in token" });
    return;
  }
  if (phoneNumber.startsWith("+91")) {
    phoneNumber = phoneNumber.substring(3);
  }

  const match = await findAccountByPhone(phoneNumber);

  if (!match) {
    logger.info(`OTP login rejected — unregistered phone: ${phoneNumber}`);
    res.status(404).json({
      success: false,
      message:
        "This phone number is not registered with any account. Contact your administrator.",
    });
    return;
  }

  const { role, doc } = match;

  if (!doc.isActive) {
    res.status(403).json({ success: false, message: "Account is deactivated" });
    return;
  }

  if (doc.branch) {
    await doc.populate("branch", "branchName address");
  }

  const token = doc.getSignedJwtToken();
  logger.info(`${role} logged in via OTP: ${phoneNumber}`);

  const data: Record<string, unknown> = {
    id: doc._id,
    name: doc.name,
    role,
    token,
  };
  if (role === "Super-Admin") {
    data.email = doc.email;
  } else {
    data.phoneNumber = doc.phoneNumber;
    data.branch = doc.branch;
  }
  if (role === "Staff") {
    data.position = doc.position;
  }

  res.status(200).json({ success: true, message: "Login successful", data });
});

// ─── Generic Logout (works for any authenticated user) ──────────────────────
// There is no server-side session to revoke: the access token is a stateless
// JWT and no refresh token is issued. Logout is purely a client-side action —
// this endpoint exists so the client has something to await, and so the action
// stays auditable in the logs.

export const logout = asyncHandler(async (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "Logout successful",
  });
});
