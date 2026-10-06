/**
 * The MCP Worker's log field vocabulary.
 *
 * Typed rather than `Record<string, unknown>` so `ReservedLogField` makes
 * `token`, `secret`, `prompt`, `headers`, and `body` **unloggable** in a Worker
 * that resolves OAuth tokens, Descope JWTs, and managed MCP credentials. See
 * `packages/worker-kit/README.md`.
 *
 * This is the CONSOLE/Logpush plane. It is not the Analytics Engine plane:
 * business events (tool calls, latency, success rates, audit rows) go through
 * `trackMcpEvent` / `emitMcpAuditEvent` in `src/mcp/utils/analytics.ts`, which
 * is sampled, dashboard-facing, and audit-authoritative. This plane is
 * unsampled diagnostic prose-turned-fields for an engineer chasing one failure.
 *
 * `authType` is imported from the analytics module on purpose: a log line and
 * an analytics row must label the same caller identically.
 */

import {
	createLogger,
	serializeException,
	type SerializedException,
} from "@tedix/worker-kit/logger";
import type { McpEvent } from "./mcp/utils/analytics";

/**
 * Fields an MCP Worker log line may carry, beyond the emitter-owned ones.
 *
 * Keep names stable — each is a column an operator groups by. Prefer adding a
 * name here over interpolating a value into the message string.
 */
export type McpLogFields = {
	/** App UUID, matching `McpEvent.appId`. */
	appId: string;
	/** Human-readable app slug, matching `McpEvent.appSlug`. */
	appSlug: string;
	/** Organization UUID, matching `McpEvent.organizationId`. */
	organizationId: string;
	/** Descope user ID (`sub`), matching `McpEvent.userId`. */
	userId: string;
	/** Tedi ID when the caller resolves to an agent identity. */
	tediId: string;
	/** OAuth client ID or CIMD URL. Never a credential — an identifier. */
	clientId: string;
	/** How the caller authenticated. Same closed union as the analytics plane. */
	authType: NonNullable<McpEvent["authType"]>;
	/** Descope MCP server (inbound app) identifier. */
	mcpServerId: string;
	/** Host only. A URL path can encode tenant identifiers, so it is not logged. */
	serverHost: string;
	/** Hostname of a CIMD client-metadata document being resolved. */
	cimdHost: string;
	/** Tool or prompt identifier. */
	toolName: string;
	/** HTTP status of an outbound or inbound response. */
	status: number;
	/** Response `Content-Type`, for diagnosing a non-JSON upstream. */
	contentType: string;
	/** Wall-clock duration of the operation. */
	durationMs: number;
	/** OAuth scopes required by the operation. Scope names, never a token. */
	requiredScopes: string[];
	/** Value-free browser credential diagnostics; never log the JWT itself. */
	platformAdmin: boolean;
	scopeCount: number;
	hasClientId: boolean;
	hasAuthorizedParty: boolean;
	isTedi: boolean;
	/** Per-request correlation ID shared with the analytics and audit planes. */
	traceId: string;
	/** MCP Task identifier and the execution it routes to; never task input. */
	taskId: string;
	executionId: string;
	/** Stable storage and payment identifiers; never token or signed proof bytes. */
	connectionId: string;
	paymentRequirementId: string;
	paymentReceiptId: string;
	paymentEventId: string;
	/** Budget diagnosis uses an internal step name and bounded technical key. */
	step: string;
	budgetMs: number;
	resourceKey: string;
	/**
	 * How the operation ended. A closed union so a dashboard can group on it
	 * without a free-text taxonomy drifting per call site.
	 */
	outcome:
		| "ok"
		| "denied"
		| "blocked"
		| "misconfigured"
		| "unavailable"
		| "invalid";
	/** Why an operation was denied or blocked. Short, stable, non-interpolated. */
	reason: string;
};

/**
 * Creates a module-scoped logger restricted to the MCP Worker's vocabulary.
 *
 * `component` is a stable dot-separated identity (`mcp.auth.cimd`), fixed at
 * module scope — never interpolated per request.
 */
export function createMcpLogger(component: string) {
	return createLogger<McpLogFields>({ component });
}

/**
 * Tool and task errors may echo arguments or results in their message/stack.
 * Keep the bounded exception type/cause topology while omitting those values.
 */
type ContentFreeException = {
	name: string;
	message: string;
	cause?: ContentFreeException;
	errors?: ContentFreeException[];
};

const SAFE_EXCEPTION_TYPES = new Set([
	"Error",
	"AggregateError",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"DOMException",
	"NullThrown",
	"FunctionThrown",
	"ObjectThrown",
	"CircularCause",
	"TruncatedCause",
	"UninspectableThrown",
]);

export function contentFreeMcpException(error: unknown): ContentFreeException {
	const redact = (exception: SerializedException): ContentFreeException => ({
		name: SAFE_EXCEPTION_TYPES.has(exception.type)
			? exception.type
			: "UnknownThrown",
		message: "Content omitted",
		...(exception.cause && { cause: redact(exception.cause) }),
		...(exception.errors && {
			errors: exception.errors.map(redact),
		}),
	});
	return redact(serializeException(error));
}
