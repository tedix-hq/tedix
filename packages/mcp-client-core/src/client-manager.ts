import {
	type AuthProvider,
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	Client,
	type ClientCapabilities,
	PROTOCOL_VERSION_META_KEY,
	ProtocolError,
	ProtocolErrorCode,
	type PriorDiscovery,
	SdkError,
	SdkErrorCode,
	SdkHttpError,
	StreamableHTTPClientTransport,
	TRACEPARENT_META_KEY,
	TRACESTATE_META_KEY,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import {
	buildMcpParamHeaders,
	collectMcpHeaderBindings,
} from "@tedix/mcp-shared/mcp-param-headers";
import {
	MCP_METHOD_HEADER,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_TASKS_EXTENSION,
	mcpRequestTargetName,
} from "@tedix/mcp-shared/protocol";
import { pollMcpTask } from "@tedix/mcp-shared/task-polling";
import { extractMcpTaskId, type McpTaskState } from "@tedix/mcp-shared/tasks";
import { collectBoundedMcpList } from "@tedix/mcp-shared/bounded-list";
import {
	GetSkillResultSchema,
	ListSkillsResultSchema,
	MCP_SKILLS_EXTENSION,
} from "@tedix/mcp-shared/skills";
import { guardedFetch } from "@tedix/ssrf-guard";
import {
	outboundTraceMeta,
	type TraceContext,
} from "@tedix/mcp-shared/trace-context";
import { parse as parseYaml } from "yaml";
import type {
	McpConnection,
	McpGuidanceInfo,
	McpGuidanceMetadata,
	McpIconInfo,
	McpPromptInfo,
	McpResourceInfo,
	McpResourceTemplateInfo,
	McpServerConfig,
	McpToolAnnotations,
	McpToolInfo,
} from "./types";
import { createAgentElicitationResolver } from "./elicitation-resolver";
import { isRecord } from "@tedix/api-contract/utils/is-record";

/**
 * MCP 2026-07-28 modern protocol revision. When an upstream server advertises
 * it via `server/discover`, the stateless client path declares it and emits the
 * request-bound headers (`Mcp-Method`/`Mcp-Name`) + `_meta` the modern transport
 * enforces. Negotiated per server URL; legacy/external servers stay on the
 * untyped path (the binding headers are harmless extras they ignore).
 */
/** beta.5 requires clientCapabilities; Tedix also sends optional clientInfo. */
const MODERN_CLIENT_INFO = { name: "tedi-mcp-client", version: "2.3.0" };
/** This client drives the Tasks extension round-trip, so it declares it. */
const MODERN_CLIENT_CAPABILITIES: ClientCapabilities = {
	extensions: { [MCP_TASKS_EXTENSION]: {} },
};
/**
 * Per-request capability declaration for the stateless path. The Tasks
 * extension is always declared (this path polls `tasks/get` and runs the sync
 * MRTR retry loop); form-mode elicitation is declared only when the connection
 * actually carries an `onTaskInputRequired` resolver to answer it. A conformant
 * server MUST NOT offer input a caller did not declare, so omitting elicitation
 * here used to silently fail-close the whole agent-to-agent elicitation
 * feature — while declaring it without a resolver would invite requests the
 * client cannot fulfil. Sampling/roots stay undeclared (deprecated, SEP-2577).
 */
function statelessClientCapabilities(
	config: Pick<McpServerConfig, "onTaskInputRequired">,
): ClientCapabilities {
	return config.onTaskInputRequired
		? { ...MODERN_CLIENT_CAPABILITIES, elicitation: { form: {} } }
		: MODERN_CLIENT_CAPABILITIES;
}
/**
 * SEP-2640 skills extension key. Its `directoryRead` flag is the only signal
 * that a server implements `resources/directory/read`; a conformant client
 * never calls that method against a server that did not declare it.
 */
const MCP_CLIENT_JSON_SCHEMA_VALIDATOR = new CfWorkerJsonSchemaValidator({
	draft: "2020-12",
});

/**
 * SSRF-guarded fetch for the stateless MCP POST paths. `config.url` is
 * D1/plugin-supplied and these requests carry auth headers, so the guard
 * validates the target and every redirect hop (stripping credentials on
 * cross-origin hops). Managed Tedix gateway hosts ({slug}.mcp.tedix.dev and
 * friends) are legitimate configured targets for this client, so only those
 * exact host shapes bypass the Tedix-internal hostname denylist; a D1/plugin
 * row cannot use this path to reach `api.tedix.dev` or another platform host.
 * Private/loopback/link-local IP literals stay blocked unconditionally. http
 * is allowed only for the local-dev `*.localhost` lane — this package is
 * runtime-neutral and has no environment signal to key on.
 */
const MANAGED_MCP_HOST_RE = /^[^.]+\.(?:mcp|tedi)\.(?:tedix\.dev|tedix\.tech)$/;
const LOCAL_MANAGED_MCP_HOST_RE = /^[^.]+\.(?:mcp|tedi)\.localhost$/;
const SINGLE_LABEL_DEV_MCP_HOST_RE = /^[^.]+\.tedix\.tech$/;
const RESERVED_PLATFORM_HOST_LABELS = new Set([
	"api",
	"app",
	"cms",
	"docs-admin",
	"email",
	"gateway",
	"landing",
	"mcp",
	"os",
	"skill-runtime",
	"studio",
	"tedi",
	"widget",
]);

function isManagedMcpHostname(hostname: string): boolean {
	if (
		MANAGED_MCP_HOST_RE.test(hostname) ||
		LOCAL_MANAGED_MCP_HOST_RE.test(hostname)
	) {
		return true;
	}
	if (!SINGLE_LABEL_DEV_MCP_HOST_RE.test(hostname)) return false;
	return !RESERVED_PLATFORM_HOST_LABELS.has(
		hostname.slice(0, hostname.indexOf(".")),
	);
}

function guardedMcpFetch(url: string, init: RequestInit): Promise<Response> {
	let allowHttp = false;
	let allowInternalHosts = false;
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		allowHttp = LOCAL_MANAGED_MCP_HOST_RE.test(hostname);
		allowInternalHosts = isManagedMcpHostname(hostname);
	} catch {
		/* guardedFetch reports the invalid URL */
	}
	return guardedFetch(url, init, { allowHttp, allowInternalHosts });
}

/**
 * MCP 2026-07-28 `completion/complete` (autocomplete) request/response shapes.
 * `ref/prompt` completes a prompt argument; `ref/resource` completes a
 * resource URI-template variable.
 */
export type McpCompletionRef =
	| {
			type: "ref/prompt";
			name: string;
	  }
	| {
			type: "ref/resource";
			uri: string;
	  };

export interface McpCompletionResult {
	values: string[];
	total?: number;
	hasMore?: boolean;
}

export interface McpManagerOptions {
	/** Request-only hosts discover optional guidance only when explicitly refreshed. */
	deferOptionalDiscovery?: boolean;
	guidanceMaxChars?: number;
	guidanceSummaryMaxChars?: number;
	disabledSkills?: string[];
	traceContext?: () => TraceContext | null | undefined;
	/** Bounded, credential-free visibility into private discovery cache behavior. */
	onDiscoveryCacheEvent?: (event: McpDiscoveryCacheEvent) => void;
	/**
	 * Per-call timeout for the OPTIONAL stateless-snapshot lists
	 * (`resources/list`, `resources/templates/list`, `prompts/list`). The
	 * required `tools/list` is never bounded here — the outer connect timeout
	 * governs it. A slow optional list that crosses this bound degrades to an
	 * empty result (exactly like a rejected list) instead of gating the whole
	 * snapshot behind its latency.
	 *
	 * Why this exists: on an aggregate gateway `resources/list` enumerates skill
	 * resources across every assigned app and can run 8-10 s while `tools/list`
	 * returns in ~1.5 s. `loadStatelessSnapshot` awaits all four via
	 * `Promise.allSettled`, so without this bound the optional lists set the
	 * connect wall clock — pushing a Code-Mode connect past a tight
	 * `connectTimeoutMs` and poisoning the caller's sync-failure backoff even
	 * though the tool surface the turn needs was ready seconds earlier.
	 *
	 * Undefined (default) = unbounded, preserving prior behavior for callers
	 * with a generous connect budget.
	 */
	optionalSnapshotListTimeoutMs?: number;
}

export interface McpDiscoveryCacheEvent {
	outcome: "hit" | "miss";
	endpoint: string;
	modern: boolean;
	ttlMs: number;
	/** Stable SHA-256 of the discovery result, never of request headers. */
	digest?: string;
}

interface ConnectionSnapshot {
	mode: "sdk" | "stateless";
	config: McpServerConfig;
	info: McpConnection;
	tools: McpToolInfo[];
	resources: McpResourceInfo[];
	resourceTemplates: McpResourceTemplateInfo[];
	prompts: McpPromptInfo[];
	guidance: McpGuidanceInfo[];
	/**
	 * Extension capabilities the server declared during negotiation —
	 * `server/discover` for stateless connections, the (legacy) `initialize`
	 * result for SDK connections. Gates extension-scoped methods such as the
	 * skills extension's `resources/directory/read`.
	 */
	extensions: Record<string, Record<string, unknown>>;
}

interface SdkManagedConnection extends ConnectionSnapshot {
	mode: "sdk";
	client: Client;
	transport: StreamableHTTPClientTransport;
	authContextKey: string;
	priorDiscoveryExpiresAt: number;
}

interface StatelessManagedConnection extends ConnectionSnapshot {
	mode: "stateless";
}

type ManagedConnection = SdkManagedConnection | StatelessManagedConnection;

type TaskSubscription = {
	next(timeoutMs: number): Promise<Record<string, unknown> | null>;
	close(): void;
};

interface BoundedPriorDiscovery {
	prior: PriorDiscovery;
	authContextKey: string;
	expiresAt: number;
}

// A legacy verdict can silently mask a server upgrade, so prior discovery is
// deliberately process-local and short-lived even when credentials are stable.
const SDK_PRIOR_DISCOVERY_TTL_MS = 60_000;

interface DiscoveryNegotiation {
	modern: boolean;
	completions: boolean;
	extensions: Record<string, Record<string, unknown>>;
	ttlMs: number;
	digest?: string;
	expiresAt: number;
}

interface StatelessRequestContext {
	headers: Record<string, string>;
	negotiation: DiscoveryNegotiation;
}

const DISCOVERY_NEGOTIATION_TTL_MS = 60_000;
const MAX_DISCOVERY_NEGOTIATION_TTL_MS = 5 * 60_000;
const TRANSIENT_DISCOVERY_NEGOTIATION_TTL_MS = 5_000;

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

async function discoveryDigest(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalJson(value)),
	);
	return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
}

function discoveryEndpoint(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return "invalid-mcp-endpoint";
	}
}

function priorDiscoveryFromConnection(
	connection: ManagedConnection,
	now = Date.now(),
): BoundedPriorDiscovery | undefined {
	if (connection.mode !== "sdk" || now >= connection.priorDiscoveryExpiresAt) {
		return undefined;
	}
	const discover = connection.client.getDiscoverResult();
	if (!discover) return undefined;
	return {
		prior: { kind: "modern", discover },
		authContextKey: connection.authContextKey,
		expiresAt: connection.priorDiscoveryExpiresAt,
	};
}

async function requestHeadersIdentity(
	headers: Record<string, string>,
): Promise<string> {
	const canonical = Object.entries(headers)
		.map(([name, value]) => [name.toLowerCase(), value] as const)
		.sort(([left], [right]) => left.localeCompare(right));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(canonical)),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

