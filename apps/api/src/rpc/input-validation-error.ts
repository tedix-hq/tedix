/**
 * Enrich oRPC's input-validation error so the message NAMES the offending
 * field(s) instead of the bare, opaque "Input validation failed".
 *
 * oRPC throws `ORPCError("BAD_REQUEST", { message: "Input validation failed",
 * data: { issues }, cause: ValidationError })` BEFORE the handler runs whenever
 * the input schema rejects (e.g. `home.ask` / `kernelRuntime.enqueueMessage`
 * called without the required `content`). The field name lives only in
 * `data.issues[].path`, which RPC/MCP callers that surface `error.message`
 * never see — so they get no hint about WHAT to fix.
 *
 * Wired as a handler `clientInterceptor` (apps/api/src/index.ts): those wrap the
 * procedure client, which runs input validation, so this catches the throw and
 * rethrows the same typed error with the field paths lifted into the message.
 * `data`/`cause` are preserved, so structured `issues` consumers are unaffected.
 */

import { ORPCError, ValidationError } from "@orpc/server";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const INPUT_VALIDATION_MESSAGE = "Input validation failed";

/** A standard-schema issue path is `(PropertyKey | { key: PropertyKey })[]`. */
type IssuePathSegment = PropertyKey | { readonly key: PropertyKey };
interface SchemaIssue {
	readonly message?: string;
	readonly path?: ReadonlyArray<IssuePathSegment> | undefined;
}

function formatIssuePath(
	path: ReadonlyArray<IssuePathSegment> | undefined,
): string | null {
	if (!path || path.length === 0) return null;
	return path
		.map((segment) =>
			isRecord(segment) && "key" in segment
				? String(segment.key)
				: String(segment),
		)
		.join(".");
}

/**
 * Render schema issues as `field: message; field: message`, de-duplicated and
 * field-first. Returns null when there is nothing nameable (no issues / empty),
 * so callers fall back to the original error untouched.
 */
export function describeValidationIssues(issues: unknown): string | null {
	if (!Array.isArray(issues) || issues.length === 0) return null;
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const raw of issues as SchemaIssue[]) {
		const field = formatIssuePath(raw?.path) ?? "(root)";
		const message =
			typeof raw?.message === "string" && raw.message ? raw.message : "invalid";
		const line = `${field}: ${message}`;
		if (seen.has(line)) continue;
		seen.add(line);
		parts.push(line);
	}
	return parts.length > 0 ? parts.join("; ") : null;
}

function extractIssues(error: ORPCError<string, unknown>): unknown {
	if (error.cause instanceof ValidationError) return error.cause.issues;
	if (isRecord(error.data) && Array.isArray(error.data.issues)) {
		return error.data.issues;
	}
	return null;
}

/**
 * If `error` is oRPC's generic input-validation rejection, return a new
 * `ORPCError` whose message names the failing field(s); otherwise return it
 * unchanged. Pure — safe to unit test and to call on every caught error.
 */
export function enrichInputValidationError(error: unknown): unknown {
	if (
		!(error instanceof ORPCError) ||
		error.code !== "BAD_REQUEST" ||
		error.message !== INPUT_VALIDATION_MESSAGE
	) {
		return error;
	}
	const described = describeValidationIssues(extractIssues(error));
	if (!described) return error;
	return new ORPCError("BAD_REQUEST", {
		message: `${INPUT_VALIDATION_MESSAGE}: ${described}`,
		data: error.data,
		cause: error.cause,
	});
}
