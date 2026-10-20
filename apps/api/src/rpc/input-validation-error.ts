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

/**
 * Hard cap on the rendered description. Agents read this from a tool error;
 * past this length the hints stop being read and the issues list only repeats.
 */
const MAX_DESCRIPTION_LENGTH = 300;
/** Key names listed in the `received keys` / `expected` summary (each). */
const MAX_SUMMARY_KEYS = 8;
const MAX_KEY_NAME_LENGTH = 40;

const UUID_HINT_SUFFIX =
	'must be a full UUID; resolve a short id with list_work_item_cli_rows({ view: "board", idPrefix })';

/** A standard-schema issue path is `(PropertyKey | { key: PropertyKey })[]`. */
type IssuePathSegment = PropertyKey | { readonly key: PropertyKey };
/**
 * Standard-schema issue plus the zod fields we read for hints. Everything
 * beyond `message`/`path` is optional: oRPC forwards the validator's raw
 * issues, so a non-zod schema simply yields no hint.
 */
interface SchemaIssue {
	readonly message?: string;
	readonly path?: ReadonlyArray<IssuePathSegment> | undefined;
	readonly code?: string;
	readonly keys?: ReadonlyArray<unknown>;
	readonly maximum?: unknown;
}

function lastPathKey(
	path: ReadonlyArray<IssuePathSegment> | undefined,
): string | null {
	if (!path || path.length === 0) return null;
	const segment = path[path.length - 1];
	return isRecord(segment) && "key" in segment
		? String(segment.key)
		: String(segment);
}

/** Zod's `unrecognized_keys` issue, by code or by its message prefix. */
function isUnrecognizedKeysIssue(issue: SchemaIssue): boolean {
	return (
		issue.code === "unrecognized_keys" ||
		(typeof issue.message === "string" &&
			issue.message.startsWith("Unrecognized key"))
	);
}

/** A required property absent from the root object (not a nested one). */
function isMissingRootFieldIssue(issue: SchemaIssue): boolean {
	if (!issue.path || issue.path.length !== 1) return false;
	const message = typeof issue.message === "string" ? issue.message : "";
	return (
		(issue.code === "invalid_type" && message.endsWith("received undefined")) ||
		message === "Required"
	);
}

/**
 * Only KEY NAMES are ever rendered — never a submitted value. Key names are
 * still caller-supplied text, so they are clipped and counted.
 */
function formatKeyList(keys: ReadonlyArray<string>): string {
	const unique = [...new Set(keys)];
	const shown = unique
		.slice(0, MAX_SUMMARY_KEYS)
		.map((key) =>
			key.length > MAX_KEY_NAME_LENGTH
				? `${key.slice(0, MAX_KEY_NAME_LENGTH)}…`
				: key,
		);
	if (unique.length > MAX_SUMMARY_KEYS) shown.push("…");
	return `[${shown.join(", ")}]`;
}

/**
 * `received keys: [a, b]; expected: [c, d]` for a root-shape mistake, e.g. an
 * agent calling `getById({ ids: [...] })`. The validator reports received keys
 * on `unrecognized_keys` issues and the expected ones as missing root fields.
 * Nothing is added without an unrecognized key: a plain missing field is
 * already named by its own line, and the validator does not list the schema's
 * other keys.
 */
function describeRootShape(issues: ReadonlyArray<SchemaIssue>): string | null {
	const received: string[] = [];
	const expected: string[] = [];
	for (const issue of issues) {
		if (isUnrecognizedKeysIssue(issue) && Array.isArray(issue.keys)) {
			for (const key of issue.keys) {
				if (typeof key === "string" || typeof key === "number")
					received.push(String(key));
			}
		}
		if (isMissingRootFieldIssue(issue)) {
			const key = lastPathKey(issue.path);
			if (key) expected.push(key);
		}
	}
	if (received.length === 0) return null;
	const parts = [`received keys: ${formatKeyList(received)}`];
	if (expected.length > 0) parts.push(`expected: ${formatKeyList(expected)}`);
	return parts.join("; ");
}

function tooBigMaximum(issue: SchemaIssue): string | null {
	if (typeof issue.maximum === "number" || typeof issue.maximum === "bigint")
		return String(issue.maximum);
	const match =
		typeof issue.message === "string" ? /<=\s*(\d+)/.exec(issue.message) : null;
	return match?.[1] ?? null;
}

/** The "what to send instead" sentence for one issue, if it has one. */
function hintForIssue(issue: SchemaIssue): string | null {
	const field = lastPathKey(issue.path);
	const message = typeof issue.message === "string" ? issue.message : "";
	if (field && message.includes("UUID")) return `${field} ${UUID_HINT_SUFFIX}`;
	if (
		field === "limit" &&
		(issue.code === "too_big" || /too big/i.test(message))
	) {
		const maximum = tooBigMaximum(issue);
		if (maximum) return `send limit ≤ ${maximum} and page with offset`;
	}
	return null;
}

function clampDescription(description: string): string {
	if (description.length <= MAX_DESCRIPTION_LENGTH) return description;
	return `${description.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
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
 * field-first, followed by what to send instead where the issue allows it:
 * a short-id hint for UUID fields, the paging hint for `limit` over its
 * maximum, and `received keys`/`expected` for a wrong root shape. Only key
 * names appear, never submitted values, and the whole text is capped at
 * {@link MAX_DESCRIPTION_LENGTH}. Returns null when there is nothing nameable
 * (no issues / empty), so callers fall back to the original error untouched.
 */
export function describeValidationIssues(issues: unknown): string | null {
	if (!Array.isArray(issues) || issues.length === 0) return null;
	const seen = new Set<string>();
	const parts: string[] = [];
	const hints: string[] = [];
	const schemaIssues = issues.filter(isRecord) as SchemaIssue[];
	for (const raw of issues as SchemaIssue[]) {
		const field = formatIssuePath(raw?.path) ?? "(root)";
		const message =
			typeof raw?.message === "string" && raw.message ? raw.message : "invalid";
		const line = `${field}: ${message}`;
		if (seen.has(line)) continue;
		seen.add(line);
		parts.push(line);
		const hint = isRecord(raw) ? hintForIssue(raw) : null;
		if (hint && !hints.includes(hint)) hints.push(hint);
	}
	if (parts.length === 0) return null;
	const rootShape = describeRootShape(schemaIssues);
	if (rootShape) hints.push(rootShape);
	return clampDescription([...parts, ...hints].join("; "));
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
