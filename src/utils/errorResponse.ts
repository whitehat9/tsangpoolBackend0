/**
 * Machine-readable error codes.
 *
 * The client matches on these rather than on `message`, so wording can change
 * without breaking behaviour.
 */
export const ERROR_CODES = {
  /**
   * This session can never succeed again — the token is unusable or the account
   * behind it no longer exists. The client logs out on sight of this.
   *
   * Deliberately NOT used for "you lack permission to do this", which is also a
   * 401 on some routes but leaves a perfectly valid session intact.
   */
  SESSION_INVALID: "SESSION_INVALID",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

class ErrorResponse extends Error {
  statusCode: number;
  code?: ErrorCode;

  constructor(message: string, statusCode: number, code?: ErrorCode) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export default ErrorResponse;
