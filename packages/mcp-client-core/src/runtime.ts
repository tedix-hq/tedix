import { structuredResultIdentity } from "@tedix/mcp-shared/result-identity";
import {
	READ_COLLECTIONS_META_KEY,
	READ_OBSERVATIONS_META_KEY,
	parseOwnedConnectedCollectionReads,
	parseOwnedReadObservations,
	type OwnedConnectedCollectionRead,
	type OwnedReadObservation,
} from "@tedix/mcp-shared/read-observation-receipt";
import {
	stripCodeModeExecutionEnvelope,
	unwrapCallToolResult,
} from "@tedix/mcp-shared/tool-result";
import type {
	McpCompletionRef,
	McpDiscoveryCacheEvent,
} from "./client-manager.js";
import { McpClientManager } from "./client-manager.js";
import type { ElicitationModel } from "./elicitation-resolver.js";
import { createAgentElicitationResolver } from "./elicitation-resolver.js";
import type {
	McpConnection,
	McpGuidanceInfo,
	McpElicitationResolver,
} from "./types.js";

export type {
	McpCompletionRef,
	McpCompletionResult,
} from "./client-manager.js";

export interface AssignedMcpServer {
	serverId: string;
	url: string;
	transport: "streamable-http";
}

export interface ResolvedMcpCredentials {
	headers: Record<string, string>;
	expiresAt?: number | null;
	connectionRequired?: {
		providerId: string;
		connectUrl: string;
		providerName: string;
	};
	/**
	 * Present when the platform refused the connection because the target
	 * external MCP endpoint has no catalog row (the catalog is the connection
	 * allowlist; fail-closed). Terminal — do not retry the connection.
	 */
	catalogRefused?: {
		endpoint: string;
		reason: string;
	};
}

interface CachedCredentials extends ResolvedMcpCredentials {
	cacheExpiresAt: number;
}

export interface TedixMcpRuntimeBinding {
	conversationId: string;
	runId: string;
	traceId?: string | null;
	tracestate?: string | null;
	workItemId?: string | null;
	/** Trusted host constraints applied by the AI adapter before dispatch. */
	toolArgumentConstraints?: Record<string, string> | null;
	toolNamespacePrefix?: string | null;
	/** Exact non-host callables admitted by the signed embedded session. */
	toolAllowedCallables?: readonly string[] | null;
	/** Restrict this turn's Code Mode transport to the canonical Work gateway. */
	credentialBoundReviewOnly?: boolean;
	/** Private per-invocation proof; never serialized into tool arguments or event payloads. */
	embeddedSessionToken?: string;
}

export interface TedixMcpRuntimePlatform {
	listServers(): Promise<AssignedMcpServer[]>;
	resolveCredentials(serverUrl: string): Promise<ResolvedMcpCredentials>;
	recordToolEvent?(event: {
		kind: "tool.started" | "tool.completed" | "tool.failed";
		sequence: number;
		idSuffix: string;
		conversationId: string;
		runId: string;
		payload: Record<string, unknown>;
	}): Promise<void>;
}