class McpJsonRpcError extends Error {
	readonly code: number;
	readonly data?: unknown;
	readonly status: number;

	constructor(
		method: string,
		status: number,
		error: { code: number; message?: string; data?: unknown },
	) {
		super(
			`MCP ${method} error (${error.code}): ${error.message ?? "Unknown JSON-RPC error"}`,
		);
		this.name = "McpJsonRpcError";
		this.code = error.code;
		this.data = error.data;
		this.status = status;
	}
}

function isHeaderMismatchError(error: unknown): boolean {
	return error instanceof McpJsonRpcError && error.code === -32020;
}

type McpListKey =
	| "tools"
	| "resources"
	| "resourceTemplates"
	| "prompts"
	| "skills";

type McpListSnapshots = Pick<
	ConnectionSnapshot,
	"tools" | "resources" | "resourceTemplates" | "prompts" | "extensions"
> & {
	capabilities: NonNullable<McpConnection["capabilities"]>;
};

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function normalizeStringArray(value: unknown): string[] | undefined {
	const values = Array.isArray(value) ? value : [value];
	const items = values
		.flatMap((item) => {
			if (typeof item === "string" && item.includes(",")) {
				return item.split(",").map((part) => part.trim());
			}
			return [item];
		})
		.map((item) => normalizeFrontmatterScalar(item))
		.filter((item): item is string => Boolean(item));
	return items.length > 0 ? items : undefined;
}

