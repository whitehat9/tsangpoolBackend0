import jwt, { SignOptions } from "jsonwebtoken";
import logger from "./logger";

/**
 * Access-token lifetime. Deliberately hardcoded rather than read from
 * `JWT_EXPIRE`: there is no refresh-token mechanism any more, so this single
 * value is the whole session length. Reading it from the environment would
 * mean a stale `JWT_EXPIRE=15m` left over in Cloud Run silently logging
 * everyone out every 15 minutes with nothing to renew the token.
 *
 * After 200 days the token simply expires, `protect` returns 401, and the
 * client clears its session and sends the user back to the login screen.
 */
const ACCESS_TOKEN_EXPIRES_IN: SignOptions["expiresIn"] = "200d";

export const generateToken = (payload: object): string => {
  // Verify secret exists
  if (!process.env.JWT_SECRET) {
    logger.error("JWT secret is not configured");
    throw new Error("JWT secret is not configured");
  }

  try {
    const options: SignOptions = {
      expiresIn: ACCESS_TOKEN_EXPIRES_IN,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, options);

    // Log token generation (first few characters only)
    logger.debug("Token generated successfully:", {
      payload,
      tokenPrefix: token.substring(0, 10) + "...",
    });

    return token;
  } catch (error) {
    logger.error("Token generation failed:", error);
    throw new Error("Failed to generate authentication token");
  }
};

export const verifyToken = (token: string): jwt.JwtPayload => {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT secret is not configured");
  }

  return jwt.verify(token, process.env.JWT_SECRET) as jwt.JwtPayload;
};