export interface TedixMcpToolSpec {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface TedixMcpToolCallRecord {
	name: string;
	args: Record<string, unknown>;
	ok: boolean;
	serverId?: string;
	error?: string;
}

export function extractCredentialBoundCallables(value: unknown): string[] {
	const rows = Array.isArray(value)
		? value
		: value && typeof value === "object"
			? (() => {
					const record = value as Record<string, unknown>;
					for (const key of ["result", "results", "data"]) {
						const nested = record[key];
						if (nested !== undefined && nested !== value) {
							const extracted = extractCredentialBoundCallables(nested);
							if (extracted.length > 0) return extracted;
						}
					}
					return Object.keys(record)
						.filter((key) => /^(0|[1-9]\d*)$/.test(key))
						.sort((a, b) => Number(a) - Number(b))
						.map((key) => record[key]);
				})()
			: [];
	return rows.flatMap((row) => {
		if (typeof row === "string") return [row];
		if (!row || typeof row !== "object" || Array.isArray(row)) return [];
		const record = row as Record<string, unknown>;
		if (record.authorized === false) return [];
		const callable = record.callable;
		return typeof callable === "string" ? [callable] : [];
	});
}

export function credentialBoundDiscoveryCode(query: string): string {
	return `async () => (await discover.search(${jsonArg(query)}, { limit: 25, includeParameters: false })).filter((hit) => hit.authorized !== false && typeof hit.callable === "string").map((hit) => hit.callable).slice(0, 25)`;
}

export function credentialBoundReviewDiscoveryCode(): string {
	return 'async () => { const hits = await discover.search("review work evidence complete work item", { limit: 25, includeParameters: false }); return hits.filter((hit) => hit.authorized !== false && typeof hit.callable === "string").map((hit) => hit.callable).filter((callable) => callable.endsWith(".review_work_evidence") || callable.endsWith(".review_work_item_evidence") || callable.endsWith(".complete_work_item")).slice(0, 25); }';
}

export type TedixMcpToolTimeoutPolicy =
	| number
	| Partial<Record<string, number>>
	| ((name: string) => number);

export interface RetainedToolResultRef {
	resultId: string;
	totalChars: number;
}

export interface RetainToolResultInput {
	binding: TedixMcpRuntimeBinding;
	toolName: string;
	result: unknown;
	resultIdentity?: string;
}

export interface TedixMcpRuntimeOptions {
	platform: TedixMcpRuntimePlatform;
	manager?: McpClientManager;
	/**
	 * Open assigned servers from the modern sessionless snapshot directly.
	 * Worker/DO runtimes should enable this when their assigned Tedix gateways
	 * are modern-only: attempting an SDK session first allocates a client and
	 * transport that cannot connect, then duplicates that state during the
	 * stateless fallback. The default remains SDK-first for external consumers.
	 */
	preferStatelessConnections?: boolean;
	maxConnections?: number;
	syncTtlMs?: number;
	connectRetryDelayMs?: number;
	coldSyncRetryDelayMs?: number;
	credentialCacheTtlMs?: number;
	credentialRefreshSkewMs?: number;
	maxToolResultChars?: number;
	ledgerPayloadMaxChars?: number;
	/** Retain an oversized successful result behind a caller-scoped opaque handle. */
	retainToolResult?: (
		input: RetainToolResultInput,
	) => Promise<RetainedToolResultRef>;
	toolTimeoutMs?: TedixMcpToolTimeoutPolicy;
	/**
	 * Per-server connection timeout applied inside `connectServer`. Guards against
	 * an unbounded upstream connect/listTools fetch that would otherwise hang
	 * `ensureSynced` forever. Defaults to 25 s — well above a healthy sync,
	 * far below the ~15-min orphan sweep. A timeout rejection flows into
	 * `ensureSynced`'s last-known-good fallback or throws if no connections exist.
	 */
	connectTimeoutMs?: number;
	/**
	 * Per-call timeout for the OPTIONAL stateless-snapshot lists
	 * (`resources/list`, `resources/templates/list`, `prompts/list`). A slow
	 * optional list past this bound degrades to `[]` instead of gating connect
	 * behind its latency. Set this below `connectTimeoutMs` on runtimes with a
	 * tight connect budget so an aggregate gateway's slow `resources/list` cannot
	 * time out the whole connect (and poison the sync-failure backoff) after the
	 * required `tools/list` was already ready. Undefined = unbounded.
	 */
	optionalSnapshotListTimeoutMs?: number;
	deferOptionalDiscovery?: boolean;
	logger?: Pick<Console, "warn">;
	/** Fail-soft sink for bounded, credential-free discovery cache metrics. */
	onDiscoveryCacheEvent?: (event: McpDiscoveryCacheEvent) => void;
	/** Dormant private factory: a caller must capture genuine model authority independently of these correlation labels. */
	elicitationModelForInvocation?: (context: {
		binding: Readonly<TedixMcpRuntimeBinding>;
		signal: AbortSignal;
	}) => ElicitationModel | undefined;
}

const DEFAULT_SYNC_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CONNECT_RETRY_DELAY_MS = 750;
// One extra full-sync retry on the COLD path (no last-known-good connections)
// absorbs a single transient (listServers RPC / AIH resolve / per-server connect)
// that would otherwise strand a delegated tedi's entire tool surface for the turn.
const DEFAULT_COLD_SYNC_RETRY_DELAY_MS = 500;
const DEFAULT_CONNECT_TIMEOUT_MS = 25_000;
const REVIEW_CONNECT_TIMEOUT_MS = 25_000;
const DEFAULT_CREDENTIAL_CACHE_TTL_MS = 50 * 60 * 1000;
const DEFAULT_CREDENTIAL_REFRESH_SKEW_MS = 60 * 1000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 12_000;
const DEFAULT_LEDGER_PAYLOAD_MAX_CHARS = 4_000;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const CODE_TOOL_TIMEOUT_MS = 25_000;
const GUIDANCE_CONTEXT_MAX_CHARS = 6_000;
const TOOL_SEQ_BASE = 100;

function reviewServerRank(serverId: string): number {
	return serverId.toLowerCase() === "tedix-unified"
		? 0
		: serverId.toLowerCase().endsWith("-unified")
			? 1
			: 2;
}

function isReviewServerId(serverId: string): boolean {
	const normalized = serverId.toLowerCase();
	return normalized === "tedix" || normalized.endsWith("-unified");
}
/**
 * Cap on distinct runs whose tool-sequence counters are tracked concurrently on
 * a single shared runtime instance. Real tedi DOs run 2-3 overlapping turns; 32
 * is far above that and bounds memory on a long-lived instance via FIFO
 * eviction (Map preserves insertion order).
 */
const MAX_TRACKED_TOOL_RUNS = 32;
const CALLABLE_RE = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/;
const CODE_MODE_CAPABILITY_PRIMER = [
	"Capability primer: search before concluding a tool is unavailable. Broad phrases are ranked, and search results include matched/unmatched terms plus nearest namespace hints.",
	"Use tedix_mcp_search_tools for provider or capability names, tedix_mcp_list_namespaces only to inspect available namespaces, and tedix_mcp_call_tool for one known namespace.tool(args) call.",
	"For multi-step work, use tedix_mcp_code so discovery, tool calls, filtering, and visual output happen in one audited execution. Its code argument must be one uninvoked async arrow function expression beginning `async () =>`; call tools only by the namespace.tool callable returned by discovery.",
	"Reuse schemas already present in the conversation. In Code Mode, return a compact projection containing only needed facts, stable IDs, completionEvidence, and verification readbacks — never an entire discovery catalog or bulk provider response.",
	"When a Code Mode workflow proves reusable, save or recall muscle memory on the tedi MCP surface instead of rewriting the same JavaScript each turn.",
].join("\n");

function codeModeErrorWithGuidance(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	const corrections: string[] = [];
	if (
		/program must evaluate to (?:a )?function|expected (?:an? )?(?:async )?function(?: expression)?/i.test(
			message,
		)
	) {
		corrections.push(
			"submit exactly one uninvoked async arrow function expression, for example `async () => await discover.list_namespaces()`; do not submit an IIFE, statement block, or call the arrow function yourself",
		);
	}
	if (/\b[A-Za-z_$][\w$]* is not defined\b/i.test(message)) {
		corrections.push(
			"use the namespace-qualified callable returned by discovery, for example `cto.exec(args)`, never a bare name such as `exec(args)`",
		);
	}
	if (corrections.length === 0) {
		return error instanceof Error ? error : new Error(message);
	}
	return new Error(
		`${message}\nCode Mode correction: ${corrections.join("; ")}.`,
	);
}

const READ_OBSERVATIONS_ON_ERROR = Symbol("readObservationsOnError");
const COLLECTION_READS_ON_ERROR = Symbol("collectionReadsOnError");
type ErrorWithReadObservations = Error & {
	[READ_OBSERVATIONS_ON_ERROR]?: OwnedReadObservation[];
	[COLLECTION_READS_ON_ERROR]?: OwnedConnectedCollectionRead[];
};

function attachReadObservationsToError(
	error: Error,
	readObservations: OwnedReadObservation[],
	collectionReads: OwnedConnectedCollectionRead[],
): ErrorWithReadObservations {
	if (readObservations.length > 0) {
		Object.defineProperty(error, READ_OBSERVATIONS_ON_ERROR, {
			value: readObservations,
			enumerable: false,
		});
	}
	if (collectionReads.length > 0) {
		Object.defineProperty(error, COLLECTION_READS_ON_ERROR, {
			value: collectionReads,
			enumerable: false,
		});
	}
	return error;
}

function readObservationsFromError(error: unknown): OwnedReadObservation[] {
	return error instanceof Error
		? ((error as ErrorWithReadObservations)[READ_OBSERVATIONS_ON_ERROR] ?? [])
		: [];
}

function collectionReadsFromError(
	error: unknown,
): OwnedConnectedCollectionRead[] {
	return error instanceof Error
		? ((error as ErrorWithReadObservations)[COLLECTION_READS_ON_ERROR] ?? [])
		: [];
}

function truncate(
	text: string,
	maxChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars - 100).trimEnd()}\n...(truncated)`;
}

/**
 * Bound a ledger payload while keeping STRUCTURED results parseable so the
 * kernel/Tedix OS can render typed cards. Plain PROSE strings are char-clipped at
 * `maxChars` and end with the `...(truncated)` marker. Structured payloads —
 * non-null objects/arrays, AND strings that are themselves a complete JSON
 * object/array (the shape `tedix_mcp_code` returns its result in: a stringified
 * object) — become a small, parseable envelope that preserves completion
 * evidence. Char-clipping structured payloads into unparseable fragments is
 * exactly what left delegated-tedi tool results un-cardable on the Tedix OS.
 */
export function truncatePayload(value: unknown, maxChars: number): unknown {
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (text.length <= maxChars) return value; // fits the base cap — nothing to do
	const structuredLike =
		(value !== null && typeof value === "object") ||
		(typeof value === "string" && isCompleteJsonStructure(text));
	if (!structuredLike) return truncate(text, maxChars);
	const structuredValue =
		typeof value === "string" ? (JSON.parse(text) as unknown) : value;
	const completionEvidence = findCompletionEvidence(structuredValue);
	const envelope = (previewChars: number) => ({
		__tedix_truncated: true,
		originalChars: text.length,
		originalType: Array.isArray(structuredValue) ? "array" : "object",
		preview: text.slice(0, previewChars),
		...(completionEvidence ? { completionEvidence } : {}),
		instruction:
			"Result exceeded the model-facing limit. Re-run with server-side filtering or return a smaller projection.",
	});
	let low = 0;
	let high = Math.min(text.length, maxChars);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (JSON.stringify(envelope(middle)).length <= maxChars) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	return envelope(low);
}

function serializedResultChars(value: unknown): number {
	try {
		return (typeof value === "string" ? value : JSON.stringify(value)).length;
	} catch {
		return String(value).length;
	}
}

function retentionFailureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return truncate(message, 500);
}

function withRetentionMetadata(
	projection: unknown,
	metadata: Record<string, unknown>,
	maxChars: number,
): unknown {
	const merged =
		projection && typeof projection === "object" && !Array.isArray(projection)
			? { ...(projection as Record<string, unknown>), ...metadata }
			: { __tedix_truncated: true, preview: String(projection), ...metadata };
	if (JSON.stringify(merged).length <= maxChars) return merged;
	const preview = typeof merged.preview === "string" ? merged.preview : "";
	const bounded = { ...merged, preview: "" };
	if (JSON.stringify(bounded).length > maxChars) {
		const compact = {
			__tedix_truncated: true,
			providerCallReturned: true,
			doNotRetryProvider: true,
			retained: metadata.retained,
			...(metadata.resultId ? { resultId: metadata.resultId } : {}),
			...(metadata.totalChars ? { totalChars: metadata.totalChars } : {}),
			completionEvidenceOmitted: true,
		};
		return compact;
	}
	let low = 0;
	let high = preview.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (
			JSON.stringify({ ...bounded, preview: preview.slice(0, middle) })
				.length <= maxChars
		)
			low = middle;
		else high = middle - 1;
	}
	return { ...bounded, preview: preview.slice(0, low) };
}

interface ProjectedToolResult {
	modelResult: unknown;
	retainedResult?: RetainedToolResultRef;
	retentionError?: string;
}

function findCompletionEvidence(
	value: unknown,
	depth = 0,
): Record<string, unknown> | null {
	if (depth > 8 || value === null || value === undefined) return null;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findCompletionEvidence(item, depth + 1);
			if (found) return found;
		}
		return null;
	}
	if (typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const evidence = record.completionEvidence;
	if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) {
		return evidence as Record<string, unknown>;
	}
	for (const item of Object.values(record)) {
		const found = findCompletionEvidence(item, depth + 1);
		if (found) return found;
	}
	return null;
}

/**
 * True when `text` is a COMPLETE JSON object or array (not prose, not a partial
 * fragment). Only attempted for over-`maxChars` strings, so the parse cost is
 * bounded to the rare large-result path.
 */
function isCompleteJsonStructure(text: string): boolean {
	const first = text.trimStart()[0];
	if (first !== "{" && first !== "[") return false;
	try {
		const parsed = JSON.parse(text);
		return parsed !== null && typeof parsed === "object";
	} catch {
		return false;
	}
}

function jsonArg(value: unknown): string {
	return JSON.stringify(value ?? {});
}

function limitText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * The EXECUTOR's own execution receipt for a Code Mode program, carried beside
 * `result` in the gateway envelope. The generic result normalizer unwraps the
 * MCP transport shape before the Code Mode-only envelope stripper removes
 * `result`, so capture the receipt first.
 * would drop it — which is exactly how a delegation that demonstrably called
 * tools reached the proof gate as UNKNOWN evidence: the per-call
 * `completionEvidence` lives inside the inner tool results, and a program that
 * returns a hand-built projection never carries it out.
 */
function codeResultCompletionEvidence(
	value: unknown,
): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const evidence = (value as Record<string, unknown>).completionEvidence;
	return evidence && typeof evidence === "object" && !Array.isArray(evidence)
		? (evidence as Record<string, unknown>)
		: null;
}

function codeResultIdentity(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const identity = (value as Record<string, unknown>).resultIdentity;
	return identity && typeof identity === "object" && !Array.isArray(identity)
		? (identity as Record<string, unknown>)
		: null;
}

function codeResultProjection(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const projection = (value as Record<string, unknown>).resultProjection;
	return projection &&
		typeof projection === "object" &&
		!Array.isArray(projection)
		? (projection as Record<string, unknown>)
		: null;
}

type ToolExecutionOutcome = {
	result: unknown;
	resultIdentity?: Record<string, unknown>;
	resultProjection?: Record<string, unknown>;
	/** Executor-attested execution receipt; recorded beside the ledger result. */
	completionEvidence?: Record<string, unknown>;
	readObservations?: OwnedReadObservation[];
	collectionReads?: OwnedConnectedCollectionRead[];
};

function timeoutFor(
	policy: TedixMcpToolTimeoutPolicy | undefined,
	name: string,
): number {
	if (typeof policy === "function") return policy(name);
	if (typeof policy === "number") return policy;
	const configured = policy?.[name];
	if (typeof configured === "number") return configured;
	if (name === "tedix_mcp_code") return CODE_TOOL_TIMEOUT_MS;
	return DEFAULT_TOOL_TIMEOUT_MS;
}

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${ms}ms`)),
					ms,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		promise.catch(() => {});
	}
}

