import express from "express";
import seedAdmin from "../../AdminPrivilege/seeder";
import { protect, authorize } from "../../middleware/authmiddleware";
import {
  loginSuperAdmin,
  logoutSuperAdmin,
  loginBranchAdmin,
  loginServiceAdmin,
  loginPartAdmin,
  loginDeveloper,
  loginStaff,
  logout,
  checkOtpPhone,
  otpLogin,
} from "../../controllers/AdminFeature/auth.controller";

const router = express.Router();

// Seed route (development only)
if (process.env.NODE_ENV === "development") {
  router.post("/seed", seedAdmin);
}

// ===== LOGIN (Public) =====
router.post("/super-admin/login", loginSuperAdmin);
router.post("/branch-admin/login", loginBranchAdmin);
router.post("/service-admin/login", loginServiceAdmin);
router.post("/part-admin/login", loginPartAdmin);
router.post("/developer/login", loginDeveloper);
router.post("/staff/login", loginStaff);
router.post("/check-phone", checkOtpPhone);
router.post("/otp-login", otpLogin);

// ===== LOGOUT (Protected — any authenticated role) =====
router.post(
  "/super-admin/logout",
  protect,
  authorize("Super-Admin"),
  logoutSuperAdmin,
);

router.post(
  "/logout",
  protect,
  // Developer was missed when the role was added, so DeveloperHeader's logout
  // got a 403 that its catch block swallowed. Super-Admin has its own
  // /super-admin/logout route above.
  authorize(
    "Branch-Admin",
    "Service-Admin",
    "Part-Admin",
    "Staff",
    "Developer",
  ),
  logout,
);

export default router;