function normalizeFrontmatterScalar(value: unknown): string | undefined {
	if (typeof value === "string") {
		return (
			value
				.trim()
				.replace(/^['"]|['"]$/g, "")
				.trim() || undefined
		);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function parseGuidanceFrontmatter(
	text: string,
): McpGuidanceMetadata | undefined {
	const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
	if (!match) return undefined;

	let frontmatter: unknown;
	try {
		frontmatter = parseYaml(match[1] ?? "");
	} catch {
		return undefined;
	}
	if (
		!frontmatter ||
		typeof frontmatter !== "object" ||
		Array.isArray(frontmatter)
	) {
		return undefined;
	}

	const record = frontmatter as Record<string, unknown>;
	const metadata: McpGuidanceMetadata = {};

	const title = normalizeFrontmatterScalar(record.title);
	if (title) metadata.title = title;
	const summary = normalizeFrontmatterScalar(record.summary);
	if (summary) metadata.summary = summary;
	const description = normalizeFrontmatterScalar(record.description);
	if (description) metadata.description = description;
	const version = normalizeFrontmatterScalar(record.version);
	if (version) metadata.version = version;
	const provenance = normalizeFrontmatterScalar(record.provenance);
	if (provenance) metadata.provenance = provenance;
	const source = normalizeFrontmatterScalar(record.source);
	if (source) metadata.source = source;
	const tags = normalizeStringArray(record.tags);
	if (tags) metadata.tags = tags;
	const dependencies = normalizeStringArray(record.dependencies);
	if (dependencies) metadata.dependencies = dependencies;

	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Resolve annotations for a resource from the spec-aligned shape: top-level
 * `annotations` (audience/priority/lastModified) plus Tedix custom fields on
 * `_meta` under the `io.tedix/` prefix (per SEP-2640 §_meta key-name format).
 */
function resolveResourceAnnotations(
	resource: McpResourceInfo,
): Record<string, unknown> | undefined {
	const top = resource.annotations;
	const meta = resource._meta;
	const out: Record<string, unknown> = {};
	if (meta) {
		const TEDIX_KEYS = [
			"toolIds",
			"tags",
			"version",
			"provenance",
			"successCount",
			"size",
			"skillId",
		] as const;
		for (const key of TEDIX_KEYS) {
			const value = meta[`io.tedix/${key}`];
			if (value !== undefined) out[key] = value;
		}
	}
	if (top) Object.assign(out, top);
	return Object.keys(out).length > 0 ? out : undefined;
}

function classifyGuidanceResource(
	resource: McpResourceInfo,
): McpGuidanceInfo["kind"] | null {
	const uri = resource.uri;

	// WG convention: skill://{path}/SKILL.md resources are skills.
	// SEP-2640 archives are also skills and are extracted on read.
	// Indexes (index.json) and supporting files are NOT guidance.
	if (uri.startsWith("skill://")) {
		if (uri.endsWith("/SKILL.md")) return "skill";
		if (uri.endsWith(".tar.gz") && !uri.endsWith("/archive.tar.gz"))
			return "skill";
		return null;
	}

	// ext-skills convention: annotations with toolIds indicate a skill resource
	const ann = resolveResourceAnnotations(resource);
	if (ann?.toolIds && Array.isArray(ann.toolIds)) {
		return "skill";
	}

	// Non-skill:// heuristic patterns for guides/policies from other servers
	const haystack =
		`${uri} ${resource.name ?? ""} ${resource.description ?? ""}`.toLowerCase();
	if (
		haystack.includes("/skills/") ||
		haystack.includes("skill.md") ||
		haystack.includes(".skill")
	) {
		return "skill";
	}
	if (haystack.includes("policy") || haystack.includes("runbook-policy"))
		return "policy";
	if (
		haystack.includes("guide") ||
		haystack.includes("instruction") ||
		haystack.includes("workflow") ||
		haystack.includes("playbook")
	) {
		return "guide";
	}
	return null;
}

function extractTextFromResourceResult(result: unknown): string {
	const payload = result as {
		contents?: Array<{
			text?: string;
			blob?: string;
			mimeType?: string;
			uri?: string;
		}>;
	};
	return (payload.contents ?? [])
		.filter((item) => typeof item.text === "string")
		.map((item) => item.text!.trim())
		.filter(Boolean)
		.join("\n\n");
}

function buildGuidanceSummary(
	text: string,
	description: string | undefined,
	metadata: McpGuidanceMetadata | undefined,
	maxChars: number,
): string {
	const fallback = normalizeWhitespace(
		metadata?.description ?? description ?? "",
	);
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const heading = lines
		.find((line) => line.startsWith("#"))
		?.replace(/^#+\s*/, "")
		.trim();
	const paragraph = lines.find(
		(line) =>
			!line.startsWith("#") &&
			!line.startsWith("```") &&
			!line.startsWith("---"),
	);
	const summarySeed =
		metadata?.summary ?? heading ?? paragraph ?? metadata?.title ?? fallback;
	const summary = normalizeWhitespace(summarySeed || text);
	return truncate(summary, maxChars);
}

function scoreGuidanceResource(
	resource: McpResourceInfo,
	kind: McpGuidanceInfo["kind"],
): number {
	// WG convention: use annotations.priority (0.0–1.0) as primary signal.
	// Falls back to heuristic scoring when priority is absent.
	const ann = resolveResourceAnnotations(resource);
	const priority = typeof ann?.priority === "number" ? ann.priority : 0.5;

	// Priority is the dominant factor (0–1000 range)
	let score = priority * 1000;

	// Kind tiebreaker
	score += kind === "skill" ? 30 : kind === "guide" ? 20 : 10;

	// Structural signals as minor tiebreakers
	if (resource.uri.startsWith("skill://")) score += 5;
	if ((resource.mimeType ?? "").includes("markdown")) score += 2;
	if (ann) {
		if (Array.isArray(ann.toolIds) && ann.toolIds.length > 0) score += 3;
		if (ann.provenance != null) score += 1;
	}
	return score;
}

function guidanceNameFromUri(uri: string): string {
	const withoutSkillFile = uri.replace(/\/SKILL\.md$/, "");
	const parts = withoutSkillFile.split("/").filter(Boolean);
	return parts.at(-1) ?? uri;
}

function guidanceMetadataFromResource(
	resource: McpResourceInfo,
): McpGuidanceMetadata | undefined {
	const ann = resolveResourceAnnotations(resource);
	const metadata: McpGuidanceMetadata = {};
	if (resource.name) metadata.title = resource.name;
	if (resource.description) metadata.description = resource.description;
	if (ann) {
		if (typeof ann.version === "string" && ann.version)
			metadata.version = ann.version;
		if (Array.isArray(ann.tags) && ann.tags.length > 0)
			metadata.tags = ann.tags.map(String);
		if (Array.isArray(ann.audience) && ann.audience.length > 0)
			metadata.audience = ann.audience.map(String);
		const provUrl = (ann.provenance as Record<string, unknown> | undefined)
			?.serverUrl;
		if (typeof provUrl === "string" && provUrl) metadata.provenance = provUrl;
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Normalize a declared `capabilities.extensions` map (from `server/discover`
 * or a legacy `initialize` result) to plain per-extension records.
 */
function normalizeDeclaredExtensions(
	value: unknown,
): Record<string, Record<string, unknown>> {
	if (!isRecord(value)) return {};
	const extensions: Record<string, Record<string, unknown>> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isRecord(entry)) extensions[key] = entry;
	}
	return extensions;
}

function connectionSupportsDirectoryRead(conn: ConnectionSnapshot): boolean {
	return Boolean(conn.extensions[MCP_SKILLS_EXTENSION]?.directoryRead);
}

function connectionSupportsSkills(conn: ConnectionSnapshot): boolean {
	return Object.hasOwn(conn.extensions, MCP_SKILLS_EXTENSION);
}

function createMcpClient(
	capabilities: ClientCapabilities = {},
	onListChanged?: () => void,
): Client {
	return new Client(MODERN_CLIENT_INFO, {
		capabilities,
		jsonSchemaValidator: MCP_CLIENT_JSON_SCHEMA_VALIDATOR,
		...(onListChanged
			? {
					// SDK v2 maps these handlers to unsolicited legacy notifications or
					// auto-opens one 2026 subscriptions/listen stream as appropriate.
					listChanged: {
						tools: { onChanged: () => onListChanged() },
						resources: { onChanged: () => onListChanged() },
						prompts: { onChanged: () => onListChanged() },
					},
				}
			: {}),
		// Current-only: pin the finalized revision so the SDK never probes and
		// falls back to an initialize/session handshake.
		versionNegotiation: { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } },
	});
}

function mapMcpIcons(value: unknown): McpIconInfo[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const icons: McpIconInfo[] = value.filter(isRecord).map((icon) => {
		const mapped: McpIconInfo = { src: String(icon.src ?? "") };
		if (typeof icon.mimeType === "string") mapped.mimeType = icon.mimeType;
		if (Array.isArray(icon.sizes)) mapped.sizes = icon.sizes.map(String);
		else if (typeof icon.sizes === "string") mapped.sizes = [icon.sizes];
		if (icon.theme === "light" || icon.theme === "dark") {
			mapped.theme = icon.theme;
		}
		return mapped;
	});
	const valid = icons.filter((icon) => icon.src);
	return valid.length > 0 ? valid : undefined;
}

export function isAuthRecoveryError(error: unknown): boolean {
	// beta.3 brands SDK errors across bundled copies. Prefer their structured
	// signals, while retaining the message fallback for third-party servers.
	if (UnauthorizedError.isInstance(error)) return true;
	if (SdkHttpError.isInstance(error)) {
		return error.status === 401;
	}
	if (SdkError.isInstance(error)) {
		return error.code === SdkErrorCode.ClientHttpAuthentication;
	}
	const message = error instanceof Error ? error.message : String(error ?? "");
	const normalized = message.toLowerCase();
	const hasTokenSignal =
		normalized.includes("token") && normalized.includes("expired");
	return (
		hasTokenSignal ||
		normalized.includes("tenant_mismatch") ||
		normalized.includes("jwt has no tenant context") ||
		normalized.includes("different tenant") ||
		normalized.includes("insufficient scope") ||
		normalized.includes("missing scopes") ||
		(normalized.includes("required scopes") &&
			normalized.includes("missing")) ||
		normalized.includes("invalid token") ||
		normalized.includes("unauthorized") ||
		normalized.includes("unauthenticated") ||
		normalized.includes("authentication") ||
		normalized.includes("auth failed") ||
		normalized.includes(" 401") ||
		normalized.includes("status 401") ||
		normalized.includes(" 403 token") ||
		normalized.includes(" 403 auth")
	);
}

function isTransportRecoveryError(error: unknown): boolean {
	if (SdkHttpError.isInstance(error)) {
		return error.status === 502 || error.status === 503 || error.status === 504;
	}
	if (SdkError.isInstance(error)) {
		return (
			error.code === SdkErrorCode.NotConnected ||
			error.code === SdkErrorCode.ConnectionClosed ||
			error.code === SdkErrorCode.SendFailed ||
			error.code === SdkErrorCode.RequestTimeout ||
			error.code === SdkErrorCode.EraNegotiationFailed
		);
	}
	const message = error instanceof Error ? error.message : String(error ?? "");
	const normalized = message.toLowerCase();
	return (
		normalized.includes("transport") ||
		normalized.includes("session") ||
		normalized.includes("connection") ||
		normalized.includes("network") ||
		normalized.includes("fetch failed") ||
		normalized.includes("socket") ||
		normalized.includes("terminated") ||
		normalized.includes("closed") ||
		normalized.includes("timeout") ||
		normalized.includes("timed out") ||
		normalized.includes("econnreset") ||
		normalized.includes("econnrefused") ||
		normalized.includes("etimedout") ||
		normalized.includes("ehostunreach") ||
		normalized.includes("enotfound") ||
		normalized.includes("epipe") ||
		normalized.includes(" 502") ||
		normalized.includes("status 502") ||
		normalized.includes(" 503") ||
		normalized.includes("status 503") ||
		normalized.includes(" 504") ||
		normalized.includes("status 504")
	);
}

function collectResultText(
	value: unknown,
	depth = 0,
	seen = new Set<unknown>(),
): string[] {
	if (depth > 6) return [];
	if (typeof value === "string") return [value];
	if (!value || typeof value !== "object") return [];
	if (seen.has(value)) return [];
	seen.add(value);

	if (Array.isArray(value)) {
		return value.flatMap((item) => collectResultText(item, depth + 1, seen));
	}

	const record = value as Record<string, unknown>;
	const directText =
		typeof record.text === "string"
			? [record.text]
			: typeof record.error === "string"
				? [record.error]
				: [];
	return directText.concat(
		Object.values(record).flatMap((item) =>
			collectResultText(item, depth + 1, seen),
		),
	);
}

function authRecoveryMessageFromResult(result: unknown): string | null {
	for (const text of collectResultText(result)) {
		const normalized = text.toLowerCase();
		if (
			normalized.includes("insufficient scope") ||
			normalized.includes("missing scopes") ||
			(normalized.includes("required scopes") && normalized.includes("missing"))
		) {
			return text;
		}
	}
	return null;
}

export class McpClientManager {
	private connections = new Map<string, ManagedConnection>();
	private reconnectInFlight = new Map<string, Promise<ManagedConnection>>();
	private readonly maxConnections: number;
	private readonly guidanceMaxChars: number;
	private readonly guidanceSummaryMaxChars: number;
	private readonly disabledSkills: Set<string>;
	private readonly traceContext?: () => TraceContext | null | undefined;
	private readonly onDiscoveryCacheEvent?: (
		event: McpDiscoveryCacheEvent,
	) => void;
	private readonly optionalSnapshotListTimeoutMs?: number;
	private readonly deferOptionalDiscovery: boolean;
	/** URL + resolved header identity → one bounded discovery verdict. */
	private readonly discoveryNegotiations = new Map<
		string,
		DiscoveryNegotiation
	>();
	private readonly discoveryNegotiationInFlight = new Map<
		string,
		Promise<DiscoveryNegotiation>
	>();

	constructor(maxConnections = 50, options: McpManagerOptions = {}) {
		this.maxConnections = maxConnections;
		this.deferOptionalDiscovery = options.deferOptionalDiscovery ?? false;
		this.guidanceMaxChars = options.guidanceMaxChars ?? 4000;
		this.guidanceSummaryMaxChars = options.guidanceSummaryMaxChars ?? 220;
		this.disabledSkills = new Set(options.disabledSkills ?? []);
		this.traceContext = options.traceContext;
		this.onDiscoveryCacheEvent = options.onDiscoveryCacheEvent;
		this.optionalSnapshotListTimeoutMs = options.optionalSnapshotListTimeoutMs;
	}

	private emitDiscoveryCacheEvent(
		config: McpServerConfig,
		outcome: McpDiscoveryCacheEvent["outcome"],
		negotiation: DiscoveryNegotiation,
	): void {
		try {
			this.onDiscoveryCacheEvent?.({
				outcome,
				endpoint: discoveryEndpoint(config.url),
				modern: negotiation.modern,
				ttlMs: negotiation.ttlMs,
				...(negotiation.digest ? { digest: negotiation.digest } : {}),
			});
		} catch {
			// Observability must never break protocol negotiation.
		}
	}

	private async resolveRequestHeaders(
		config: McpServerConfig,
	): Promise<Record<string, string>> {
		const headers = {
			"Accept-Encoding": "identity",
			...config.headers,
		};
		if (config.headerFactory) {
			Object.assign(headers, await config.headerFactory());
		}
		return headers;
	}

	private extractBearerToken(
		headers: Record<string, string>,
	): string | undefined {
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() !== "authorization") continue;
			const match = value.match(/^Bearer\s+(.+)$/i);
			return match?.[1]?.trim();
		}
		return undefined;
	}

	private withoutAuthorizationHeader(
		headers: Record<string, string>,
	): Record<string, string> {
		return Object.fromEntries(
			Object.entries(headers).filter(
				([key]) => key.toLowerCase() !== "authorization",
			),
		);
	}

	private createSdkAuthProvider(
		config: McpServerConfig,
		initialToken: string,
	): AuthProvider {
		let firstToken: string | undefined = initialToken;
		return {
			token: async () => {
				if (firstToken !== undefined) {
					const token = firstToken;
					firstToken = undefined;
					return token;
				}
				const headers = await this.resolveRequestHeaders(config);
				return this.extractBearerToken(headers);
			},
			onUnauthorized: async () => {
				config.onCredentialInvalidate?.(config.url);
			},
		};
	}

	private async createSdkTransport(config: McpServerConfig): Promise<{
		transport: StreamableHTTPClientTransport;
		authContextKey: string;
	}> {
		const headers = await this.resolveRequestHeaders(config);
		const bearerToken = this.extractBearerToken(headers);
		const hasBearerToken = Boolean(bearerToken);
		const staticHeaders = hasBearerToken
			? this.withoutAuthorizationHeader(headers)
			: headers;
		const transport = new StreamableHTTPClientTransport(new URL(config.url), {
			...(hasBearerToken
				? {
						authProvider: this.createSdkAuthProvider(
							config,
							bearerToken as string,
						),
					}
				: {}),
			requestInit: { headers: staticHeaders },
			fetch: (url, init) => {
				const headers = new Headers(init?.headers);
				for (const [key, value] of Object.entries(
					this.outboundTraceContext().headers,
				))
					headers.set(key, value);
				return guardedMcpFetch(String(url), { ...init, headers });
			},
			onInsufficientScope: "throw",
		});
		return {
			transport,
			authContextKey: await requestHeadersIdentity(headers),
		};
	}

	private outboundTraceContext(): {
		headers: Record<string, string>;
		meta: Record<string, unknown>;
	} {
		const context = this.traceContext?.();
		const extraMeta =
			context?.metadata && typeof context.metadata === "object"
				? context.metadata
				: {};
		const traceId =
			typeof context?.traceId === "string" ? context.traceId.trim() : "";
		if (!traceId) return { headers: {}, meta: { ...extraMeta } };
		const meta = outboundTraceMeta(traceId, context?.tracestate ?? undefined);
		const headers: Record<string, string> = {
			"X-Trace-Id": traceId,
			"X-Tedix-Trace-Id": traceId,
		};
		if (meta[TRACEPARENT_META_KEY]) {
			headers.traceparent = meta[TRACEPARENT_META_KEY];
		}
		if (meta[TRACESTATE_META_KEY]) {
			headers.tracestate = meta[TRACESTATE_META_KEY];
		}
		return { headers, meta: { ...extraMeta, ...meta } };
	}

	/**
	 * Detect whether this URL + resolved credential/header identity advertises
	 * the 2026-07-28 revision. The verdict and its extension metadata share one
	 * bounded cache entry. Transient failures get only a short negative TTL.
	 */
	private async negotiateModernProtocol(
		config: McpServerConfig,
		headers: Record<string, string>,
	): Promise<DiscoveryNegotiation> {
		const identity = await requestHeadersIdentity(headers);
		const cacheKey = `${config.url}\n${identity}`;
		const now = Date.now();
		const cached = this.discoveryNegotiations.get(cacheKey);
		if (cached && now < cached.expiresAt) {
			this.emitDiscoveryCacheEvent(config, "hit", cached);
			return cached;
		}
		if (cached) this.discoveryNegotiations.delete(cacheKey);

		const inFlight = this.discoveryNegotiationInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const probe = (async (): Promise<DiscoveryNegotiation> => {
			let modern = false;
			let completions = false;
			let extensions: Record<string, Record<string, unknown>> = {};
			let ttl = TRANSIENT_DISCOVERY_NEGOTIATION_TTL_MS;
			let digest: string | undefined;
			try {
				const res = await guardedMcpFetch(config.url, {
					method: "POST",
					headers: {
						...headers,
						"Accept-Encoding": "identity",
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_PROTOCOL_VERSION,
						[MCP_METHOD_HEADER]: "server/discover",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: crypto.randomUUID(),
						method: "server/discover",
						params: {
							_meta: {
								[PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
								[CLIENT_INFO_META_KEY]: MODERN_CLIENT_INFO,
								[CLIENT_CAPABILITIES_META_KEY]:
									statelessClientCapabilities(config),
							},
						},
					}),
				});
				if (res.ok) {
					ttl = DISCOVERY_NEGOTIATION_TTL_MS;
					const payload = this.parseMcpResponsePayload(
						await res.text(),
						"server/discover",
					);
					const result = payload.result as
						| {
								supportedVersions?: unknown;
								capabilities?: unknown;
								ttlMs?: unknown;
								cacheScope?: unknown;
						  }
						| undefined;
					if (result) digest = await discoveryDigest(result);
					if (
						result?.cacheScope === "private" &&
						typeof result.ttlMs === "number" &&
						Number.isInteger(result.ttlMs) &&
						result.ttlMs >= 0
					) {
						ttl = Math.min(result.ttlMs, MAX_DISCOVERY_NEGOTIATION_TTL_MS);
					}
					const versions = result?.supportedVersions;
					modern =
						Array.isArray(versions) &&
						versions.includes(MCP_MODERN_PROTOCOL_VERSION);
					const capabilities = isRecord(result?.capabilities)
						? result.capabilities
						: undefined;
					completions = Boolean(capabilities?.completions);
					extensions = normalizeDeclaredExtensions(capabilities?.extensions);
				} else if (
					res.status !== 408 &&
					res.status !== 425 &&
					res.status !== 429 &&
					res.status < 500
				) {
					// A stable unsupported/auth response is a bounded legacy verdict.
					ttl = DISCOVERY_NEGOTIATION_TTL_MS;
				}
			} catch (error) {
				// Never collapse SSRF/URL containment into a protocol-version error.
				if (
					error instanceof Error &&
					/(Blocked host|Invalid URL|Private|loopback|link-local)/i.test(
						error.message,
					)
				) {
					throw error;
				}
				// Transient discovery failures are cached only briefly.
			}
			const verdict = {
				modern,
				completions,
				extensions,
				ttlMs: ttl,
				...(digest ? { digest } : {}),
				expiresAt: Date.now() + ttl,
			};
			this.discoveryNegotiations.set(cacheKey, verdict);
			this.emitDiscoveryCacheEvent(config, "miss", verdict);
			return verdict;
		})();
		this.discoveryNegotiationInFlight.set(cacheKey, probe);
		try {
			return await probe;
		} finally {
			this.discoveryNegotiationInFlight.delete(cacheKey);
		}
	}

	private async resolveStatelessRequestContext(
		config: McpServerConfig,
	): Promise<StatelessRequestContext> {
		const headers = await this.resolveRequestHeaders(config);
		const negotiation = await this.negotiateModernProtocol(config, headers);
		if (!negotiation.modern) {
			throw new Error(
				`Unsupported MCP server at ${config.url}: server/discover must advertise ${MCP_MODERN_PROTOCOL_VERSION}`,
			);
		}
		return {
			headers,
			negotiation,
		};
	}

	/**
	 * Build the 2026-07-28 request-bound headers + `_meta`. `Mcp-Method` and
	 * `Mcp-Name` are always added (legacy servers ignore unknown headers);
	 * `MCP-Protocol-Version` is only declared when the server negotiated modern,
	 * so a strict modern server enforces the full contract while legacy/external
	 * servers are unaffected.
	 */
	private modernRequestHeaders(
		method: string,
		params: Record<string, unknown> | undefined,
		modern: boolean,
	): Record<string, string> {
		const headers: Record<string, string> = { [MCP_METHOD_HEADER]: method };
		const target = mcpRequestTargetName(method, params);
		if (target) headers[MCP_NAME_HEADER] = target;
		if (modern)
			headers[MCP_PROTOCOL_VERSION_HEADER] = MCP_MODERN_PROTOCOL_VERSION;
		return headers;
	}

	/**
	 * Max synchronous MRTR (`resultType: "input_required"`) round-trips per
	 * `rawMcpPost` call before surfacing the unresolved state to the caller.
	 * Bounds a misbehaving server that keeps re-requesting input.
	 */
	private static readonly MAX_SYNC_INPUT_ROUNDS = 8;

	private async rawMcpPost(
		config: McpServerConfig,
		method: string,
		params?: Record<string, unknown>,
		extraHeaders?: Record<string, string>,
		requestContext?: StatelessRequestContext,
		signal?: AbortSignal,
	): Promise<unknown> {
		signal?.throwIfAborted();
		let result = await this.rawMcpPostOnce(
			config,
			method,
			params,
			extraHeaders,
			requestContext,
			signal,
		);

		// 2026-07-28 synchronous MRTR. A tool/handler may answer a `tools/call`
		// directly (no Tasks round-trip) with `resultType: "input_required"`,
		// carrying `inputRequests` + an opaque `requestState`. When an
		// `onTaskInputRequired` resolver is configured, gather responses and RETRY
		// the original request with `inputResponses` + the echoed `requestState`
		// (a fresh JSON-RPC id is minted per attempt by `rawMcpPostOnce`). This
		// mirrors the async `tasks/update` flow without a task id.
		if (!config.onTaskInputRequired) return result;
		let nextParams = params;
		for (
			let round = 0;
			round < McpClientManager.MAX_SYNC_INPUT_ROUNDS;
			round++
		) {
			if (!isRecord(result) || result.resultType !== "input_required") {
				return result;
			}
			const inputRequests = isRecord(result.inputRequests)
				? result.inputRequests
				: {};
			const responses = await config.onTaskInputRequired({
				taskId: typeof result.taskId === "string" ? result.taskId : "",
				inputRequests,
			});
			if (!responses) return result; // cannot fulfill — surface to caller
			nextParams = {
				...nextParams,
				inputResponses: responses,
				...(result.requestState !== undefined
					? { requestState: result.requestState }
					: {}),
			};
			result = await this.rawMcpPostOnce(
				config,
				method,
				nextParams,
				extraHeaders,
				requestContext,
				signal,
			);
		}
		return result;
	}

	private async rawMcpPostOnce(
		config: McpServerConfig,
		method: string,
		params?: Record<string, unknown>,
		extraHeaders?: Record<string, string>,
		requestContext?: StatelessRequestContext,
		signal?: AbortSignal,
	): Promise<unknown> {
		signal?.throwIfAborted();
		const context =
			requestContext ?? (await this.resolveStatelessRequestContext(config));
		const { headers } = context;
		const modern = context.negotiation.modern;
		const trace = this.outboundTraceContext();
		// Only declare the 2026-07-28 `_meta` contract when the server negotiated
		// modern. Stamping protocolVersion without the matching MCP-Protocol-Version
		// header makes a dual-era server reject the request for header/_meta
		// inconsistency (`-32004`). Legacy requests carry only trace `_meta`.
		const meta: Record<string, unknown> = {
			...(params && typeof params._meta === "object" && params._meta !== null
				? (params._meta as Record<string, unknown>)
				: {}),
			...trace.meta,
			...(modern
				? {
						[PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
						[CLIENT_INFO_META_KEY]: MODERN_CLIENT_INFO,
						[CLIENT_CAPABILITIES_META_KEY]: statelessClientCapabilities(config),
					}
				: {}),
		};
		const outboundParams =
			Object.keys(meta).length > 0 ? { ...params, _meta: meta } : { ...params };
		signal?.throwIfAborted();
		const res = await guardedMcpFetch(config.url, {
			signal,
			method: "POST",
			headers: {
				...headers,
				...trace.headers,
				...this.modernRequestHeaders(method, params, modern),
				...extraHeaders,
				"Accept-Encoding": "identity",
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: crypto.randomUUID(),
				method,
				params: outboundParams,
			}),
		});
		const text = await res.text();
		let payload: { result?: unknown; error?: unknown };
		try {
			payload = this.parseMcpResponsePayload(text, method);
		} catch (error) {
			if (!res.ok) {
				throw new Error(
					`Stateless MCP ${method} failed (${res.status}): ${text.slice(0, 500)}`,
					{ cause: error },
				);
			}
			throw error;
		}
		if (isRecord(payload.error) && typeof payload.error.code === "number") {
			throw new McpJsonRpcError(method, res.status, {
				code: payload.error.code,
				message:
					typeof payload.error.message === "string"
						? payload.error.message
						: undefined,
				data: payload.error.data,
			});
		}
		if (payload.error) {
			throw new Error(`MCP ${method} error: ${JSON.stringify(payload.error)}`);
		}
		if (!res.ok) {
			throw new Error(
				`Stateless MCP ${method} failed (${res.status}): ${text.slice(0, 500)}`,
			);
		}
		return payload.result;
	}

	private parseMcpResponsePayload(
		text: string,
		method: string,
	): { result?: unknown; error?: unknown } {
		const trimmed = text.trim();
		if (!trimmed) {
			throw new Error(`MCP ${method} returned an empty response`);
		}
		if (trimmed.startsWith("{")) {
			return JSON.parse(trimmed) as { result?: unknown; error?: unknown };
		}

		for (const event of trimmed.split(/\r?\n\r?\n/).reverse()) {
			const data = event
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n")
				.trim();
			if (!data || data === "[DONE]") continue;
			if (data.startsWith("{")) {
				return JSON.parse(data) as { result?: unknown; error?: unknown };
			}
		}

		throw new Error(
			`MCP ${method} returned unsupported response content: ${trimmed.slice(0, 120)}`,
		);
	}

	private async rawMcpListAll(
		config: McpServerConfig,
		method: string,
		key: McpListKey,
		requestContext?: StatelessRequestContext,
	): Promise<Record<string, unknown[]>> {
		// The upstream is untrusted: a constant or endless nextCursor must not spin
		// the runtime, so the walk is bounded (pages, items, bytes, repeat cursor).
		const { items, truncated } = await collectBoundedMcpList<unknown>(
			async (cursor) => {
				const result = (await this.rawMcpPost(
					config,
					method,
					cursor === undefined ? undefined : { cursor },
					undefined,
					requestContext,
				)) as Record<string, unknown>;
				const pageItems = result[key];
				if (!Array.isArray(pageItems)) {
					throw new Error(`MCP ${method} result is missing ${key}`);
				}
				return { items: pageItems, nextCursor: result.nextCursor };
			},
		);
		if (truncated) {
			console.warn(
				`[mcp-list] ${method} truncated at ${items.length} ${key} (page, item, byte, or repeated-cursor bound)`,
			);
		}
		return { [key]: items };
	}

	private async loadStatelessSnapshot(
		serverId: string,
		config: McpServerConfig,
	): Promise<McpListSnapshots> {
		// Per-leg latency probe (non-behavioral): attribute the cold connect wall
		// clock across request-context setup (server/discover + credential header
		// resolve) and each of the four lists, so the timeout-vs-value decision is
		// made on measurement. Each list logs its REAL latency even when the
		// optional cap below rejects the race early. Pairs with tedi-runtime's
		// `[mcp-cred-timing]`.
		const ctx0 = performance.now();
		const requestContext = await this.resolveStatelessRequestContext(config);
		console.log(
			`[mcp-list-timing] ${serverId} request-context ms=${Math.round(performance.now() - ctx0)}`,
		);
		const timedRaw = (
			method: string,
			key: McpListKey,
		): Promise<Record<string, unknown[]>> => {
			const t = performance.now();
			return this.rawMcpListAll(config, method, key, requestContext).then(
				(result) => {
					console.log(
						`[mcp-list-timing] ${serverId} ${method} ms=${Math.round(performance.now() - t)} ok=true`,
					);
					return result;
				},
				(error: unknown) => {
					console.log(
						`[mcp-list-timing] ${serverId} ${method} ms=${Math.round(performance.now() - t)} ok=false`,
					);
					throw error;
				},
			);
		};
		// `tools/list` is required and governed by the outer connect timeout. The
		// other three lists are optional (they degrade to `[]` below), so a slow
		// one must not gate the snapshot behind its latency — bound each to
		// `optionalSnapshotListTimeoutMs` when configured so it rejects (→ `[]`)
		// instead of holding the whole `Promise.allSettled` open. See the option's
		// doc for the aggregate-gateway `resources/list` case this guards.
		const optionalList = (
			method: string,
			key: McpListKey,
		): Promise<Record<string, unknown[]>> => {
			const list = timedRaw(method, key);
			const bound = this.optionalSnapshotListTimeoutMs;
			if (bound === undefined || bound <= 0) return list;
			return Promise.race([
				list,
				new Promise<never>((_, reject) => {
					const timer = setTimeout(
						() =>
							reject(
								new Error(
									`MCP ${method} timed out after ${bound}ms (optional snapshot list)`,
								),
							),
						bound,
					);
					// Never let the losing timer keep the promise (or a worker) alive.
					list.finally(() => clearTimeout(timer)).catch(() => {});
				}),
			]);
		};
		const [toolsResult, resourcesResult, templatesResult, promptsResult] =
			await Promise.allSettled([
				timedRaw("tools/list", "tools"),
				optionalList("resources/list", "resources"),
				optionalList("resources/templates/list", "resourceTemplates"),
				optionalList("prompts/list", "prompts"),
			]);

		if (toolsResult.status === "rejected") {
			throw toolsResult.reason;
		}

		return {
			tools: this.mapToolsListResult(serverId, toolsResult.value),
			resources:
				resourcesResult.status === "fulfilled"
					? this.mapResourcesListResult(serverId, resourcesResult.value)
					: [],
			resourceTemplates:
				templatesResult.status === "fulfilled"
					? this.mapResourceTemplatesListResult(serverId, templatesResult.value)
					: [],
			prompts:
				promptsResult.status === "fulfilled"
					? this.mapPromptsListResult(serverId, promptsResult.value)
					: [],
			capabilities: {
				tools: true,
				resources: resourcesResult.status === "fulfilled",
				resourceTemplates: templatesResult.status === "fulfilled",
				prompts: promptsResult.status === "fulfilled",
				completions: requestContext.negotiation.completions,
			},
			extensions: requestContext.negotiation.extensions,
		};
	}

	private mapToolsListResult(serverId: string, result: unknown): McpToolInfo[] {
		const payload = result as { tools?: Array<Record<string, unknown>> };
		return (payload.tools ?? [])
			.filter((tool) => typeof tool.name === "string")
			.flatMap((tool) => {
				const ann = tool.annotations as McpToolAnnotations | undefined;
				const meta = tool._meta as Record<string, unknown> | undefined;
				const hasWidget = Boolean(
					meta?.["openai/outputTemplate"] || meta?.["com.tedix/hasWidget"],
				);
				const widgetDescription = (meta?.["openai/widgetDescription"] ??
					meta?.["com.tedix/widgetDescription"]) as string | undefined;
				const inputSchema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
				const headerBindings = collectMcpHeaderBindings(inputSchema);
				if (!headerBindings.ok) {
					console.warn(
						`[mcp-client-core] skipping tool "${String(tool.name)}" with invalid x-mcp-header annotation: ${headerBindings.reason}`,
					);
					return [];
				}
				return [
					{
						serverId,
						name: tool.name as string,
						title: typeof tool.title === "string" ? tool.title : undefined,
						description:
							typeof tool.description === "string"
								? tool.description
								: undefined,
						inputSchema,
						outputSchema: isRecord(tool.outputSchema)
							? tool.outputSchema
							: undefined,
						icons: mapMcpIcons(tool.icons),
						annotations: ann,
						meta,
						hasWidget,
						widgetDescription,
					},
				];
			});
	}

	private mapResourcesListResult(
		serverId: string,
		result: unknown,
	): McpResourceInfo[] {
		const payload = result as { resources?: Array<Record<string, unknown>> };
		return (payload.resources ?? [])
			.filter((resource) => typeof resource.uri === "string")
			.map((resource) => ({
				serverId,
				uri: resource.uri as string,
				name: typeof resource.name === "string" ? resource.name : undefined,
				description:
					typeof resource.description === "string"
						? resource.description
						: undefined,
				mimeType:
					typeof resource.mimeType === "string" ? resource.mimeType : undefined,
				icons: mapMcpIcons(resource.icons),
				annotations: isRecord(resource.annotations)
					? resource.annotations
					: undefined,
				_meta: isRecord(resource._meta) ? resource._meta : undefined,
			}));
	}

	private mapResourceTemplatesListResult(
		serverId: string,
		result: unknown,
	): McpResourceTemplateInfo[] {
		const payload = result as {
			resourceTemplates?: Array<Record<string, unknown>>;
		};
		return (payload.resourceTemplates ?? [])
			.filter((template) => typeof template.uriTemplate === "string")
			.map((template) => ({
				serverId,
				uriTemplate: template.uriTemplate as string,
				name: typeof template.name === "string" ? template.name : undefined,
				title: typeof template.title === "string" ? template.title : undefined,
				description:
					typeof template.description === "string"
						? template.description
						: undefined,
				mimeType:
					typeof template.mimeType === "string" ? template.mimeType : undefined,
				icons: mapMcpIcons(template.icons),
				annotations: isRecord(template.annotations)
					? template.annotations
					: undefined,
				_meta: isRecord(template._meta) ? template._meta : undefined,
			}));
	}

	private mapPromptsListResult(
		serverId: string,
		result: unknown,
	): McpPromptInfo[] {
		const payload = result as { prompts?: Array<Record<string, unknown>> };
		return (payload.prompts ?? [])
			.filter((prompt) => typeof prompt.name === "string")
			.map((prompt) => ({
				serverId,
				name: prompt.name as string,
				title: typeof prompt.title === "string" ? prompt.title : undefined,
				description:
					typeof prompt.description === "string"
						? prompt.description
						: undefined,
				icons: mapMcpIcons(prompt.icons),
				_meta: isRecord(prompt._meta) ? prompt._meta : undefined,
				arguments: Array.isArray(prompt.arguments)
					? prompt.arguments
							.filter((arg): arg is Record<string, unknown> => isRecord(arg))
							.map((arg) => ({
								name: String(arg.name ?? ""),
								description:
									typeof arg.description === "string"
										? arg.description
										: undefined,
								required:
									typeof arg.required === "boolean" ? arg.required : undefined,
							}))
							.filter((arg) => arg.name)
					: undefined,
			}));
	}

	private async openConnection(
		serverId: string,
		config: McpServerConfig,
		priorDiscovery?: BoundedPriorDiscovery,
		signal?: AbortSignal,
	): Promise<ManagedConnection> {
		const transportType = "streamable-http";
		const capabilities: Record<string, unknown> = {
			// Tasks extension: SDK-path tool results are still polled to terminal
			// state via resolveTaskResult, so this path drives the same
			// tasks/get|update round-trip as the stateless path and must say so —
			// previously only the raw stateless `_meta` declared it (split-brain).
			extensions: { [MCP_TASKS_EXTENSION]: {} },
		};
		// Declare elicitation support (form mode) so servers can request user input.
		// Sampling (`sampling/createMessage`) is intentionally NOT advertised — it is
		// removed in the finalized MCP revision; tedis use direct model integration.
		capabilities.elicitation = { form: {} };
		const client = createMcpClient(
			capabilities,
			this.deferOptionalDiscovery
				? undefined
				: () => {
						void this.refreshConnection(serverId).catch(() => {
							// Non-fatal: the next manual refresh will reconcile state.
						});
					},
		);

		this.registerElicitationHandler(client);

		const { transport, authContextKey } = await this.createSdkTransport(config);
		const reusablePrior =
			priorDiscovery?.authContextKey === authContextKey
				? priorDiscovery
				: undefined;

		// SDK v2 discovery probing precedes request-signal wiring. Closing its
		// transport aborts the probe through the SDK lifecycle as well.
		const abortConnect = () => void transport.close().catch(() => {});
		signal?.addEventListener("abort", abortConnect, { once: true });
		try {
			signal?.throwIfAborted();
			await client.connect(transport, {
				...(reusablePrior ? { prior: reusablePrior.prior } : {}),
				signal,
			});
			signal?.throwIfAborted();
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		} finally {
			signal?.removeEventListener("abort", abortConnect);
		}
		if (!client.getDiscoverResult()) {
			await client.close().catch(() => {});
			throw new Error(
				`Unsupported MCP server at ${config.url}: server/discover must advertise ${MCP_MODERN_PROTOCOL_VERSION}`,
			);
		}

		const serverVersion = client.getServerVersion();
		const serverCapabilities = client.getServerCapabilities();
		const resourcesCapability = serverCapabilities?.resources;
		const connectionInfo: McpConnection = {
			serverId,
			url: config.url,
			transport: transportType,
			connectedAt: new Date().toISOString(),
			serverName: serverVersion?.name,
			serverVersion: serverVersion?.version,
			capabilities: {
				tools: Boolean(serverCapabilities?.tools),
				resources: Boolean(resourcesCapability),
				resourceTemplates: Boolean(
					resourcesCapability &&
					typeof resourcesCapability === "object" &&
					"templates" in resourcesCapability,
				),
				prompts: Boolean(serverCapabilities?.prompts),
				completions: Boolean(
					(serverCapabilities as { completions?: unknown } | undefined)
						?.completions,
				),
			},
		};

		return {
			mode: "sdk",
			client,
			transport,
			authContextKey,
			priorDiscoveryExpiresAt:
				reusablePrior?.expiresAt ?? Date.now() + SDK_PRIOR_DISCOVERY_TTL_MS,
			config,
			info: connectionInfo,
			tools: [],
			resources: [],
			resourceTemplates: [],
			prompts: [],
			guidance: [],
			extensions: normalizeDeclaredExtensions(serverCapabilities?.extensions),
		};
	}

	async connect(
		serverId: string,
		config: McpServerConfig,
		options?: { signal?: AbortSignal; priorDiscovery?: BoundedPriorDiscovery },
	): Promise<McpConnection> {
		if (this.connections.has(serverId)) {
			await this.disconnect(serverId);
		}
		if (this.connections.size >= this.maxConnections) {
			throw new Error(
				`Maximum connections (${this.maxConnections}) reached. Disconnect a server first.`,
			);
		}

		const connection = await this.openConnection(
			serverId,
			config,
			options?.priorDiscovery,
			options?.signal,
		);
		try {
			if (this.deferOptionalDiscovery && connection.mode === "sdk") {
				const result = await connection.client.listTools(undefined, {
					signal: options?.signal,
				});
				options?.signal?.throwIfAborted();
				connection.tools = this.mapToolsListResult(serverId, result);
				this.connections.set(serverId, connection);
			} else {
				this.connections.set(serverId, connection);
				await this.refreshConnection(serverId, { allowRecovery: false });
			}
			return connection.info;
		} catch (error) {
			if (this.connections.get(serverId) === connection)
				this.connections.delete(serverId);
			await this.closeConnection(connection).catch(() => {});
			throw error;
		}
	}

	async connectStatelessSnapshot(
		serverId: string,
		config: McpServerConfig,
	): Promise<McpConnection> {
		if (this.connections.has(serverId)) {
			await this.disconnect(serverId);
		}
		if (this.connections.size >= this.maxConnections) {
			throw new Error(
				`Maximum connections (${this.maxConnections}) reached. Disconnect a server first.`,
			);
		}

		const snapshot = await this.loadStatelessSnapshot(serverId, config);
		const connectionInfo: McpConnection = {
			serverId,
			url: config.url,
			transport: "streamable-http",
			connectedAt: new Date().toISOString(),
			capabilities: snapshot.capabilities,
		};
		const conn: StatelessManagedConnection = {
			mode: "stateless",
			config,
			info: connectionInfo,
			tools: snapshot.tools,
			resources: snapshot.resources,
			resourceTemplates: snapshot.resourceTemplates,
			prompts: snapshot.prompts,
			guidance: [],
			extensions: snapshot.extensions,
		};
		await this.mergeSkillIndex(conn, serverId, conn.resources);
		conn.guidance = this.buildGuidanceResourceSummaries(conn);
		this.connections.set(serverId, conn);
		return conn.info;
	}

	private async closeConnection(conn: ManagedConnection): Promise<void> {
		if (conn.mode !== "sdk") return;
		const transport = conn.transport as StreamableHTTPClientTransport & {
			terminateSession?: () => Promise<void>;
		};
		await transport.terminateSession?.().catch(() => {});
		await conn.client.close();
	}

	private async refreshStatelessConnection(
		serverId: string,
		conn: StatelessManagedConnection,
	): Promise<McpConnection> {
		const snapshot = await this.loadStatelessSnapshot(serverId, conn.config);
		conn.tools = snapshot.tools;
		conn.resources = snapshot.resources;
		conn.resourceTemplates = snapshot.resourceTemplates;
		conn.prompts = snapshot.prompts;
		conn.info.capabilities = snapshot.capabilities;
		conn.extensions = snapshot.extensions;
		await this.mergeSkillIndex(conn, serverId, conn.resources);
		conn.guidance = this.buildGuidanceResourceSummaries(conn);
		return conn.info;
	}

	async disconnect(serverId: string): Promise<void> {
		const conn = this.connections.get(serverId);
		if (!conn) throw new Error(`Connection "${serverId}" not found.`);
		try {
			await this.closeConnection(conn);
		} catch {
			// Already closed.
		}
		this.connections.delete(serverId);
	}

	async disconnectAll(): Promise<void> {
		await Promise.allSettled(
			[...this.connections.keys()].map((id) => this.disconnect(id)),
		);
	}

	listConnections(): McpConnection[] {
		return [...this.connections.values()].map((connection) => connection.info);
	}

	private async reconnect(
		serverId: string,
		signal?: AbortSignal,
	): Promise<ManagedConnection> {
		const existing = this.reconnectInFlight.get(serverId);
		if (existing) return existing;

		const current = this.connections.get(serverId);
		if (!current) throw new Error(`Connection "${serverId}" not found.`);

		const reconnectPromise = (async () => {
			const config = current.config;
			const priorDiscovery = priorDiscoveryFromConnection(current);
			// Invalidate cached credentials so headerFactory fetches a fresh token
			if (config.onCredentialInvalidate) {
				config.onCredentialInvalidate(config.url);
			}
			try {
				await this.closeConnection(current);
			} catch {
				// Already closed.
			}
			this.connections.delete(serverId);
			if (current.mode === "stateless") {
				await this.connectStatelessSnapshot(serverId, config);
			} else if (this.deferOptionalDiscovery) {
				await this.connect(serverId, config, { signal, priorDiscovery });
			} else {
				const reopened = await this.openConnection(
					serverId,
					config,
					priorDiscovery,
				);
				this.connections.set(serverId, reopened);
				await this.refreshConnection(serverId, { allowRecovery: false });
			}
			return this.connections.get(serverId)!;
		})();

		this.reconnectInFlight.set(serverId, reconnectPromise);
		try {
			return await reconnectPromise;
		} finally {
			this.reconnectInFlight.delete(serverId);
		}
	}

	private async executeWithAuthRecovery<T>(
		serverId: string,
		operation: (conn: ManagedConnection) => Promise<T>,
		options: { allowRecovery?: boolean } = {},
	): Promise<T> {
		const conn = this.connections.get(serverId);
		if (!conn) throw new Error(`Connection "${serverId}" not found.`);
		const allowRecovery = options.allowRecovery !== false;
		try {
			return await operation(conn);
		} catch (error) {
			if (
				!allowRecovery ||
				!conn.config.headerFactory ||
				!isAuthRecoveryError(error)
			) {
				throw error;
			}
			const recovered = await this.reconnect(serverId);
			return operation(recovered);
		}
	}

	async refreshConnection(
		serverId: string,
		options: { allowRecovery?: boolean } = {},
	): Promise<McpConnection> {
		return this.executeWithAuthRecovery(
			serverId,
			async (conn) => {
				if (conn.mode === "stateless") {
					return this.refreshStatelessConnection(serverId, conn);
				}
				const capabilities = conn.client.getServerCapabilities();

				// True atomic-replace: build every "next" snapshot off the side of
				// `conn`, await all listings, then swap them in as a single
				// synchronous block at the end. A reader on a different turn sees
				// either the full previous snapshot or the full new one — never
				// half a refresh (e.g. tools updated but resources still stale, or
				// templates briefly missing while skill-index merge is in flight).
				// ALWAYS attempt to list tools; on a transient error preserve the
				// existing tools rather than downgrading to `[]`. We deliberately do
				// NOT gate on `capabilities?.tools`: `getServerCapabilities()` can
				// momentarily return `undefined` (e.g. right after a mid-conversation
				// reconnect / AIH re-auth, before the fresh `initialize` lands), and
				// the old truthiness gate would then swap in `[]` and STRIP the
				// server's tools — including the Code Mode `code` tool — so
				// `selectCodeServer` throws "No connected MCP server exposes Code
				// Mode" for the rest of the session even though apps/mcp keeps
				// serving Code Mode. A genuinely tool-less server simply returns `[]`.
				const nextToolsPromise = conn.client
					.listTools(undefined, { cacheMode: "refresh" })
					.then((result) => this.mapToolsListResult(serverId, result))
					.catch(() => conn.tools);

				const nextResourcesPromise = capabilities?.resources
					? conn.client
							.listResources()
							.then((result) => this.mapResourcesListResult(serverId, result))
					: Promise.resolve<McpResourceInfo[]>([]);

				const nextResourceTemplatesPromise = capabilities?.resources
					? conn.client
							.listResourceTemplates()
							.then((result) =>
								this.mapResourceTemplatesListResult(serverId, result),
							)
							.catch(() => [])
					: Promise.resolve<McpResourceTemplateInfo[]>([]);

				const nextPromptsPromise = capabilities?.prompts
					? conn.client
							.listPrompts()
							.then((result) => this.mapPromptsListResult(serverId, result))
					: Promise.resolve<McpPromptInfo[]>([]);

				const [nextTools, nextResources, nextResourceTemplates, nextPrompts] =
					await Promise.all([
						nextToolsPromise,
						nextResourcesPromise,
						nextResourceTemplatesPromise,
						nextPromptsPromise,
					]);

				if (capabilities?.resources) {
					// SEP-2640 index-first skill discovery — operates on local
					// arrays so the merge doesn't briefly reveal a partial state.
					await this.mergeSkillIndex(conn, serverId, nextResources);
				}

				// Atomic swap. From this point a concurrent reader sees the new
				// snapshot consistently across all four slots.
				conn.tools = nextTools;
				conn.resources = nextResources;
				conn.resourceTemplates = nextResourceTemplates;
				conn.prompts = nextPrompts;

				conn.guidance = this.buildGuidanceResourceSummaries(conn);
				return conn.info;
			},
			options,
		);
	}

	listTools(serverId?: string): McpToolInfo[] {
		if (serverId) {
			const conn = this.connections.get(serverId);
			if (!conn) throw new Error(`Connection "${serverId}" not found.`);
			return conn.tools;
		}
		return [...this.connections.values()].flatMap(
			(connection) => connection.tools,
		);
	}

	async callTool(
		serverId: string,
		toolName: string,
		args?: Record<string, unknown>,
		options?: {
			signal?: AbortSignal;
			embeddedSessionToken?: string;
			onTaskInputRequired?: McpServerConfig["onTaskInputRequired"] | null;
		},
	): Promise<unknown> {
		const original = this.connections.get(serverId);
		if (!original) throw new Error(`Connection "${serverId}" not found.`);
		const signal = options?.signal;
		signal?.throwIfAborted();
		const originalResolver =
			options && Object.hasOwn(options, "onTaskInputRequired")
				? (options.onTaskInputRequired ?? createAgentElicitationResolver({}))
				: createAgentElicitationResolver({});
		const resolver: McpServerConfig["onTaskInputRequired"] = async (input) => {
			signal?.throwIfAborted();
			const result = await originalResolver(input);
			signal?.throwIfAborted();
			return result;
		};
		const bindInvocation = (
			connection: ManagedConnection,
		): ManagedConnection => ({
			...connection,
			config: { ...connection.config, onTaskInputRequired: resolver },
			get tools() {
				return connection.tools;
			},
			set tools(value) {
				connection.tools = value;
			},
		});
		const conn = bindInvocation(original);
		// Private proof belongs to this request only, never shared connection state.
		if (options?.embeddedSessionToken) {
			const result = await this.callToolWithSchemaRefresh(
				conn,
				toolName,
				args ?? {},
				options.embeddedSessionToken,
				signal,
			);
			return this.resolveTaskResult(conn.config, result, signal);
		}

		const retrySafe = this.isToolRetrySafe(conn, toolName);
		try {
			return await this.callToolOnConnectionWithAuthResultCheck(
				conn,
				toolName,
				args,
				signal,
			);
		} catch (firstError) {
			signal?.throwIfAborted();
			if (!this.shouldRecoverToolCall(firstError, retrySafe)) {
				throw firstError;
			}

			let recovered = conn;
			try {
				recovered = bindInvocation(await this.reconnect(serverId, signal));
			} catch (reconnectError) {
				signal?.throwIfAborted();
				if (!this.shouldRecoverToolCall(reconnectError, retrySafe)) {
					throw firstError;
				}
			}

			try {
				return await this.callToolOnConnectionWithAuthResultCheck(
					recovered,
					toolName,
					args,
					signal,
				);
			} catch (secondError) {
				signal?.throwIfAborted();
				if (!this.shouldRecoverToolCall(secondError, retrySafe)) {
					throw secondError;
				}
			}

			try {
				return this.assertNoAuthRecoveryResult(
					await this.callToolWithFreshClient(recovered, toolName, args, signal),
					toolName,
				);
			} catch (thirdError) {
				signal?.throwIfAborted();
				if (!this.shouldRecoverToolCall(thirdError, retrySafe)) {
					throw thirdError;
				}
			}

			return this.callToolWithStatelessPost(recovered, toolName, args, signal);
		}
	}

	private shouldRecoverToolCall(error: unknown, retrySafe: boolean): boolean {
		if (isAuthRecoveryError(error)) return true;
		return retrySafe && isTransportRecoveryError(error);
	}

	private isToolRetrySafe(conn: ManagedConnection, toolName: string): boolean {
		const toolInfo = conn.tools.find((tool) => tool.name === toolName);
		const annotations = toolInfo?.annotations;
		if (!annotations || annotations.destructiveHint) return false;
		return Boolean(annotations.readOnlyHint || annotations.idempotentHint);
	}

	/** Read a persisted MCP Task without replaying the originating tool call. */
	async getTask(serverId: string, taskId: string): Promise<McpTaskState> {
		const config = this.taskServerConfig(serverId);
		return (await this.rawMcpPost(config, "tasks/get", {
			taskId,
		})) as McpTaskState;
	}

	/**
	 * Resume polling a task id persisted by the host across reloads or reconnects.
	 * Uses the same bounded polling and MRTR input resolver as a new tool call.
	 */
	async resumeTask(
		serverId: string,
		taskId: string,
		options?: {
			signal?: AbortSignal;
			onTaskInputRequired?: McpServerConfig["onTaskInputRequired"] | null;
		},
	): Promise<unknown> {
		const signal = options?.signal;
		const originalResolver =
			options?.onTaskInputRequired ?? createAgentElicitationResolver({});
		const config = {
			...this.taskServerConfig(serverId),
			onTaskInputRequired: async (
				input: Parameters<
					NonNullable<McpServerConfig["onTaskInputRequired"]>
				>[0],
			) => {
				signal?.throwIfAborted();
				const result = await originalResolver(input);
				signal?.throwIfAborted();
				return result;
			},
		};
		return this.resolveTaskResult(
			config,
			{ resultType: "task", taskId },
			options?.signal,
		);
	}

	/** Submit MRTR input responses for a persisted task. */
	async updateTask(
		serverId: string,
		taskId: string,
		inputResponses: Record<string, unknown>,
	): Promise<void> {
		const config = this.taskServerConfig(serverId);
		await this.rawMcpPost(config, "tasks/update", {
			taskId,
			inputResponses,
		});
	}

	/** Cancel a persisted task explicitly. Unlike abort cleanup, errors surface. */
	async cancelTask(serverId: string, taskId: string): Promise<void> {
		const config = this.taskServerConfig(serverId);
		await this.rawMcpPost(config, "tasks/cancel", { taskId });
	}

	private taskServerConfig(serverId: string): McpServerConfig {
		const conn = this.connections.get(serverId);
		if (!conn) throw new Error(`Connection "${serverId}" not found.`);
		return conn.config;
	}

	private async callToolOnConnectionWithAuthResultCheck(
		conn: ManagedConnection,
		toolName: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		const result = await this.callToolOnConnection(
			conn,
			toolName,
			args,
			signal,
		);
		return this.assertNoAuthRecoveryResult(result, toolName);
	}

	private assertNoAuthRecoveryResult(
		result: unknown,
		toolName: string,
	): unknown {
		const message = authRecoveryMessageFromResult(result);
		if (!message) return result;
		throw new Error(
			`MCP tool "${toolName}" returned recoverable auth result: ${message}`,
		);
	}

	private async callToolOnConnection(
		conn: ManagedConnection,
		toolName: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		const callArgs = args ?? {};
		const toolInfo = conn.tools.find((tool) => tool.name === toolName);
		const paramHeaders = buildMcpParamHeaders(toolInfo?.inputSchema, callArgs);
		if (conn.mode === "stateless" || Object.keys(paramHeaders).length > 0) {
			const result = await this.callToolWithSchemaRefresh(
				conn,
				toolName,
				callArgs,
				undefined,
				signal,
			);
			return this.resolveTaskResult(conn.config, result, signal);
		}
		const trace = this.outboundTraceContext();
		let result;
		try {
			result = await conn.client.callTool(
				{
					name: toolName,
					arguments: args,
					...(Object.keys(trace.meta).length > 0 ? { _meta: trace.meta } : {}),
				},
				{ signal },
			);
		} catch (error) {
			// Validation happens AFTER dispatch. Refresh metadata for the next call,
			// but preserve this failure: replay could duplicate a completed action.
			if (
				ProtocolError.isInstance(error) &&
				error.code === ProtocolErrorCode.InvalidParams &&
				error.message.includes(
					"Structured content does not match the tool's output schema:",
				)
			) {
				await this.refreshConnection(conn.info.serverId, {
					allowRecovery: false,
				}).catch((refreshError) => {
					console.error(
						"[mcp-client-core] tool schema refresh failed:",
						refreshError instanceof Error
							? refreshError.message
							: String(refreshError),
					);
				});
			}
			throw error;
		}
		return this.resolveTaskResult(conn.config, result, signal);
	}

	/**
	 * MCP 2026-07-28 Tasks (client side). If a tool result is a
	 * `resultType: "task"` envelope, drive it through the shared
	 * `@tedix/mcp-shared/task-polling` policy (backoff, not-found, abort →
	 * `tasks/cancel`, `input_required` via `onTaskInputRequired`) and return the
	 * completed tool result; any other outcome surfaces the task state.
	 */
	private async resolveTaskResult(
		config: McpServerConfig,
		result: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		const taskId = extractMcpTaskId(result);
		if (!taskId) return result;

		const subscription = await this.openTaskSubscription(
			config,
			taskId,
			signal,
		);
		try {
			const outcome = await pollMcpTask({
				taskId,
				request: (method, params, requestSignal) =>
					this.rawMcpPost(
						config,
						method,
						params,
						undefined,
						undefined,
						requestSignal,
					),
				signal,
				push: subscription,
				maxAttempts: config.taskPolling?.maxAttempts ?? 30,
				maxIntervalMs: config.taskPolling?.maxIntervalMs,
				resolveInput: config.onTaskInputRequired,
			});
			if (outcome.status === "completed") return outcome.result;
			// failed / cancelled / unanswerable input_required surface the task
			// state; an exhausted budget surfaces the last observed state.
			return outcome.state ?? result;
		} finally {
			subscription?.close();
		}
	}

	/**
	 * Open the finalized 2026 task-notification stream for a Tedix-hosted MCP
	 * endpoint. External and legacy servers keep the bounded polling path. The
	 * stream is only a wake-up/complete-state optimization: any setup, parse, or
	 * reconnect failure fails closed to `tasks/get` on the next loop.
	 */
	private async openTaskSubscription(
		config: McpServerConfig,
		taskId: string,
		signal?: AbortSignal,
	): Promise<TaskSubscription | null> {
		let hostname = "";
		try {
			hostname = new URL(config.url).hostname.toLowerCase();
		} catch {
			return null;
		}
		if (!isManagedMcpHostname(hostname)) return null;

		const context = await this.resolveStatelessRequestContext(config);
		if (!context.negotiation.modern) return null;
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal?.reason);
		if (signal?.aborted) return null;
		signal?.addEventListener("abort", onAbort, { once: true });
		const setupTimeout = setTimeout(() => controller.abort(), 2_500);
		const trace = this.outboundTraceContext();

		try {
			const response = await guardedMcpFetch(config.url, {
				method: "POST",
				headers: {
					...context.headers,
					...trace.headers,
					...this.modernRequestHeaders("subscriptions/listen", undefined, true),
					"Accept-Encoding": "identity",
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: crypto.randomUUID(),
					method: "subscriptions/listen",
					params: {
						notifications: { taskIds: [taskId] },
						_meta: {
							...trace.meta,
							[PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
							[CLIENT_INFO_META_KEY]: MODERN_CLIENT_INFO,
							[CLIENT_CAPABILITIES_META_KEY]:
								statelessClientCapabilities(config),
						},
					},
				}),
				signal: controller.signal,
			});
			clearTimeout(setupTimeout);
			if (
				!response.ok ||
				!response.body ||
				!response.headers.get("content-type")?.includes("text/event-stream")
			) {
				controller.abort();
				signal?.removeEventListener("abort", onAbort);
				return null;
			}

			const states: Record<string, unknown>[] = [];
			const waiters: Array<(state: Record<string, unknown> | null) => void> =
				[];
			let closed = false;
			const finish = () => {
				if (closed) return;
				closed = true;
				controller.abort();
				signal?.removeEventListener("abort", onAbort);
				for (const resolve of waiters.splice(0)) resolve(null);
			};
			void (async () => {
				const reader = response.body!.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				try {
					while (!closed) {
						const chunk = await reader.read();
						if (chunk.done) break;
						buffer += decoder.decode(chunk.value, { stream: true });
						let boundary = buffer.indexOf("\n\n");
						while (boundary >= 0) {
							const event = buffer.slice(0, boundary);
							buffer = buffer.slice(boundary + 2);
							const data = event
								.split("\n")
								.filter((line) => line.startsWith("data:"))
								.map((line) => line.slice(5).trimStart())
								.join("\n");
							if (data) {
								try {
									const message = JSON.parse(data) as Record<string, unknown>;
									if (
										message.method === "notifications/tasks" &&
										isRecord(message.params) &&
										message.params.taskId === taskId
									) {
										const waiter = waiters.shift();
										if (waiter) waiter(message.params);
										else states.push(message.params);
									}
								} catch {
									// Ignore one malformed event; polling remains authoritative.
								}
							}
							boundary = buffer.indexOf("\n\n");
						}
					}
				} catch {
					// Disconnects fall back to bounded polling.
				} finally {
					finish();
				}
			})();

			return {
				next: async (timeoutMs) => {
					const state = states.shift();
					if (state) return state;
					if (closed || timeoutMs <= 0) return null;
					return new Promise((resolve) => {
						const waiter = (value: Record<string, unknown> | null) => {
							clearTimeout(timer);
							resolve(value);
						};
						const timer = setTimeout(() => {
							const index = waiters.indexOf(waiter);
							if (index >= 0) waiters.splice(index, 1);
							resolve(null);
						}, timeoutMs);
						waiters.push(waiter);
					});
				},
				close: finish,
			};
		} catch {
			clearTimeout(setupTimeout);
			controller.abort();
			signal?.removeEventListener("abort", onAbort);
			return null;
		}
	}

	private async callToolWithFreshClient(
		conn: ManagedConnection,
		toolName: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		const fresh = await this.openConnection(
			conn.info.serverId,
			conn.config,
			priorDiscoveryFromConnection(conn),
			signal,
		);
		fresh.tools = conn.tools;
		try {
			return await this.callToolOnConnection(fresh, toolName, args, signal);
		} finally {
			await this.closeConnection(fresh).catch(() => {});
		}
	}

	private async callToolWithStatelessPost(
		conn: ManagedConnection,
		toolName: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		const callArgs = args ?? {};
		const result = await this.callToolWithSchemaRefresh(
			conn,
			toolName,
			callArgs,
			undefined,
			signal,
		);
		return this.resolveTaskResult(conn.config, result, signal);
	}

	/**
	 * MCP 2026-07-28 HeaderMismatch recovery. A `tools/call` rejected with
	 * -32020 has not executed. Refresh the authoritative tool schema, rebuild
	 * Mcp-Param-* bindings, and retry the original call exactly once.
	 */
	private async callToolWithSchemaRefresh(
		conn: ManagedConnection,
		toolName: string,
		callArgs: Record<string, unknown>,
		embeddedSessionToken?: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		const call = (): Promise<unknown> => {
			const toolInfo = conn.tools.find((tool) => tool.name === toolName);
			return this.rawMcpPost(
				conn.config,
				"tools/call",
				{
					name: toolName,
					arguments: callArgs,
					...(embeddedSessionToken
						? { _meta: { "tedix/embedded-session": embeddedSessionToken } }
						: {}),
				},
				buildMcpParamHeaders(toolInfo?.inputSchema, callArgs),
				undefined,
				signal,
			);
		};

		try {
			return await call();
		} catch (error) {
			if (!isHeaderMismatchError(error)) throw error;
			const tools = await this.rawMcpListAll(
				conn.config,
				"tools/list",
				"tools",
			);
			conn.tools = this.mapToolsListResult(conn.info.serverId, tools);
			return call();
		}
	}

	listResources(serverId?: string): McpResourceInfo[] {
		if (serverId) {
			const conn = this.connections.get(serverId);
			if (!conn) throw new Error(`Connection "${serverId}" not found.`);
			return conn.resources;
		}
		return [...this.connections.values()].flatMap(
			(connection) => connection.resources,
		);
	}

	listResourceTemplates(serverId?: string): McpResourceTemplateInfo[] {
		if (serverId) {
			const conn = this.connections.get(serverId);
			if (!conn) throw new Error(`Connection "${serverId}" not found.`);
			return conn.resourceTemplates;
		}
		return [...this.connections.values()].flatMap(
			(connection) => connection.resourceTemplates,
		);
	}

	async readResource(serverId: string, uri: string): Promise<unknown> {
		return this.executeWithAuthRecovery(serverId, async (conn) =>
			this.readResourceOnConnection(conn, uri),
		);
	}

	/**
	 * Fetch the manifest for exactly one Skills-extension URI. This is an
	 * explicit, on-demand metadata read; it does not read the skill's resource
	 * contents or activate its instructions.
	 */
	async getSkill(serverId: string, uri: string): Promise<unknown> {
		const normalizedUri = uri.trim();
		if (!normalizedUri || normalizedUri !== uri || normalizedUri.length > 2_048)
			throw new Error(
				"uri must be a non-empty exact MCP skill URI (max 2048 characters)",
			);
		return this.executeWithAuthRecovery(serverId, async (conn) => {
			if (!connectionSupportsSkills(conn)) {
				throw new Error(
					`MCP skills/get unavailable: server "${serverId}" did not declare ${MCP_SKILLS_EXTENSION}`,
				);
			}
			const raw =
				conn.mode === "sdk"
					? await conn.client.request(
							{ method: "skills/get", params: { uri: normalizedUri } },
							GetSkillResultSchema,
						)
					: await this.rawMcpPost(conn.config, "skills/get", {
							uri: normalizedUri,
						});
			const parsed = GetSkillResultSchema.parse(raw);
			if (parsed.skill.uri !== normalizedUri)
				throw new Error(
					`MCP skills/get returned URI "${parsed.skill.uri}" for requested URI "${normalizedUri}"`,
				);
			const encoded = JSON.stringify(parsed);
			if (new TextEncoder().encode(encoded).byteLength > 1_048_576)
				throw new Error(
					"MCP skills/get response exceeds the 1 MiB metadata limit",
				);
			return parsed;
		});
	}

	/**
	 * Whether a connected server declared the skills extension's `directoryRead`
	 * capability (via `server/discover` for stateless connections, or the legacy
	 * `initialize` capabilities for SDK connections). A conformant client MUST
	 * NOT call `resources/directory/read` against a server that did not.
	 */
	serverSupportsDirectoryRead(serverId: string): boolean {
		const conn = this.connections.get(serverId);
		return conn ? connectionSupportsDirectoryRead(conn) : false;
	}

	async readDirectory(
		serverId: string,
		uri: string,
		cursor?: string,
	): Promise<unknown> {
		return this.executeWithAuthRecovery(serverId, async (conn) => {
			if (!connectionSupportsDirectoryRead(conn)) {
				// Undeclared capability: skip the round-trip and surface the same
				// method-not-found error a non-implementing server would return, so
				// callers take their existing directory-read failure path.
				throw new Error(
					`MCP resources/directory/read error: ${JSON.stringify({
						code: -32601,
						message:
							"Server did not declare the skills extension directoryRead capability",
					})}`,
				);
			}
			return this.rawMcpPost(conn.config, "resources/directory/read", {
				uri,
				...(cursor === undefined ? {} : { cursor }),
			});
		});
	}

	private async readResourceOnConnection(
		conn: ManagedConnection,
		uri: string,
	): Promise<unknown> {
		if (conn.mode === "stateless") {
			return this.rawMcpPost(conn.config, "resources/read", { uri });
		}
		try {
			return await conn.client.readResource({ uri });
		} catch {
			return this.rawMcpPost(conn.config, "resources/read", { uri });
		}
	}

	listPrompts(serverId?: string): McpPromptInfo[] {
		if (serverId) {
			const conn = this.connections.get(serverId);
			if (!conn) throw new Error(`Connection "${serverId}" not found.`);
			return conn.prompts;
		}
		return [...this.connections.values()].flatMap(
			(connection) => connection.prompts,
		);
	}

	async getPrompt(
		serverId: string,
		name: string,
		args?: Record<string, string>,
	): Promise<unknown> {
		return this.executeWithAuthRecovery(serverId, async (conn) => {
			if (conn.mode === "stateless") {
				return this.rawMcpPost(conn.config, "prompts/get", {
					name,
					...(args ? { arguments: args } : {}),
				});
			}
			try {
				return await conn.client.getPrompt({
					name,
					...(args ? { arguments: args } : {}),
				});
			} catch {
				return this.rawMcpPost(conn.config, "prompts/get", {
					name,
					...(args ? { arguments: args } : {}),
				});
			}
		});
	}

	/**
	 * Whether a connected server advertised the 2026-07-28 `completions`
	 * capability (via `server/discover` for stateless connections, or the SDK
	 * `initialize` capabilities for SDK connections). Lets a caller skip
	 * `complete()` on servers that cannot autocomplete.
	 */
	serverSupportsCompletions(serverId: string): boolean {
		const conn = this.connections.get(serverId);
		return Boolean(conn?.info.capabilities?.completions);
	}

	/**
	 * MCP 2026-07-28 autocomplete. Sends `completion/complete` to resolve
	 * suggestions for a prompt argument (`ref/prompt`) or a resource URI-template
	 * variable (`ref/resource`). Stateless connections always raw-POST so the
	 * modern binding headers + `_meta` are emitted; SDK connections try the live
	 * client first and fall back to raw POST on failure, same as
	 * `readResourceOnConnection`/`getPrompt`. Returns the server's
	 * `{ completion: { values, total?, hasMore? } }` result.
	 */
	async complete(
		serverId: string,
		ref: McpCompletionRef,
		argument: { name: string; value: string },
		context?: { arguments?: Record<string, string> },
	): Promise<McpCompletionResult> {
		return this.executeWithAuthRecovery(serverId, async (conn) => {
			const params = { ref, argument, ...(context ? { context } : {}) };
			const result =
				conn.mode === "stateless"
					? await this.rawMcpPost(conn.config, "completion/complete", params)
					: await conn.client
							.complete(params)
							.catch(() =>
								this.rawMcpPost(conn.config, "completion/complete", params),
							);
			const completion =
				isRecord(result) && isRecord(result.completion)
					? result.completion
					: {};
			const values = Array.isArray(completion.values)
				? completion.values.filter((v): v is string => typeof v === "string")
				: [];
			const out: McpCompletionResult = { values };
			if (typeof completion.total === "number") out.total = completion.total;
			if (typeof completion.hasMore === "boolean")
				out.hasMore = completion.hasMore;
			return out;
		});
	}

	listGuidanceResources(serverId?: string): McpGuidanceInfo[] {
		if (serverId) {
			const conn = this.connections.get(serverId);
			if (!conn) throw new Error(`Connection "${serverId}" not found.`);
			return conn.guidance;
		}
		return [...this.connections.values()].flatMap(
			(connection) => connection.guidance,
		);
	}

	async readGuidance(
		serverId: string,
		uri: string,
	): Promise<{ text: string; guidance: McpGuidanceInfo }> {
		return this.executeWithAuthRecovery(serverId, async (conn) => {
			const result = await this.readResourceOnConnection(conn, uri);
			const text = truncate(
				extractTextFromResourceResult(result),
				this.guidanceMaxChars,
			);
			const existing = conn.guidance.find((item) => item.uri === uri);
			const metadata = parseGuidanceFrontmatter(text) ?? existing?.metadata;
			const guidance: McpGuidanceInfo = existing ?? {
				serverId,
				uri,
				name: uri,
				kind: "guide",
				summary: buildGuidanceSummary(
					text,
					undefined,
					metadata,
					this.guidanceSummaryMaxChars,
				),
				sourceUrl: conn.info.url,
				serverName: conn.info.serverName,
				serverVersion: conn.info.serverVersion,
				metadata,
			};
			return {
				text,
				guidance: {
					...guidance,
					name: metadata?.title ?? guidance.name,
					description: metadata?.description ?? guidance.description,
					metadata,
					summary: buildGuidanceSummary(
						text,
						guidance.description,
						metadata,
						this.guidanceSummaryMaxChars,
					),
				},
			};
		});
	}

	/** Merge native Skills extension discovery into the ordinary resource set. */
	private async mergeSkillIndex(
		conn: ManagedConnection,
		serverId: string,
		// Operate on caller-supplied "next" arrays so refreshConnection can
		// build the full snapshot off-side and swap atomically. Mutating
		// `conn.resources` directly here would briefly reveal a partial state.
		resources: McpResourceInfo[],
	): Promise<void> {
		if (!conn.extensions[MCP_SKILLS_EXTENSION]) return;
		try {
			const raw =
				conn.mode === "sdk"
					? await conn.client.request(
							{ method: "skills/list", params: {} },
							ListSkillsResultSchema,
						)
					: await this.rawMcpListAll(conn.config, "skills/list", "skills");
			const parsed = ListSkillsResultSchema.parse(raw);
			const known = new Map(
				resources.map((resource) => [resource.uri, resource]),
			);
			for (const entry of parsed.skills) {
				const audience = Array.isArray(entry.frontmatter.audience)
					? entry.frontmatter.audience.filter(
							(value): value is string => typeof value === "string",
						)
					: undefined;
				const existing = known.get(entry.uri);
				const projected: McpResourceInfo = {
					serverId,
					uri: entry.uri,
					name:
						typeof entry.frontmatter.name === "string"
							? entry.frontmatter.name
							: guidanceNameFromUri(entry.uri),
					description:
						typeof entry.frontmatter.description === "string"
							? entry.frontmatter.description
							: undefined,
					mimeType: "text/markdown",
					annotations: {
						...(existing?.annotations ?? {}),
						...(audience?.length ? { audience } : {}),
						...(entry.resources ? { resources: entry.resources } : {}),
					},
				};
				if (existing) Object.assign(existing, projected);
				else {
					resources.push(projected);
					known.set(entry.uri, projected);
				}
			}
		} catch {
			// A falsely advertised extension must not erase resources/list guidance.
		}
	}

	private buildGuidanceResourceSummaries(
		conn: ManagedConnection,
	): McpGuidanceInfo[] {
		const candidates = conn.resources
			.map((resource) => ({
				resource,
				kind: classifyGuidanceResource(resource),
			}))
			.filter(
				(
					entry,
				): entry is {
					resource: McpResourceInfo;
					kind: McpGuidanceInfo["kind"];
				} => Boolean(entry.kind),
			)
			// Audience filter: exclude resources that don't target "assistant"
			.filter((entry) => {
				const ann = resolveResourceAnnotations(entry.resource);
				const audience = ann?.audience;
				if (!Array.isArray(audience) || audience.length === 0) return true;
				return audience.includes("assistant");
			})
			// Disabled-skills filter: exclude operator-disabled skills by URI or name
			.filter((entry) => {
				if (this.disabledSkills.size === 0) return true;
				const uri = entry.resource.uri;
				const name = entry.resource.name;
				return (
					!this.disabledSkills.has(uri) &&
					(!name || !this.disabledSkills.has(name))
				);
			})
			.sort(
				(a, b) =>
					scoreGuidanceResource(b.resource, b.kind) -
					scoreGuidanceResource(a.resource, a.kind),
			);

		return candidates.map((entry) => {
			const metadata = guidanceMetadataFromResource(entry.resource);
			const name =
				metadata?.title ??
				entry.resource.name ??
				guidanceNameFromUri(entry.resource.uri);
			const description =
				metadata?.description ?? entry.resource.description ?? undefined;
			return {
				serverId: conn.info.serverId,
				uri: entry.resource.uri,
				name,
				description,
				mimeType: entry.resource.mimeType,
				kind: entry.kind,
				summary: buildGuidanceSummary(
					"",
					description,
					metadata,
					this.guidanceSummaryMaxChars,
				),
				sourceUrl: conn.info.url,
				serverName: conn.info.serverName,
				serverVersion: conn.info.serverVersion,
				metadata,
			};
		});
	}

	/** Unsolicited SDK requests have no invocation authority: deterministic form fill only. */
	private registerElicitationHandler(client: Client): void {
		client.setRequestHandler("elicitation/create", async (request) => {
			const resolve = createAgentElicitationResolver({});
			const params = request.params;
			if (params.mode === "url") return { action: "decline" as const };
			try {
				const responses = await resolve({
					taskId: "",
					inputRequests: {
						elicitation: {
							message: params.message,
							requestedSchema: params.requestedSchema,
						},
					},
				});
				const response = responses?.elicitation;
				return isRecord(response) && typeof response.action === "string"
					? (response as {
							action: "accept" | "decline" | "cancel";
							content?: Record<string, string | number | boolean | string[]>;
						})
					: { action: "decline" as const };
			} catch {
				return { action: "decline" as const };
			}
		});
	}
}