export class TedixMcpRuntime {
	private readonly manager: McpClientManager;
	private readonly syncTtlMs: number;
	private readonly connectRetryDelayMs: number;
	private readonly coldSyncRetryDelayMs: number;
	private readonly credentialCacheTtlMs: number;
	private readonly credentialRefreshSkewMs: number;
	private readonly maxToolResultChars: number;
	private readonly ledgerPayloadMaxChars: number;
	private readonly retainToolResult?: TedixMcpRuntimeOptions["retainToolResult"];
	private readonly toolTimeoutMs?: TedixMcpToolTimeoutPolicy;
	private readonly connectTimeoutMs: number;
	private readonly logger: Pick<Console, "warn">;
	private lastSyncAt = 0;
	private lastSyncFailureAt = 0;
	private lastSyncFailureMessage: string | null = null;
	private readonly syncFailureBackoffMs = 15_000;
	private syncInFlight: Promise<void> | null = null;
	private credentials = new Map<string, CachedCredentials>();
	private toolCallLog: TedixMcpToolCallRecord[] = [];
	private binding: TedixMcpRuntimeBinding | null = null;
	private toolSeq = 0;
	/**
	 * Per-run tool-sequence counters. This runtime instance is SHARED across
	 * concurrent turns on one tedi DO, so a single `toolSeq` field would be reset
	 * to 0 by a sibling turn's `bindTurn` mid-flight — the later tool then reuses
	 * `callIdx=0`, collides on the `${runId}:tool.0.*` event id, and the ledger's
	 * idempotent insert silently drops it (the direct-path telemetry gap). Keying
	 * the counter by the CALLING turn's runId keeps each turn's tool sequence
	 * monotonic and collision-free regardless of concurrent bind/clear.
	 */
	private readonly toolSeqByRun = new Map<string, number>();

	constructor(private readonly options: TedixMcpRuntimeOptions) {
		this.manager =
			options.manager ??
			new McpClientManager(options.maxConnections ?? 25, {
				onDiscoveryCacheEvent: options.onDiscoveryCacheEvent,
				optionalSnapshotListTimeoutMs: options.optionalSnapshotListTimeoutMs,
				deferOptionalDiscovery: options.deferOptionalDiscovery,
				traceContext: () => {
					const binding = this.binding;
					if (!binding) return null;
					return {
						traceId: binding.traceId ?? binding.runId,
						tracestate: binding.tracestate,
						metadata: {
							"io.tedix/conversationId": binding.conversationId,
							"io.tedix/kernelRunId": binding.runId,
							...(binding.workItemId
								? { "io.tedix/workItemId": binding.workItemId }
								: {}),
						},
					};
				},
			});
		this.syncTtlMs = options.syncTtlMs ?? DEFAULT_SYNC_TTL_MS;
		this.connectRetryDelayMs =
			options.connectRetryDelayMs ?? DEFAULT_CONNECT_RETRY_DELAY_MS;
		this.coldSyncRetryDelayMs =
			options.coldSyncRetryDelayMs ?? DEFAULT_COLD_SYNC_RETRY_DELAY_MS;
		this.credentialCacheTtlMs =
			options.credentialCacheTtlMs ?? DEFAULT_CREDENTIAL_CACHE_TTL_MS;
		this.credentialRefreshSkewMs =
			options.credentialRefreshSkewMs ?? DEFAULT_CREDENTIAL_REFRESH_SKEW_MS;
		this.maxToolResultChars =
			options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
		this.ledgerPayloadMaxChars =
			options.ledgerPayloadMaxChars ?? DEFAULT_LEDGER_PAYLOAD_MAX_CHARS;
		this.retainToolResult = options.retainToolResult;
		this.toolTimeoutMs = options.toolTimeoutMs;
		this.connectTimeoutMs =
			options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		this.logger = options.logger ?? console;
	}

	getManager(): McpClientManager {
		return this.manager;
	}

	getToolCallLog(): TedixMcpToolCallRecord[] {
		return this.toolCallLog.slice(-20);
	}

	bindTurn(binding: TedixMcpRuntimeBinding): void {
		this.binding = { ...binding, embeddedSessionToken: undefined };
		this.toolSeq = 0;
	}

	clearTurn(): void {
		// Best-effort: drop the finishing turn's per-run counter. Threaded per-call
		// bindings mean `this.binding` may already point at a sibling turn, so the
		// FIFO cap in `nextToolSeq` is the real memory backstop — this just keeps
		// the common single-turn case tidy.
		if (this.binding) this.toolSeqByRun.delete(this.binding.runId);
		this.binding = null;
		this.toolSeq = 0;
	}

	/**
	 * Next 0-based tool index for the CALLING turn. Keyed by `binding.runId` so
	 * concurrent turns on this shared instance never reset each other's counter
	 * (which produced duplicate `${runId}:tool.N.*` event ids that the ledger
	 * deduped away). Falls back to the legacy shared counter for callers that run
	 * without a binding.
	 */
	private nextToolSeq(binding: TedixMcpRuntimeBinding | null): number {
		if (!binding) {
			const idx = this.toolSeq;
			this.toolSeq += 1;
			return idx;
		}
		const cur = this.toolSeqByRun.get(binding.runId) ?? 0;
		if (cur === 0 && this.toolSeqByRun.size >= MAX_TRACKED_TOOL_RUNS) {
			// FIFO-evict the oldest tracked run to bound memory on a long-lived DO.
			const oldest = this.toolSeqByRun.keys().next().value;
			if (oldest !== undefined) this.toolSeqByRun.delete(oldest);
		}
		this.toolSeqByRun.set(binding.runId, cur + 1);
		return cur;
	}

