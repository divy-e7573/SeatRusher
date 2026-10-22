/**
 * Single error envelope for the whole API, as required by AGENTS.md:
 * `{ error: { code, message } }`. A `requestId` is included so a user-visible
 * failure can be traced back to the exact structured log line.
 */

export const ERROR_CODE = {
  /** Request body / query / params failed validation. */
  BAD_REQUEST: 'BAD_REQUEST',
  /** Route does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** Unhandled server-side failure. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE] | (string & {});

export interface ErrorDetail {
  code: string;
  message: string;
  requestId: string;
}

export interface ErrorResponseBody {
  error: ErrorDetail;
}
