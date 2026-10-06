/**
 * Shared Error Definitions for oRPC Contracts
 *
 * Define base error types that can be applied to contracts via `.errors()`.
 * These provide type-safe error handling on both client and server.
 *
 * @example
 * ```ts
 * import { oc } from "@orpc/contract";
 * import { baseErrors } from "../errors";
 *
 * export const myContract = oc
 *   .errors(baseErrors)
 *   .router({ ... });
 * ```
 */

import * as z from "zod";

/**
 * Base error definitions shared across all contracts.
 *
 * Uses the oRPC `.errors()` format: `{ CODE: { message?, data?, status? } }`
 * When thrown on the server, these errors are type-safe on the client via `isDefinedError`.
 *
 * Two constraints keep `isDefinedError()` working, both of which this file got
 * wrong before:
 *
 * 1. **Every key must be an oRPC standard code.** oRPC resolves status as
 *    `status ?? COMMON_ORPC_ERROR_DEFS[code]?.status ?? 500`. A non-standard
 *    code (the old `RATE_LIMITED` / `INTERNAL_ERROR`) resolves to 500 when
 *    thrown, which then disagrees with the `status` declared here — and
 *    `validateORPCError` treats a declared/actual status mismatch as
 *    `defined: false`. So the one error clients most want to narrow on could
 *    never be narrowed. Standard codes need no explicit `status` at all.
 * 2. **`data` schemas must accept `undefined`.** Throw sites pass no `data`,
 *    and a required `z.object({...})` fails to validate `undefined`, which
 *    also yields `defined: false`. Hence `.optional()`.
 */
export const baseErrors = {
	UNAUTHORIZED: {
		message: "Authentication required",
	},
	FORBIDDEN: {
		message: "Insufficient permissions",
	},
	NOT_FOUND: {
		message: "Resource not found",
	},
	BAD_REQUEST: {
		message: "Invalid request",
		data: z
			.object({
				details: z.string().optional(),
			})
			.optional(),
	},
	TOO_MANY_REQUESTS: {
		message: "Rate limit exceeded",
		data: z
			.object({
				retryAfter: z.number().optional(),
			})
			.optional(),
	},
	INTERNAL_SERVER_ERROR: {
		message: "Internal server error",
	},
} as const;