	private async projectSuccessfulResult(
		result: unknown,
		binding: TedixMcpRuntimeBinding | null,
		toolName: string,
		resultIdentity?: string,
	): Promise<ProjectedToolResult> {
		const totalChars = serializedResultChars(result);
		const projection = truncatePayload(result, this.maxToolResultChars);
		if (totalChars <= this.maxToolResultChars)
			return { modelResult: projection };
		const safety = {
			providerCallReturned: true,
			doNotRetryProvider: true,
		};
		if (!binding || !this.retainToolResult) {
			return {
				modelResult: withRetentionMetadata(
					projection,
					{
						...safety,
						retained: false,
						totalChars,
						retentionError:
							"Full result retention is unavailable for this call.",
						instruction:
							"The original call returned. Retention status does not change its operation outcome. Do not repeat the provider action; inspect the preview and completionEvidence.",
					},
					this.maxToolResultChars,
				),
			};
		}
		try {
			const retainedResult = await this.retainToolResult({
				binding,
				toolName,
				result,
				resultIdentity,
			});
			return {
				retainedResult,
				modelResult: withRetentionMetadata(
					projection,
					{
						...safety,
						retained: true,
						resultId: retainedResult.resultId,
						totalChars: retainedResult.totalChars,
						instruction:
							"The original call returned. Retention status does not change its operation outcome. Use mcp_read_result to inspect it; do not repeat the provider action.",
					},
					this.maxToolResultChars,
				),
			};
		} catch (error) {
			const retentionError = retentionFailureMessage(error);
			return {
				retentionError,
				modelResult: withRetentionMetadata(
					projection,
					{
						...safety,
						retained: false,
						totalChars,
						retentionError,
						instruction:
							"The original call returned, but full result retention failed. Retention status does not change its operation outcome. Do not repeat the provider action; inspect the preview and completionEvidence.",
					},
					this.maxToolResultChars,
				),
			};
		}
	}

