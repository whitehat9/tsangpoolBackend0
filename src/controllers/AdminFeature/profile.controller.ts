import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import crypto from "crypto";
import { UserProfileModel } from "../../models/UserProfile";
import { getUserRole } from "../../types/user.types";
import { findAccountByPhone, ROLE_MODEL_MAP } from "../../utils/roleModels";
import logger from "../../utils/logger";

const PHONE_REGEX = /^[6-9]\d{9}$/;

// Matches the `minlength: 6` on every role schema's password field, so the
// request is rejected with a readable message instead of a Mongoose
// ValidationError thrown from save().
const MIN_PASSWORD_LENGTH = 6;

/**
 * Shared security code required alongside the current password to change a
 * password. Configurable per environment; `ilix99` is the built-in default so
 * the feature works without any new env wiring.
 */
const PASSWORD_UPDATE_CODE = process.env.PASSWORD_UPDATE_CODE || "ilix99";

/**
 * Constant-time comparison of the submitted code against the configured one.
 * Both sides are hashed first so `timingSafeEqual` always gets equal-length
 * buffers — comparing raw strings would throw on a length mismatch and leak
 * the code's length through the error.
 */
function matchesSecurityCode(submitted: unknown): boolean {
  if (typeof submitted !== "string") return false;
  const a = crypto.createHash("sha256").update(submitted.trim()).digest();
  const b = crypto.createHash("sha256").update(PASSWORD_UPDATE_CODE).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Shape the merged profile: identity from the authenticated role document,
 * extras from UserProfile.
 */
function buildProfile(user: any, profile: any) {
  const branch =
    user.branch && typeof user.branch === "object"
      ? { _id: user.branch._id, branchName: user.branch.branchName }
      : undefined;

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phoneNumber: user.phoneNumber,
    role: getUserRole(user),
    position: user.position,
    branch,
    // Address: profile override first, then the role-model address (Super-Admin
    // has none, so it may be undefined).
    address: profile?.address ?? user.address,
    bloodGroup: profile?.bloodGroup,
    lifeInsurance: profile?.lifeInsurance,
    scanfleetStickerId: profile?.scanfleetStickerId,
  };
}

/**
 * @desc    Get the current user's merged profile (identity + extras)
 * @route   GET /api/users/me
 * @access  Any authenticated user
 */
export const getMe = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401);
    throw new Error("Not authorized");
  }

  const user = req.user as any;
  const profile = await UserProfileModel.findOne({ userId: user._id });

  res.status(200).json({ success: true, data: buildProfile(user, profile) });
});

/**
 * @desc    Upsert the current user's profile extras
 * @route   PATCH /api/users/me
 * @access  Any authenticated user (own profile only)
 */
export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401);
    throw new Error("Not authorized");
  }

  const user = req.user as any;
  const { bloodGroup, lifeInsurance, scanfleetStickerId, address, phoneNumber } =
    req.body;

  // phoneNumber lives on the role document itself (matches the other 4 roles),
  // not on UserProfile — it's the identity used for OTP login, so it needs the
  // same format + cross-role uniqueness guarantees as account creation.
  if (phoneNumber !== undefined) {
    if (!PHONE_REGEX.test(phoneNumber)) {
      res.status(400);
      throw new Error("Please provide a valid 10-digit phone number");
    }

    const match = await findAccountByPhone(phoneNumber);
    if (match && match.doc._id.toString() !== user._id.toString()) {
      res.status(409);
      throw new Error("This phone number is already registered to another account");
    }

    user.phoneNumber = phoneNumber;
    await user.save();
  }

  // Only set fields that were actually provided.
  const set: Record<string, unknown> = { role: getUserRole(user) };
  if (bloodGroup !== undefined) set.bloodGroup = bloodGroup;
  if (lifeInsurance !== undefined) set.lifeInsurance = lifeInsurance;
  if (scanfleetStickerId !== undefined) set.scanfleetStickerId = scanfleetStickerId;
  if (address !== undefined) set.address = address;

  const profile = await UserProfileModel.findOneAndUpdate(
    { userId: user._id },
    { $set: set, $setOnInsert: { userId: user._id } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  logger.info(`Profile updated for ${getUserRole(user)} ${user._id}`);

  res.status(200).json({
    success: true,
    message: "Profile updated",
    data: buildProfile(user, profile),
  });
});

/**
 * @desc    Change the current user's own login password
 * @route   PATCH /api/users/me/password
 * @access  Any authenticated role (own password only)
 *
 * Three factors are required: the current password, a shared security code,
 * and the new password. The security code is a second gate so that a
 * briefly-unattended logged-in session can't be used to lock the real owner
 * out of their account — knowing the session isn't enough, you also have to
 * know the code.
 *
 * Note: the access token is a stateless 200-day JWT with no refresh token and
 * no revocation list (see utils/jwt.ts), so tokens issued before the change
 * keep working until they expire. Changing the password stops *new* logins
 * with the old one; it does not sign other devices out.
 */
export const changeMyPassword = asyncHandler(
  async (req: Request, res: Response) => {
    if (!req.user) {
      res.status(401);
      throw new Error("Not authorized");
    }

    const user = req.user as any;
    const role = getUserRole(user);
    const { currentPassword, securityCode, newPassword } = req.body ?? {};

    if (!currentPassword || !securityCode || !newPassword) {
      res.status(400);
      throw new Error(
        "Current password, security code and new password are all required",
      );
    }

    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
      res.status(400);
      throw new Error(
        `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }

    if (newPassword === currentPassword) {
      res.status(400);
      throw new Error("New password must be different from the current one");
    }

    if (!matchesSecurityCode(securityCode)) {
      logger.warn(`Password change rejected — bad security code: ${role} ${user._id}`);
      res.status(403);
      throw new Error("Invalid security code");
    }

    // `protect` resolves the user with `.select("-password")`, so the hash
    // isn't on req.user — re-fetch from the role's own collection with it.
    const model = ROLE_MODEL_MAP[role];
    if (!model) {
      res.status(400);
      throw new Error(`Password change is not supported for role "${role}"`);
    }

    const account = await model.findById(user._id).select("+password");
    if (!account) {
      res.status(404);
      throw new Error("Account not found");
    }

    if (!(await account.matchPassword(currentPassword))) {
      logger.warn(`Password change rejected — wrong current password: ${role} ${user._id}`);
      res.status(401);
      throw new Error("Current password is incorrect");
    }

    // Assigning the plaintext is deliberate: every role schema has a
    // pre("save") hook that bcrypt-hashes `password` when it is modified.
    account.password = newPassword;
    await account.save();

    logger.info(`Password changed for ${role} ${user._id}`);

    res.status(200).json({
      success: true,
      message:
        "Password updated. Use your new password the next time you log in.",
    });
  },
);