	getToolSpecs(): TedixMcpToolSpec[] {
		return [
			{
				type: "function",
				function: {
					name: "tedix_mcp_code",
					description:
						"Execute one Tedix Unified Code Mode async function. The code must be an uninvoked `async () => ...` expression. Use discover.search/list_namespaces for metadata, then call the exact returned namespace.tool(args) callable; bare tool names are not globals.",
					parameters: {
						type: "object",
						properties: {
							code: {
								type: "string",
								description:
									"Exactly one uninvoked async arrow function expression beginning `async () =>`. Do not use an IIFE, a bare statement block, or call the arrow yourself. Use namespace-qualified callables only. Example: async () => { await discover.search({ query: 'cms_tedix content_list', includeParameters: true }); return await cms_tedix.content_list({ collection: 'posts', limit: 3 }); }",
							},
						},
						required: ["code"],
						additionalProperties: false,
					},
				},
			},
			{
				type: "function",
				function: {
					name: "tedix_mcp_list_namespaces",
					description:
						"Convenience wrapper around Tedix Unified Code Mode discovery. Prefer tedix_mcp_code when multi-step tool use is needed.",
					parameters: {
						type: "object",
						properties: {
							includeTools: {
								type: "boolean",
								description:
									"Include tool names for each namespace. Use sparingly.",
							},
						},
						additionalProperties: false,
					},
				},
			},
			{
				type: "function",
				function: {
					name: "tedix_mcp_search_tools",
					description:
						"Convenience wrapper around discover.search in Tedix Unified Code Mode. Results are metadata only and include callable strings such as cms_tedix.content_list; they are not directly executable objects.",
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description:
									"Search query, usually provider or capability names like cms_tedix, promptwatch, article search, list projects.",
							},
							limit: {
								type: "number",
								description: "Maximum results to return.",
							},
							includeParameters: {
								type: "boolean",
								description:
									"Include parameter schemas for exact calls. More verbose.",
							},
						},
						required: ["query"],
						additionalProperties: false,
					},
				},
			},
			{
				type: "function",
				function: {
					name: "tedix_mcp_call_tool",
					description:
						"Convenience wrapper for a single Tedix Unified Code Mode namespace.tool(args) call, for example promptwatch_tedix.list_projects or cms_tedix.search.",
					parameters: {
						type: "object",
						properties: {
							callable: {
								type: "string",
								description: "Exact callable in namespace.tool format.",
							},
							args: {
								type: "object",
								description: "JSON arguments for the callable.",
								additionalProperties: true,
							},
						},
						required: ["callable"],
						additionalProperties: false,
					},
				},
			},
			{
				type: "function",
				function: {
					name: "mcp_get_skill",
					description:
						"On explicit request, fetch one skill's metadata manifest by exact server ID and SKILL.md URI from a server that advertised io.modelcontextprotocol/skills. Returns inert metadata only; it does not fetch skill files or activate instructions.",
					parameters: {
						type: "object",
						properties: {
							server: {
								type: "string",
								description: "Connected MCP server ID.",
							},
							uri: {
								type: "string",
								maxLength: 2048,
								description: "Exact skill SKILL.md URI from this server.",
							},
						},
						required: ["server", "uri"],
						additionalProperties: false,
					},
				},
			},
			{
				type: "function",
				function: {
					name: "mcp_read_resource",
					description:
						"Read any MCP resource by server ID and URI. Use this to load skill:// resources for full instructions, follow cross-references inside a skill, or read templates listed in the guidance summaries (substitute {placeholders} first).",
					parameters: {
						type: "object",
						properties: {
							server: {
								type: "string",
								description:
									"Connected MCP server ID (serverId from guidance).",
							},
							uri: {
								type: "string",
								description:
									"Resource URI, e.g. skill://git-workflow/SKILL.md.",
							},
						},
						required: ["server", "uri"],
						additionalProperties: false,
					},
				},
			},
			{
				type: "function",
				function: {
					name: "mcp_directory_read",
					description:
						"Read direct children of an MCP directory resource by server ID and directory URI. Use this for skill:// directories when a server advertises the Skills extension with directoryRead.",
					parameters: {
						type: "object",
						properties: {
							server: {
								type: "string",
								description:
									"Connected MCP server ID (serverId from guidance).",
							},
							uri: {
								type: "string",
								description:
									"Directory resource URI, e.g. skill://git-workflow.",
							},
							cursor: {
								type: "string",
								description: "Optional pagination cursor from a prior result.",
							},
						},
						required: ["server", "uri"],
						additionalProperties: false,
					},
				},
			},
			{
				type: "function",
				function: {
					name: "mcp_complete_argument",
					description:
						"Autocomplete an argument value against a connected MCP server that advertises the completions capability — e.g. resolve a partial session_key/conversationId or artifact path before calling a tool that requires it. Returns candidate values only; it never calls the tool. Pick one candidate deliberately and pass it in the actual call — never guess when several candidates remain (narrow with a longer partial instead).",
					parameters: {
						type: "object",
						properties: {
							server: {
								type: "string",
								description:
									"Connected MCP server ID (serverId from guidance).",
							},
							argument: {
								type: "string",
								description:
									"Name of the argument to complete, e.g. session_key.",
							},
							partial: {
								type: "string",
								description:
									"Partial value already known; narrows the candidates.",
							},
							resourceUri: {
								type: "string",
								description:
									"Resource URI template for a ref/resource completion, e.g. repo://{branch}/tree. Takes precedence over prompt.",
							},
							prompt: {
								type: "string",
								description:
									"Prompt name for a ref/prompt completion. Defaults to tool_arguments.",
							},
							context: {
								type: "object",
								description:
									"Sibling argument values (strings) that scope the completion, e.g. { tediId: 'tedi_42' }.",
								additionalProperties: { type: "string" },
							},
						},
						required: ["server", "argument"],
						additionalProperties: false,
					},
				},
			},
		];
	}

	getSystemInstructions(): string {
		return [
			"You can use Tedix MCP tools through Tedix Unified Code Mode.",
			CODE_MODE_CAPABILITY_PRIMER,
			"The primary tool is tedix_mcp_code. Its code argument MUST be exactly one uninvoked async arrow function expression beginning `async () =>`. Never submit an IIFE, a statement block, or invoke the arrow yourself. Use discover.search/list_namespaces inside it, then call the exact namespace.tool(args) callable returned by discovery; bare tool names such as exec are not globals.",
			"Important: discover.search returns metadata objects with callable strings like cms_tedix.content_list; do not treat those metadata objects as functions.",
			"Important: discover.list_namespaces() returns an object keyed by namespace, not an array. Use Object.keys/Object.entries; do not call .filter/.map on the object itself.",
			"Correct complete Code Mode argument: async () => { await discover.search({ query: 'cms_tedix content_list', includeParameters: true }); return await cms_tedix.content_list({ collection: 'posts', limit: 3 }); }",
			"When one exact callable and its arguments are already known, prefer tedix_mcp_call_tool instead of writing Code Mode.",
			"The tedix_mcp_list_namespaces, tedix_mcp_search_tools, and tedix_mcp_call_tool tools are convenience wrappers for simple one-step cases.",
			"Never claim you used an MCP tool unless a tedix_mcp_* call succeeded.",
			"If a tool is missing or errors, report the exact tool error instead of inventing data.",
		].join("\n");
	}

	/**
	 * Per-turn MCP guidance context for the Agent runtime's progressive disclosure.
	 * Lists each connected server's skill/guide/policy summaries plus skill://
	 * resource templates; callers inject the returned block into the system
	 * prompt every turn. Returns undefined when no servers are connected.
	 */
	buildGuidanceContext(): string | undefined {
		const connections = this.manager.listConnections();
		if (connections.length === 0) return undefined;

		const lines: string[] = [
			"Discover assigned Tedix MCP tools through Code Mode or the discovery wrappers, then invoke the returned namespace-qualified callables.",
			// CODE_MODE_CAPABILITY_PRIMER intentionally omitted here: this block is
			// only ever appended after getSystemInstructions()'s base (which already
			// carries the primer), so repeating it doubled the primer on every
			// MCP-connected turn. Single authoritative copy lives in the base above.
			"Guidance uses progressive disclosure: review the concise summaries below and call mcp_read_resource with the listed server and uri only when you need the full instructions.",
			"Skill resource templates (skill:// URIs with {placeholders}) are listed per server. To read one, substitute the placeholder and call mcp_read_resource with the resulting URI.",
		];

		for (const conn of connections) {
			const toolCount = this.manager.listTools(conn.serverId).length;
			const promptCount = this.manager.listPrompts(conn.serverId).length;
			const guidance = this.manager.listGuidanceResources(conn.serverId);
			const templates = this.manager.listResourceTemplates(conn.serverId);
			const completions = this.manager.serverSupportsCompletions(conn.serverId)
				? " Supports mcp_complete_argument (argument autocompletion)."
				: "";
			lines.push(
				`Server ${conn.serverId}: ${toolCount} tool(s), ${promptCount} prompt(s), ${templates.length} resource template(s), ${guidance.length} guidance resource(s).${completions}`,
			);
			for (const item of guidance) {
				lines.push(
					`- ${item.kind} ${item.name ?? item.uri}: ${item.summary} (read with mcp_read_resource ${JSON.stringify({ server: conn.serverId, uri: item.uri })})`,
				);
			}
			for (const tmpl of templates) {
				if (!tmpl.uriTemplate.startsWith("skill://")) continue;
				const label = tmpl.title ?? tmpl.name ?? tmpl.uriTemplate;
				const desc = tmpl.description ? `: ${tmpl.description}` : "";
				lines.push(`- template ${label}${desc} → ${tmpl.uriTemplate}`);
			}
		}

		return limitText(lines.join("\n"), GUIDANCE_CONTEXT_MAX_CHARS);
	}

	/**
	 * Connected guidance resources (skill/guide/policy summaries) across all
	 * servers, used for guidance summaries and runtime traces.
	 */
	listGuidanceResources(): McpGuidanceInfo[] {
		return this.manager.listGuidanceResources();
	}

	/**
	 * Read the full text of one guidance resource (e.g. a skill:// SKILL.md),
	 * returning the latest parsed metadata alongside the body.
	 */
	async readGuidance(
		serverId: string,
		uri: string,
	): Promise<{ text: string; guidance: McpGuidanceInfo }> {
		await this.ensureSynced();
		return this.manager.readGuidance(serverId, uri);
	}

	/**
	 * Read any MCP resource by server + URI. Backs the isolate `mcp_read_resource`
	 * tool so the model can follow skill:// cross-references and templates.
	 */
	async readResource(serverId: string, uri: string): Promise<unknown> {
		await this.ensureSynced();
		return this.manager.readResource(serverId, uri);
	}

	/**
	 * Read direct children of an MCP directory resource. This exposes the Skills
	 * extension's optional `resources/directory/read` method to tedis.
	 */
	async readDirectory(
		serverId: string,
		uri: string,
		cursor?: string,
	): Promise<unknown> {
		await this.ensureSynced();
		return this.manager.readDirectory(serverId, uri, cursor);
	}

	async ensureSynced(options: { force?: boolean } = {}): Promise<void> {
		// A credential refresh must not race an older candidate into publication.
		while (options.force && this.syncInFlight)
			await this.syncInFlight.catch(() => {});
		// A forced inventory refresh is also a credential refresh. This path is
		// used by security preflights after a managed client's scopes or secret
		// rotate; retaining the prior bearer token would make the refreshed tool
		// snapshot falsely report the old authorization surface until TTL expiry.
		if (options.force) this.credentials.clear();
		const fresh = Date.now() - this.lastSyncAt < this.syncTtlMs;
		if (!options.force && fresh && this.manager.listConnections().length > 0) {
			return;
		}
		// Failure backoff: a permanently-broken tedi (no connections, recent
		// total sync failure) would otherwise hammer the upstream every turn.
		// Fail fast instead of piling up latency until the backoff window lapses.
		if (
			!options.force &&
			Date.now() - this.lastSyncFailureAt < this.syncFailureBackoffMs &&
			this.manager.listConnections().length === 0
		) {
			throw new Error(
				this.lastSyncFailureMessage
					? `MCP sync in failure backoff after: ${this.lastSyncFailureMessage}`
					: "MCP sync in failure backoff",
			);
		}
		if (!options.force && this.syncInFlight) return this.syncInFlight;

		const sync = this.syncAssignedServers();
		this.syncInFlight = sync;
		const attemptStartedAt = Date.now();
		try {
			await sync;
		} catch (err) {
			// Last-known-good fallback: if the manager still holds connections from
			// a prior successful sync, keep serving them rather than stranding the
			// turn tool-less. We deliberately do NOT advance lastSyncAt, so the next
			// ensureSynced call retries the upstream and self-heals.
			if (this.manager.listConnections().length > 0) {
				this.logger.warn(
					"[mcp-client-core] sync failed; serving last-known-good connections:",
					err instanceof Error ? err.message : err,
				);
				return;
			}
			// Cold path (no last-known-good connections): a single transient in the
			// live sync chain (listServers RPC, AIH resolve, or every server's
			// connect) would otherwise strand the ENTIRE tool surface for this turn
			// — and, via the failure backoff, poison the next turn too. This is the
			// flap that drops a delegated tedi's research/memory tools after a cold
			// start (a single per-turn-rebuilt connection carries the whole research
			// surface). Retry the full sync ONCE after a short jittered delay before
			// giving up: recovers the common single-transient case, while a genuinely
			// broken tedi still fails (the retry throws) and the failure backoff then
			// applies to sustained failures only.
			//
			// But only a TRANSIENT is worth retrying. An attempt that consumed the
			// whole connect budget failed on latency, not on a blip: the retry
			// re-runs the same sync against the same cold servers with the same
			// budget ~500 ms later, so it is guaranteed to time out again. Live
			// trace on an idle tedi showed exactly that — "MCP connect
			// tedix-unified timed out after 10000ms" twice, initial then retry —
			// costing ~10 s of dead wall clock before the turn failed anyway, and
			// re-burning a 10 s timeout on each of that tedi's unreachable servers.
			// Elapsed time is the signal rather than the message text, so this
			// survives a reworded timeout error.
			const elapsedMs = Date.now() - attemptStartedAt;
			if (elapsedMs >= this.connectTimeoutMs) {
				this.logger.warn(
					`[mcp-client-core] cold sync exhausted the ${this.connectTimeoutMs}ms connect budget in ${elapsedMs}ms; not retrying (latency, not a transient):`,
					err instanceof Error ? err.message : err,
				);
				throw err;
			}
			this.logger.warn(
				"[mcp-client-core] cold sync failed with no last-known-good; retrying once:",
				err instanceof Error ? err.message : err,
			);
			await new Promise((resolve) =>
				setTimeout(
					resolve,
					this.coldSyncRetryDelayMs +
						Math.floor(Math.random() * this.coldSyncRetryDelayMs),
				),
			);
			await this.syncAssignedServers();
			return;
		} finally {
			this.syncInFlight = null;
		}
	}

	async discoverCredentialBoundCallables(query: string): Promise<string[]> {
		await this.ensureSynced({ force: true });
		const outcome = await this.callCode(credentialBoundDiscoveryCode(query));
		return extractCredentialBoundCallables(outcome.result);
	}

	/**
	 * Establish and inspect only the canonical Work gateway used by independent
	 * evidence review. A review preflight must not be coupled to every unrelated
	 * app assigned to the reviewer, nor perform several forced full syncs.
	 */
	async discoverCredentialBoundReviewCallables(): Promise<string[]> {
		const servers = await this.options.platform.listServers();
		const reviewServers = servers
			.filter((server) => isReviewServerId(server.serverId))
			.sort(
				(left, right) =>
					reviewServerRank(left.serverId) - reviewServerRank(right.serverId),
			);
		let bestCallables: string[] = [];
		let lastError: unknown;
		for (const server of reviewServers) {
			try {
				this.credentials.delete(server.url);
				await this.connectServer(server, REVIEW_CONNECT_TIMEOUT_MS);
				const outcome = await this.callCodeOnServer(
					server.serverId,
					credentialBoundReviewDiscoveryCode(),
				);
				const callables = extractCredentialBoundCallables(outcome.result);
				if (callables.length > bestCallables.length) bestCallables = callables;
				if (
					callables.some(
						(callable) =>
							callable.endsWith(".review_work_evidence") ||
							callable.endsWith(".review_work_item_evidence"),
					) &&
					callables.some((callable) => callable.endsWith(".complete_work_item"))
				) {
					return callables;
				}
			} catch (error) {
				lastError = error;
				this.logger.warn(
					`[mcp-client-core] review gateway ${server.serverId} unavailable; trying fallback`,
				);
			}
		}
		if (bestCallables.length === 0) {
			if (lastError) throw lastError;
			return [];
		}
		return bestCallables;
	}

	private async ensureCredentialBoundReviewServer(): Promise<string> {
		const connected = this.manager
			.listConnections()
			.filter(
				(connection) =>
					isReviewServerId(connection.serverId) &&
					this.hasCodeTool(connection.serverId),
			)
			.sort(
				(left, right) =>
					reviewServerRank(left.serverId) - reviewServerRank(right.serverId),
			);
		if (connected[0]) return connected[0].serverId;

		const servers = (await this.options.platform.listServers())
			.filter((server) => isReviewServerId(server.serverId))
			.sort(
				(left, right) =>
					reviewServerRank(left.serverId) - reviewServerRank(right.serverId),
			);
		let lastError: unknown;
		for (const server of servers) {
			try {
				await this.connectServer(server, REVIEW_CONNECT_TIMEOUT_MS);
				if (this.hasCodeTool(server.serverId)) return server.serverId;
			} catch (error) {
				lastError = error;
			}
		}
		if (lastError) throw lastError;
		throw new Error("No assigned credential-bound Work review gateway");
	}

	async executeTool(
		name: string,
		args: Record<string, unknown>,
		opts?: { binding?: TedixMcpRuntimeBinding | null; signal?: AbortSignal },
	): Promise<unknown> {
		// Per-turn binding threaded by the caller wins over the shared `this.binding`
		// field. This instance is SHARED across concurrent turns on one tedi DO, so
		// relying on `this.binding` let a sibling turn's bindTurn/clearTurn either
		// reset the sequence (→ duplicate event id → ledger dedups the event away)
		// or null the binding (→ dropped/misattributed event) — the direct-path
		// `tedix_mcp_code` telemetry gap. Threading the caller's binding + keying
		// the sequence by runId makes tool telemetry immune to that race.
		const originalBinding =
			opts && Object.hasOwn(opts, "binding")
				? (opts.binding ?? null)
				: this.binding;
		const binding = originalBinding
			? Object.freeze({ ...originalBinding })
			: null;
		const callIdx = this.nextToolSeq(binding);
		const startSeq = TOOL_SEQ_BASE + callIdx * 2;
		const endSeq = startSeq + 1;
		const startedAt = Date.now();

		const toolTimeout = timeoutFor(this.toolTimeoutMs, name);
		const deadline = new AbortController();
		const signal = opts?.signal
			? AbortSignal.any([opts.signal, deadline.signal])
			: deadline.signal;
		// Capture this call's model and correlation once; subsequent bindTurn calls cannot change it.
		const model = binding
			? this.options.elicitationModelForInvocation?.({
					binding: Object.freeze({ ...binding }),
					signal,
				})
			: undefined;
		const resolver = createAgentElicitationResolver({
			model: model
				? async (request) => {
						signal.throwIfAborted();
						const result = await model(request);
						signal.throwIfAborted();
						return result;
					}
				: undefined,
			logger: this.logger,
		});

		await this.emitToolEvent({
			binding,
			kind: "tool.started",
			idSuffix: `tool.${callIdx}.started`,
			seq: startSeq,
			payload: { name, arguments: args },
		});
		// The envelope's `latencyMs` covers start-event persistence, connection
		// preparation AND the tool's own execution, which made a slow gateway
		// warm-up indistinguishable from a slow upstream API. Split the phases so
		// a latency claim names the phase it actually measured.
		const startEventMs = Date.now() - startedAt;
		let prepareMs = 0;
		let executeMs = 0;
		/** Null until the tool's own call starts, so a failure during connection
		 * preparation reports executeMs 0 rather than borrowing prepare time. */
		let executedAt: number | null = null;

		try {
			// Connection/discovery is part of this tool attempt. Keep it inside the
			// event envelope so a cold gateway timeout cannot disappear between a
			// model step's tool-call count and the durable tool ledger.
			const preparedAt = Date.now();
			const reviewServerId = binding?.credentialBoundReviewOnly
				? await this.ensureCredentialBoundReviewServer()
				: null;
			if (!reviewServerId) await this.ensureSynced();
			prepareMs = Date.now() - preparedAt;
			// Preserve the execution timeout budget while capturing its signal before preparation.
			const executionDeadline = AbortSignal.timeout(toolTimeout);
			executionDeadline.addEventListener(
				"abort",
				() => deadline.abort(executionDeadline.reason),
				{ once: true },
			);
			signal.throwIfAborted();
			executedAt = Date.now();
			const outcome = await withTimeout(
				this.executeToolInner(
					name,
					args,
					signal,
					reviewServerId,
					binding?.embeddedSessionToken,
					resolver,
				),
				toolTimeout,
				`tool '${name}'`,
			);
			executeMs = Date.now() - executedAt;
			const latencyMs = Date.now() - startedAt;
			const result = outcome.result;
			const resultIdentity =
				outcome.resultIdentity ?? structuredResultIdentity(result);
			const projected = await this.projectSuccessfulResult(
				result,
				binding,
				name,
				resultIdentity ? JSON.stringify(resultIdentity) : undefined,
			);
			await this.emitToolEvent({
				binding,
				kind: "tool.completed",
				idSuffix: `tool.${callIdx}.completed`,
				seq: endSeq,
				payload: {
					name,
					result: truncatePayload(
						projected.modelResult,
						this.ledgerPayloadMaxChars,
					),
					...(projected.retainedResult
						? { retainedResult: projected.retainedResult }
						: {}),
					...(projected.retentionError
						? { retentionError: projected.retentionError }
						: {}),
					...(resultIdentity ? { resultIdentity } : {}),
					...(outcome.resultProjection
						? { resultProjection: outcome.resultProjection }
						: {}),
					// Beside the result, never inside it: the result is the model's
					// projection and a receipt folded into it would be forgeable by
					// the same program whose execution it is supposed to attest.
					...(outcome.completionEvidence
						? { completionEvidence: outcome.completionEvidence }
						: {}),
					...(outcome.readObservations?.length
						? { readObservations: outcome.readObservations }
						: {}),
					...(outcome.collectionReads?.length
						? { collectionReads: outcome.collectionReads }
						: {}),
					latencyMs,
					// Phase split of the window `latencyMs` measures. Content-free.
					timing: { startEventMs, prepareMs, executeMs },
				},
			});
			return projected.modelResult;
		} catch (err) {
			const latencyMs = Date.now() - startedAt;
			if (executedAt !== null) executeMs = Date.now() - executedAt;
			const error = err instanceof Error ? err.message : String(err);
			const readObservations = readObservationsFromError(err);
			const collectionReads = collectionReadsFromError(err);
			this.toolCallLog.push({ name, args, ok: false, error });
			await this.emitToolEvent({
				binding,
				kind: "tool.failed",
				idSuffix: `tool.${callIdx}.failed`,
				seq: endSeq,
				payload: {
					name,
					error,
					...(readObservations.length > 0 ? { readObservations } : {}),
					...(collectionReads.length > 0 ? { collectionReads } : {}),
					latencyMs,
					timing: { startEventMs, prepareMs, executeMs },
				},
			});
			throw err;
		}
	}

	private async emitToolEvent(opts: {
		binding: TedixMcpRuntimeBinding | null;
		kind: "tool.started" | "tool.completed" | "tool.failed";
		idSuffix: string;
		seq: number;
		payload: Record<string, unknown>;
	}): Promise<void> {
		const binding = opts.binding;
		if (!binding || !this.options.platform.recordToolEvent) return;
		try {
			await this.options.platform.recordToolEvent({
				kind: opts.kind,
				sequence: opts.seq,
				idSuffix: opts.idSuffix,
				conversationId: binding.conversationId,
				runId: binding.runId,
				payload: opts.payload,
			});
		} catch (err) {
			this.logger.warn(
				`[mcp-client-core] recordEvent ${opts.kind} failed (run=${binding.runId} seq=${opts.seq}):`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	private async syncAssignedServers(): Promise<void> {
		const servers = await this.options.platform.listServers();
		const results = await Promise.allSettled(
			servers.map((server) => this.connectServer(server)),
		);
		const rejected = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		for (const failure of rejected) {
			this.logger.warn(
				"[mcp-client-core] server connect failed during sync:",
				failure.reason instanceof Error
					? failure.reason.message
					: failure.reason,
			);
		}
		// Total failure: every assigned server rejected. Surface the first reason
		// so callers (ensureSynced) can decide between rethrow and last-known-good.
		const firstRejection = rejected[0];
		if (
			servers.length > 0 &&
			firstRejection &&
			rejected.length === results.length
		) {
			this.lastSyncFailureAt = Date.now();
			this.lastSyncFailureMessage =
				firstRejection.reason instanceof Error
					? firstRejection.reason.message
					: String(firstRejection.reason);
			throw firstRejection.reason;
		}
		// Partial success is success — tools from connected servers beat zero
		// tools. Clear the failure marker and advance the freshness timestamp.
		this.lastSyncFailureAt = 0;
		this.lastSyncFailureMessage = null;
		this.lastSyncAt = Date.now();
	}

	private async connectServer(
		server: AssignedMcpServer,
		timeoutMs = this.connectTimeoutMs,
	): Promise<McpConnection> {
		const config = {
			url: server.url,
			transport: "streamable-http" as const,
			headers: {},
			headerFactory: () => this.resolveConnectionHeaders(server.url),
			onCredentialInvalidate: (serverUrl: string) => {
				this.credentials.delete(serverUrl);
			},
		};
		const doConnect = async (): Promise<McpConnection> => {
			if (this.options.preferStatelessConnections) {
				try {
					return await this.manager.connectStatelessSnapshot(
						server.serverId,
						config,
					);
				} catch (snapshotErr) {
					this.logger.warn(
						`[mcp-client-core] stateless snapshot failed for ${server.serverId}; retrying once:`,
						snapshotErr instanceof Error ? snapshotErr.message : snapshotErr,
					);
					await new Promise((resolve) =>
						setTimeout(resolve, this.connectRetryDelayMs),
					);
					return await this.manager.connectStatelessSnapshot(
						server.serverId,
						config,
					);
				}
			}
			return this.manager.connect(server.serverId, config, {
				signal: AbortSignal.timeout(timeoutMs),
			});
		};
		return withTimeout(
			doConnect(),
			timeoutMs,
			`MCP connect ${server.serverId}`,
		);
	}

	private async resolveConnectionHeaders(
		serverUrl: string,
		options: { forceRefresh?: boolean } = {},
	): Promise<Record<string, string>> {
		const cached = this.credentials.get(serverUrl);
		if (!options.forceRefresh && cached && cached.cacheExpiresAt > Date.now()) {
			return cached.headers;
		}

		const resolved = await this.options.platform.resolveCredentials(serverUrl);
		const headers = resolved.headers ?? {};
		if (resolved.connectionRequired) {
			throw new Error(
				`Connection required for ${serverUrl}: ${resolved.connectionRequired.providerName}`,
			);
		}
		if (Object.keys(headers).length === 0) {
			throw new Error(
				`resolveCredentials returned empty headers for ${serverUrl}`,
			);
		}

		const expiresAtMs =
			typeof resolved.expiresAt === "number"
				? Math.max(
						Date.now() + 1_000,
						resolved.expiresAt * 1000 - this.credentialRefreshSkewMs,
					)
				: Date.now() + this.credentialCacheTtlMs;
		this.credentials.set(serverUrl, {
			...resolved,
			headers,
			cacheExpiresAt: expiresAtMs,
		});
		return headers;
	}

	private selectCodeServer(): string {
		const connections = this.manager.listConnections();
		if (connections.length === 0) {
			throw new Error("No assigned MCP servers connected");
		}
		const unified = connections
			.filter(
				(conn) =>
					conn.serverId.toLowerCase().endsWith("-unified") &&
					this.hasCodeTool(conn.serverId),
			)
			.sort(
				(left, right) =>
					reviewServerRank(left.serverId) - reviewServerRank(right.serverId),
			)[0];
		if (unified) {
			return unified.serverId;
		}
		const tedix = connections.find((conn) => {
			const id = conn.serverId.toLowerCase();
			return id === "tedix" && this.hasCodeTool(conn.serverId);
		});
		if (tedix) {
			return tedix.serverId;
		}
		const withCode = connections.find((conn) =>
			this.hasCodeTool(conn.serverId),
		);
		if (!withCode) {
			// Embed per-connection tool diagnostics in the error (the runtime
			// ledger captures tool.failed payloads, but prod log sampling drops
			// internal console logs). `[tools=0]` => connection has no tools;
			// `[tools=N:get_order_details,...]` with no `code` => served RAW tools
			// (Code Mode not applied on this connection/refresh).
			const diag = connections
				.map((c) => {
					const names = this.manager.listTools(c.serverId).map((t) => t.name);
					const sample = names.slice(0, 4).join(",");
					return `${c.serverId}[tools=${names.length}${sample ? `:${sample}` : ""}]`;
				})
				.join("; ");
			throw new Error(
				`No connected MCP server exposes Code Mode. Connected: ${diag}`,
			);
		}
		return withCode.serverId;
	}

	private hasCodeTool(serverId: string): boolean {
		return this.manager
			.listTools(serverId)
			.some((tool) => tool.name === "code");
	}

	private async callCode(
		code: string,
		signal?: AbortSignal,
		embeddedSessionToken?: string,
		resolver?: McpElicitationResolver,
	): Promise<ToolExecutionOutcome> {
		const serverId = this.selectCodeServer();
		return this.callCodeOnServer(
			serverId,
			code,
			signal,
			embeddedSessionToken,
			resolver,
		);
	}

	private async callCodeOnServer(
		serverId: string,
		code: string,
		signal?: AbortSignal,
		embeddedSessionToken?: string,
		resolver?: McpElicitationResolver,
	): Promise<ToolExecutionOutcome> {
		let readObservations: OwnedReadObservation[] = [];
		let collectionReads: OwnedConnectedCollectionRead[] = [];
		try {
			const result = await this.manager.callTool(
				serverId,
				"code",
				{ code },
				// Turn-abort cost protection: the manager threads this into its
				// tasks/get polling loop and fires a best-effort tasks/cancel so the
				// upstream stops executing when the turn is aborted.
				{ signal, embeddedSessionToken, onTaskInputRequired: resolver ?? null },
			);
			readObservations = parseOwnedReadObservations(
				(result as { _meta?: Record<string, unknown> })._meta?.[
					READ_OBSERVATIONS_META_KEY
				],
			);
			collectionReads = parseOwnedConnectedCollectionReads(
				(result as { _meta?: Record<string, unknown> })._meta?.[
					READ_COLLECTIONS_META_KEY
				],
			);
			const normalized = unwrapCallToolResult(result, "code");
			this.toolCallLog.push({
				name: "code",
				args: { code: truncate(code, 1000) },
				ok: true,
				serverId,
			});
			const resultIdentity = codeResultIdentity(normalized);
			const resultProjection = codeResultProjection(normalized);
			const completionEvidence = codeResultCompletionEvidence(normalized);
			return {
				result: stripCodeModeExecutionEnvelope(normalized),
				...(resultIdentity ? { resultIdentity } : {}),
				...(resultProjection ? { resultProjection } : {}),
				...(completionEvidence ? { completionEvidence } : {}),
				...(readObservations.length > 0 ? { readObservations } : {}),
				...(collectionReads.length > 0 ? { collectionReads } : {}),
			};
		} catch (error) {
			const guidedError = codeModeErrorWithGuidance(error);
			this.toolCallLog.push({
				name: "code",
				args: { code: truncate(code, 1000) },
				ok: false,
				serverId,
				error: guidedError.message,
			});
			throw attachReadObservationsToError(
				guidedError,
				readObservations,
				collectionReads,
			);
		}
	}

	private async executeToolInner(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		preferredCodeServerId?: string | null,
		embeddedSessionToken?: string,
		resolver?: McpElicitationResolver,
	): Promise<ToolExecutionOutcome> {
		switch (name) {
			case "tedix_mcp_code":
				return await this.executeCode(
					args,
					signal,
					preferredCodeServerId,
					resolver,
				);
			case "tedix_mcp_list_namespaces":
				return await this.listNamespaces(args, signal, resolver);
			case "tedix_mcp_search_tools":
				return await this.searchTools(args, signal, resolver);
			case "tedix_mcp_call_tool":
				return await this.callUnifiedTool(
					args,
					signal,
					embeddedSessionToken,
					resolver,
				);
			case "mcp_read_resource":
				return { result: await this.readResourceTool(args) };
			case "mcp_get_skill":
				return { result: await this.getSkillTool(args) };
			case "mcp_directory_read":
				return { result: await this.readDirectoryTool(args) };
			case "mcp_complete_argument":
				return { result: await this.completeArgumentTool(args) };
			default:
				throw new Error(`Unknown Tedix MCP function: ${name}`);
		}
	}

	private async readResourceTool(
		args: Record<string, unknown>,
	): Promise<unknown> {
		const server = String(args.server ?? "").trim();
		const uri = String(args.uri ?? "").trim();
		if (!server) throw new Error("server is required");
		if (!uri) throw new Error("uri is required");
		const result = await this.manager.readResource(server, uri);
		this.toolCallLog.push({
			name: "mcp_read_resource",
			args: { server, uri },
			ok: true,
			serverId: server,
		});
		return result;
	}

	private async getSkillTool(args: Record<string, unknown>): Promise<unknown> {
		const server = String(args.server ?? "").trim();
		const uri = typeof args.uri === "string" ? args.uri : "";
		if (!server) throw new Error("server is required");
		if (!uri) throw new Error("uri is required");
		const result = await this.manager.getSkill(server, uri);
		this.toolCallLog.push({
			name: "mcp_get_skill",
			args: { server, uri },
			ok: true,
			serverId: server,
		});
		return result;
	}

	private async readDirectoryTool(
		args: Record<string, unknown>,
	): Promise<unknown> {
		const server = String(args.server ?? "").trim();
		const uri = String(args.uri ?? "").trim();
		const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
		if (!server) throw new Error("server is required");
		if (!uri) throw new Error("uri is required");
		const result = await this.manager.readDirectory(server, uri, cursor);
		this.toolCallLog.push({
			name: "mcp_directory_read",
			args: { server, uri, ...(cursor === undefined ? {} : { cursor }) },
			ok: true,
			serverId: server,
		});
		return result;
	}

	/**
	 * 2026-07-28 `completion/complete` exposed to the MODEL as a deliberate
	 * resolution step (backs the `mcp_complete_argument` tool). The model calls
	 * this to list candidate values for a reference argument (`session_key`,
	 * `conversationId`, artifact `path`, …) before invoking the tool that needs
	 * it — the runtime never rewrites call arguments behind the model's back.
	 *
	 * Servers that don't advertise `completions` short-circuit to a structured
	 * `{ supported: false, values: [] }` no-op without a round-trip; zero
	 * candidates is likewise a non-error empty result.
	 */
	private async completeArgumentTool(
		args: Record<string, unknown>,
	): Promise<unknown> {
		const server = String(args.server ?? "").trim();
		const argumentName = String(args.argument ?? "").trim();
		if (!server) throw new Error("server is required");
		if (!argumentName) throw new Error("argument is required");
		if (!this.manager.serverSupportsCompletions(server)) {
			return {
				supported: false,
				values: [],
				note: `server "${server}" does not advertise the completions capability`,
			};
		}
		const partial = typeof args.partial === "string" ? args.partial : "";
		const resourceUri =
			typeof args.resourceUri === "string" && args.resourceUri.trim()
				? args.resourceUri.trim()
				: undefined;
		const promptName =
			typeof args.prompt === "string" && args.prompt.trim()
				? args.prompt.trim()
				: undefined;
		const ref: McpCompletionRef = resourceUri
			? { type: "ref/resource", uri: resourceUri }
			: { type: "ref/prompt", name: promptName ?? "tool_arguments" };
		const contextArgs =
			args.context &&
			typeof args.context === "object" &&
			!Array.isArray(args.context)
				? Object.fromEntries(
						Object.entries(args.context as Record<string, unknown>).filter(
							(entry): entry is [string, string] =>
								typeof entry[1] === "string",
						),
					)
				: undefined;
		const result = await this.manager.complete(
			server,
			ref,
			{ name: argumentName, value: partial },
			contextArgs && Object.keys(contextArgs).length > 0
				? { arguments: contextArgs }
				: undefined,
		);
		this.toolCallLog.push({
			name: "mcp_complete_argument",
			args: {
				server,
				argument: argumentName,
				...(partial ? { partial } : {}),
			},
			ok: true,
			serverId: server,
		});
		return {
			supported: true,
			values: result.values,
			...(result.total === undefined ? {} : { total: result.total }),
			...(result.hasMore === undefined ? {} : { hasMore: result.hasMore }),
		};
	}

	private async executeCode(
		args: Record<string, unknown>,
		signal?: AbortSignal,
		preferredCodeServerId?: string | null,
		resolver?: McpElicitationResolver,
	): Promise<ToolExecutionOutcome> {
		const code = String(args.code ?? "").trim();
		if (!code) throw new Error("code is required");
		return preferredCodeServerId
			? await this.callCodeOnServer(
					preferredCodeServerId,
					code,
					signal,
					undefined,
					resolver,
				)
			: await this.callCode(code, signal, undefined, resolver);
	}

	private async listNamespaces(
		args: Record<string, unknown>,
		signal?: AbortSignal,
		resolver?: McpElicitationResolver,
	): Promise<ToolExecutionOutcome> {
		const includeTools = Boolean(args.includeTools);
		return await this.callCode(
			`async () => await discover.list_namespaces(${jsonArg({ includeTools })})`,
			signal,
			undefined,
			resolver,
		);
	}

	private async searchTools(
		args: Record<string, unknown>,
		signal?: AbortSignal,
		resolver?: McpElicitationResolver,
	): Promise<ToolExecutionOutcome> {
		const query = String(args.query ?? "").trim();
		if (!query) throw new Error("query is required");
		const limit =
			typeof args.limit === "number" && Number.isFinite(args.limit)
				? Math.max(1, Math.min(25, Math.floor(args.limit)))
				: 10;
		const includeParameters = Boolean(args.includeParameters);
		return await this.callCode(
			`async () => await discover.search(${jsonArg({
				query,
				limit,
				includeParameters,
			})})`,
			signal,
			undefined,
			resolver,
		);
	}

	private async callUnifiedTool(
		args: Record<string, unknown>,
		signal?: AbortSignal,
		embeddedSessionToken?: string,
		resolver?: McpElicitationResolver,
	): Promise<ToolExecutionOutcome> {
		const callable = String(args.callable ?? "").trim();
		const match = callable.match(CALLABLE_RE);
		if (!match) {
			throw new Error(
				"callable must be a simple namespace.tool identifier, for example cms_tedix.search",
			);
		}
		const toolArgs =
			args.args && typeof args.args === "object" && !Array.isArray(args.args)
				? (args.args as Record<string, unknown>)
				: {};
		const [, namespace, tool] = match;
		return await this.callCode(
			`async () => await ${namespace}.${tool}(${jsonArg(toolArgs)})`,
			signal,
			embeddedSessionToken,
			resolver,
		);
	}
}
