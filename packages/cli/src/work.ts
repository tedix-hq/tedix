/**
 * `tedix work` — board verbs for external coding agents (Codex, Claude Code).
 *
 * The #1 adoption lever: agents will not hand-write `tedix code '<js>'` gateway
 * snippets against the work_items board. These verbs expose the canonical
 * attempt and evidence lifecycle while wrapping the org's board MCP tools
 * behind clean verbs with human-readable output (and `--json` for machines).
 *
 * Transport: native calls use the selected gateway credential. Authenticated
 * bootstrap and configured catalog descriptors determine the exact wire names;
 * absent, denied or stale routes fail closed.
 *
 * Acting identity: writes are always bound to the authenticated credential.
 * `--as <tediSlug>` is a read-only namespace selector; it never grants that
 * tedi's authority. Mutation verbs therefore reject `--as` and use the native
 * work namespace, where the gateway/API derive the actor from authentication.
 *
 * Board errors: oRPC contract errors (CONFLICT, NOT_FOUND, BAD_REQUEST, …) cross
 * native transport as a structured value `{ defined, code, status, message }`
 * (not a thrown exception), so `boardErrorFromValue` inspects the normalized
 * value. Claim conflicts and rejected transitions exit non-zero so agents and
 * scripts can branch.
 */

import {
	WorkItemDispositionSchema,
	ListWorkCliProjectionInputSchema,
	ListWorkCliProjectionResultSchema,
	WorkCheckpointProjectionInputSchema,
	WorkCheckpointProjectionSchema,
	WorkCliLedgerInputSchema,
	WorkCliEventInputSchema,
	ListWorkAttemptCliProjectionResultSchema,
	ListWorkEvidenceCliProjectionResultSchema,
	ListWorkEventCliProjectionResultSchema,
} from "@tedix/api-contract/schemas/work-items";
import {
	WorkInteractionCursorSchema,
	ListWorkInteractionCliInboxInputSchema,
	ListWorkInteractionCliInboxResultSchema,
} from "@tedix/api-contract/schemas/work-interactions";
import {
	TriageAgentTurnInputSchema,
	TriageResultSchema,
	LabelAgentReplyInputSchema,
	LabelAgentReplyResultSchema,
	RequestAgentReplyDraftInputSchema,
	RequestAgentReplyDraftResultSchema,
} from "@tedix/api-contract/schemas/agent-turn-triage";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveAgentContext, type AgentContextResult } from "./agent-context";
import { claimFiles, fileResourceKeys } from "./work-claim-files";
import { setTimeout as sleep } from "node:timers/promises";
import {
	McpNativeBootstrapSchema,
	McpNativeDescriptorSchema,
} from "@tedix/api-contract/schemas/mcp-native-transport";
import * as z from "zod";
import { resolveCommitFlag } from "./local-context";
import { cyan, dim, errorText, green, red, yellow } from "./format";
import type { ColorMode } from "./terminal";
import {
	type TedixHomeClient,
	isRateLimitError,
	rateLimitRetryAfterMs,
} from "./home-client";
import type { WorkAttemptKey, WorkAttemptStore } from "./work-attempt-store";
import {
	provisionAttemptWorktree,
	type WorktreeRequest,
} from "./worktree-adapter";
import { isRecord } from "@tedix/api-contract/utils/is-record";

// Any non-zero exit signals "the board operation did not succeed" — matching the
// CLI's failed/canceled → 2 convention so automation can branch on it.
export const WORK_EXIT_FAIL = 2;

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keep default board output bounded; native projections enforce per-page limits.
const DEFAULT_LIST_LIMIT = 20;

export interface WorkOptions {
	/** `claim-files`: stable repository namespace and repeatable literal paths. */
	repoKey?: string;
	paths?: string[];
	/** `heartbeat`: renew the original Attempt for a bounded number of seconds. */
	watch?: number;
	/** Structured factory procedure input: inline JSON or @path. */
	input?: string;
	as?: string;
	project?: string;
	disposition?: string;
	mine?: boolean;
	reason?: string;
	note?: string;
	event?: string;
	campaign?: string;
	contentIds?: string;
	validUntil?: string;
	limit?: number;
	/** `create`: --desc description body. */
	desc?: string;
	/** `create`: adapter-neutral work kind. */
	kind?: string;
	/** `create`: --priority critical|high|medium|low. */
	priority?: string;
	/** `create`: --objective <objectiveId> — the normal purpose path. */
	objective?: string;
	/** `create`: --class maintenance|incident|hygiene — time-bounded exception. */
	workClass?: string;
	/** `create`: --expires <duration|iso> paired with --class (72h, 7d, ISO). */
	expires?: string;
	/** `clusters`: explicit active tedi executor selected by an operator. */
	executorTedi?: string;
	/** `accept`: plain-language done-looks-like, written into the contract. */
	doneWhen?: string;
	/** `settle`: succeeded|failed|cancelled|expired. */
	outcome?: string;
	/** `settle`: repeatable `--commit <sha>`; each is resolved locally. */
	commit?: string[];
	/** `submit-evidence`: acceptance claim key. */
	claimKey?: string;
	/** `submit-evidence`: typed adapter key. */
	evidenceKind?: string;
	/** `submit-evidence`: optional media type. */
	evidenceMediaType?: string;
	/** `submit-evidence`: optional human-readable label. */
	evidenceLabel?: string;
	/** `submit-evidence`: inline JSON or @path metadata object. */
	evidenceMetadata?: string;
	/** Agent SESSION id (`--session`); traces a board write to one harness run. */
	session?: string;
	/** `handoff`: local coding host receiving one Work Item. */
	host?: string;
	/** `handoff`: launch the host after reading the accepted item. */
	launch?: boolean;
	/**
	 * `--contradicts`: this principal asserts the settled claim is FALSE, rather
	 * than independently reproducing it. The ledger began as duplicate
	 * suppression and could only agree; contradiction is what lets it carry the
	 * after-the-fact correction AGENTS.md delegates to it.
	 */
	contradicts?: boolean;
	/** Evidence ref (`--evidence`) attached to a `confirm` corroboration. */
	evidence?: string;
	/** Stable key for retry-safe mutations that require one. */
	idempotencyKey?: string;
	/** Explicit human/operator bypass when a coding harness is using OAuth. */
	operatorOverride?: boolean;
	/** `start`: provision an isolated Git worktree after admission. */
	worktree?: boolean;
	/** Optional parent directory for the provisioned worktree. */
	worktreeRoot?: string;
}

export interface WorkContext {
	/** Effective authenticated gateway/tenant, supplied by CLI routing. */
	mcpUrl?: string;
	organizationId?: string;
	/** Local resolver injection for checkpoint isolation tests. */
	resolveContext?: () => AgentContextResult;
	/** Clock injection for deterministic heartbeat-loop tests. */
	heartbeatClock?: { now: () => number; wait: (ms: number) => Promise<void> };
	client: Pick<
		TedixHomeClient,
		"callTool" | "callToolWithDestructiveApproval" | "getTimeoutMs"
	>;
	/** Optional cancellation from the invoking host. */
	signal?: AbortSignal;
	color: ColorMode;
	json: boolean;
	workspace: string;
	/** Resolved credential source (`stored-login:*`, `external-agent:*`, ...). */
	authSource?: string;
	attemptStore: WorkAttemptStore;
	provisionWorktree?: (request: WorktreeRequest) => {
		path: string;
		branch: string;
		reused: boolean;
	};
	launchHost?: (
		host: "codex" | "claude",
		args: string[],
		env: NodeJS.ProcessEnv,
	) => number;
	work: WorkOptions;
}

interface BoardError {
	/** Server-provided retry delay, in seconds. */
	retryAfter?: number;
	code?: string;
	status?: number;
	message: string;
}

interface BoardResult {
	value: unknown;
	error?: BoardError;
}

function isUuid(value: string): boolean {
	return UUID_RE.test(value.trim());
}

/** Aggregate native catalog namespaces sanitize slug → `[^a-zA-Z0-9_]` = `_`. */
function tediNamespace(slug: string): string {
	return slug.trim().replace(/[^a-zA-Z0-9_]/g, "_");
}

function identityBoundCallable(
	as: string | undefined,
	nativeCallable: string,
	tediTool: string,
): string {
	if (!as) return nativeCallable;
	if (isUuid(as)) {
		throw new Error("--as requires a hydrated tedi slug, not a UUID");
	}
	return `${tediNamespace(as)}.${tediTool}`;
}

function mutationCallable(
	as: string | undefined,
	nativeCallable: string,
): string {
	if (as?.trim()) {
		throw new Error(
			"--as selects a read-only tedi namespace and cannot authorize work mutations; authenticate as that tedi or use an explicit delegated credential",
		);
	}
	return nativeCallable;
}

function workAttemptKey(
	ctx: WorkContext,
	workItemId: string,
	serverAgentSession?: string,
): WorkAttemptKey {
	const agentSession =
		serverAgentSession?.trim() ||
		resolveAgentSession(ctx.work.session)?.session;
	return {
		workspace: ctx.workspace,
		actor: ctx.work.as?.trim() || "credential",
		agentSession: agentSession ?? "unidentified-session",
		workItemId,
	};
}

function cachedAttemptId(ctx: WorkContext, workItemId: string): string | null {
	return ctx.attemptStore.get(workAttemptKey(ctx, workItemId));
}

function missingAttemptResult(workItemId: string): BoardResult {
	return {
		value: undefined,
		error: {
			code: "STALE_ATTEMPT",
			status: 409,
			message: `No active attempt is cached for ${workItemId}. Start an attempt in this workspace before heartbeating, settling, or submitting evidence.`,
		},
	};
}

function envTrim(name: string): string | undefined {
	const v = process.env[name];
	return v?.trim() ? v.trim() : undefined;
}

interface AgentSession {
	/** `<harness>:<id>` — the traceable session key stored on board writes. */
	session: string;
	/** Harness family: claude-code, codex, cursor, or cli. */
	harness: string;
	/** True when the id is a best-effort shell fallback, not a durable session id. */
	derived: boolean;
}

const KNOWN_AGENT_HARNESSES = new Set([
	"claude-code",
	"codex",
	"cursor",
	"cli",
]);

/** Shape-only pre-push boundary; the server certifies the opaque exact value. */
export const GATE_SESSION_KEY =
	/^(?=.{3,300}$)[a-z0-9-]+:[^\t\r\n:][^\t\r\n]*$/i;

function harnessFromSessionPrefix(session: string): string | undefined {
	const separator = session.indexOf(":");
	if (separator <= 0) return undefined;
	const prefix = session.slice(0, separator);
	return KNOWN_AGENT_HARNESSES.has(prefix) ? prefix : undefined;
}

/**
 * Resolve the calling agent SESSION identity so every board write traces to one
 * of the parallel harness runs, not merely to a role+model. This is the fix for
 * the session-identity blind spot: the board previously captured *who* (tedi
 * role) and the commit captured *what model*, but not *which of the ~10 live
 * Codex/Claude sessions* did the work. Resolution order:
 *   1. `--session <id>`            explicit flag (wins)
 *   2. `TEDIX_AGENT_SESSION`       documented per-session env override (any harness)
 *   3. harness-native session env  CLAUDE_CODE_SESSION_ID / CODEX_* / CURSOR_*
 *   4. best-effort shell fallback  harness=cli, id from PPID — flagged `derived`
 *      so a consumer never mistakes an auto-grouped shell id for a durable one.
 */
export function resolveAgentSession(
	explicit?: string,
): AgentSession | undefined {
	const claudeSession = envTrim("CLAUDE_CODE_SESSION_ID");
	const codexSession =
		envTrim("CODEX_SESSION_ID") ?? envTrim("CODEX_THREAD_ID");
	const cursorSession = envTrim("CURSOR_TRACE_ID");
	const harness =
		claudeSession || envTrim("CLAUDECODE")
			? "claude-code"
			: codexSession || envTrim("CODEX_SANDBOX") || envTrim("CODEX_HOME")
				? "codex"
				: cursorSession || envTrim("CURSOR_AGENT")
					? "cursor"
					: "cli";

	const explicitId = explicit?.trim();
	if (explicitId) {
		const session = explicitId.includes(":")
			? explicitId
			: `${harness}:${explicitId}`;
		return {
			session,
			harness: harnessFromSessionPrefix(session) ?? harness,
			derived: false,
		};
	}

	const environmentId = envTrim("TEDIX_AGENT_SESSION");
	if (environmentId) {
		const session = environmentId.includes(":")
			? environmentId
			: `${harness}:${environmentId}`;
		return {
			session,
			harness: harnessFromSessionPrefix(session) ?? harness,
			derived: false,
		};
	}

	const native = claudeSession ?? codexSession ?? cursorSession;
	if (native)
		return { session: `${harness}:${native}`, harness, derived: false };

	const ppid = typeof process.ppid === "number" ? process.ppid : 0;
	if (ppid) return { session: `${harness}:sh${ppid}`, harness, derived: true };
	return undefined;
}

/**
 * The `metadata` object to stamp onto a board write so the session is queryable.
 * Undefined only when no session can be derived at all (then writes stay clean).
 */
function sessionMetadata(
	ctx: WorkContext,
): Record<string, unknown> | undefined {
	const s = resolveAgentSession(ctx.work.session);
	if (!s) return undefined;
	return {
		agentSession: s.session,
		agentHarness: s.harness,
		...(s.derived ? { agentSessionDerived: true } : {}),
	};
}

function isDetectedExternalHarness(session: AgentSession | undefined): boolean {
	return Boolean(session && session.harness !== "cli");
}

function oauthHarnessGuard(ctx: WorkContext): BoardError | undefined {
	const session = resolveAgentSession(ctx.work.session);
	if (
		ctx.authSource?.startsWith("stored-login:") &&
		isDetectedExternalHarness(session) &&
		!ctx.work.operatorOverride
	) {
		return {
			code: "EXTERNAL_AGENT_IDENTITY_REQUIRED",
			status: 409,
			message:
				"A coding harness cannot exercise owner-only Work Item authority with the owner's OAuth identity. Run `tedix agent start`, export TEDIX_EXTERNAL_AGENT, and start the attempt with that verified credential. An operator may deliberately bypass this boundary with --operator-override; the override is written to the Work Item thread.",
		};
	}
	return undefined;
}

/** Merge session provenance into a board-write arg object under `metadata`. */
function withSession(
	ctx: WorkContext,
	args: Record<string, unknown>,
): Record<string, unknown> {
	const meta = sessionMetadata(ctx);
	if (!meta) return args;
	const existing = isRecord(args.metadata) ? args.metadata : undefined;
	return { ...args, metadata: { ...existing, ...meta } };
}

/**
 * Detect an error envelope returned (not thrown) through native transport.
 *
 * Two distinct shapes reach here and BOTH must be caught, because a board list
 * that misses one renders it as an empty board — the caller then concludes there
 * is no work when the truth is "your arguments were rejected":
 *
 * 1. The oRPC contract error: a top-level string `code` plus (`defined` or a
 *    4xx/5xx `status`). A successful board payload never carries a string `code`.
 * 2. The MCP gateway's own rejection envelope, `{ ok: false, error: "<text>" }`,
 *    which is what an input-validation failure actually looks like. It carries no
 *    `code`, no `status` and no `defined`, so shape 1 cannot see it; without
 *    this, an over-limit `--limit` or an unknown project prints "No work items."
 */
export function boardErrorFromValue(value: unknown): BoardError | undefined {
	if (!isRecord(value)) return undefined;
	const retryAfter =
		typeof value.retryAfter === "number" &&
		Number.isFinite(value.retryAfter) &&
		value.retryAfter >= 0
			? value.retryAfter
			: undefined;
	if (value.ok === false) {
		const text =
			typeof value.error === "string"
				? value.error
				: typeof value.message === "string"
					? value.message
					: undefined;
		return {
			...(retryAfter !== undefined ? { retryAfter } : {}),
			...(typeof value.status === "number" ? { status: value.status } : {}),
			code: "GATEWAY_REJECTED",
			message: text ?? "gateway rejected the call",
		};
	}
	const code = typeof value.code === "string" ? value.code : undefined;
	const status = typeof value.status === "number" ? value.status : undefined;
	const message = typeof value.message === "string" ? value.message : undefined;
	const isError =
		code !== undefined &&
		(value.defined === true || (status !== undefined && status >= 400));
	if (!isError) return undefined;
	return {
		...(retryAfter !== undefined ? { retryAfter } : {}),
		...(code ? { code } : {}),
		...(status !== undefined ? { status } : {}),
		message: message ?? code ?? "board error",
	};
}

/** A native command owns one deadline and a snapshot of the selected context. */
interface NativeCommand {
	protocolSequence: object;
	deadlineAt: number;
	callDeadlineAt?: number;
	context?: z.infer<typeof McpNativeBootstrapSchema>;
}
const nativeCommands = new WeakMap<WorkContext, NativeCommand>();
const WORK_RESPONSE_BYTES = 4 * 1024 * 1024;
const CLI_PROJECTION_SCHEMAS: Record<
	string,
	{ input: z.ZodType; output: z.ZodType }
> = {
	"agentTurnTriage/triage": {
		input: TriageAgentTurnInputSchema,
		output: TriageResultSchema,
	},
	"agentTurnTriage/labelReply": {
		input: LabelAgentReplyInputSchema,
		output: LabelAgentReplyResultSchema,
	},
	"agentTurnTriage/requestReplyDraft": {
		input: RequestAgentReplyDraftInputSchema,
		output: RequestAgentReplyDraftResultSchema,
	},
	"workItems/listCliProjection": {
		input: ListWorkCliProjectionInputSchema,
		output: ListWorkCliProjectionResultSchema,
	},
	"workItems/getCheckpointProjection": {
		input: WorkCheckpointProjectionInputSchema,
		output: WorkCheckpointProjectionSchema,
	},
	"workItems/listAttemptCliProjection": {
		input: WorkCliLedgerInputSchema,
		output: ListWorkAttemptCliProjectionResultSchema,
	},
	"workItems/listEvidenceCliProjection": {
		input: WorkCliLedgerInputSchema,
		output: ListWorkEvidenceCliProjectionResultSchema,
	},
	"workItems/listEventCliProjection": {
		input: WorkCliEventInputSchema,
		output: ListWorkEventCliProjectionResultSchema,
	},
	"workInteractions/listCliInboxProjection": {
		input: ListWorkInteractionCliInboxInputSchema,
		output: ListWorkInteractionCliInboxResultSchema,
	},
};
const WORK_NATIVE_ENDPOINTS: Record<string, string> = {
	triage_agent_turn: "agentTurnTriage/triage",
	label_agent_reply: "agentTurnTriage/labelReply",
	request_agent_reply_draft: "agentTurnTriage/requestReplyDraft",
	report_work_agent_session_status: "workAgentSessions/report",
	list_work_item_cli_rows: "workItems/listCliProjection",
	corroborate_work_items: "workItems/corroborate",
	accept_work_item: "workItems/accept",
	add_comment: "workItems/addComment",
	add_project_milestone_dependency: "projects/addMilestoneDependency",
	add_work_case_dependency: "workItems/addCaseDependency",
	attach_project_milestone_work_item: "projects/attachMilestoneWorkItem",
	attach_work_case_item: "workItems/attachCaseWorkItem",
	authorize_owned_channel: "workItems/authorizeOwnedChannel",
	cancel_work_interaction: "workInteractions/cancel",
	cancel_work_items: "workItems/cancel",
	complete_work_item: "workItems/complete",
	create_project_milestone: "projects/createMilestone",
	create_work_case: "workItems/createCase",
	create_work_interaction: "workInteractions/create",
	create_work_items: "workItems/create",
	decide_work_approval: "workApprovals/decide",
	get_work_admission_specification: "workItems/getAdmissionSpecification",
	get_work_case: "workItems/getCase",
	get_work_fleet_control_tower: "workFleet/getControlTower",
	get_work_interaction: "workInteractions/get",
	get_work_item_checkpoint: "workItems/getCheckpointProjection",
	get_work_item_readiness: "workItems/getReadiness",
	get_work_items_by_id: "workItems/getById",
	heartbeat_work_item_attempt: "workItems/heartbeatAttempt",
	list_project_health_judgments: "projects/listHealthJudgments",
	list_project_milestones: "projects/listMilestones",
	list_ready_work: "workScheduler/listReady",
	list_work_approval_audit: "workApprovals/listAudit",
	list_work_approvals: "workApprovals/listInbox",
	list_work_attempt_cli_rows: "workItems/listAttemptCliProjection",
	list_work_budget_envelopes: "workItems/listBudgetEnvelopes",
	list_work_cases: "workItems/listCases",
	list_work_event_cli_rows: "workItems/listEventCliProjection",
	list_work_evidence_cli_rows: "workItems/listEvidenceCliProjection",
	list_work_interaction_audit: "workInteractions/listAudit",
	list_work_interaction_cli_rows: "workInteractions/listCliInboxProjection",
	list_work_interaction_outbox: "workInteractions/listOutbox",
	list_work_item_attempts: "workItems/listAttempts",
	list_work_item_events: "workItems/listEvents",
	list_work_item_evidence: "workItems/listEvidence",
	list_work_items: "workItems/list",
	list_work_resource_pools: "workItems/listResourcePools",
	plan_work_execution_clusters: "workScheduler/planClusters",
	propose_work_approval: "workApprovals/propose",
	put_work_budget_envelope: "workItems/putBudgetEnvelope",
	put_work_resource_pool: "workItems/putResourcePool",
	record_project_health_judgment: "projects/recordHealthJudgment",
	replace_work_admission_specification:
		"workItems/replaceAdmissionSpecification",
	respond_work_interaction: "workInteractions/respond",
	revoke_owned_channel: "workItems/revokeOwnedChannel",
	settle_work_item_attempt: "workItems/settleAttempt",
	start_work_item_attempt: "workItems/startAttempt",
	submit_work_item_evidence: "workItems/submitEvidence",
	update_project_milestone: "projects/updateMilestone",
	update_work_case: "workItems/updateCase",
};

function nativeOptions(ctx: WorkContext) {
	const state = nativeCommands.get(ctx);
	if (!state) throw new Error("Work native command context is missing");
	ctx.signal?.throwIfAborted();
	if (Date.now() >= (state.callDeadlineAt ?? state.deadlineAt))
		throw new Error("Work native command deadline exceeded");
	return {
		retryable: false,
		protocolSequence: state.protocolSequence,
		deadlineAt: state.callDeadlineAt ?? state.deadlineAt,
		maxResponseBytes: WORK_RESPONSE_BYTES,
		...(ctx.signal ? { signal: ctx.signal } : {}),
	};
}

function usableDescriptor(value: unknown) {
	const descriptor = McpNativeDescriptorSchema.parse(value);
	const freshness = descriptor.schemaFreshness;
	if (
		!descriptor.eligible ||
		!descriptor.authorized ||
		!freshness.source ||
		!freshness.sourceRef ||
		!freshness.sourceHash ||
		!freshness.syncedAt ||
		!Number.isFinite(Date.parse(freshness.syncedAt))
	)
		throw new Error(
			"Work native descriptor is denied, ineligible or has no current schema provenance",
		);
	return descriptor;
}

async function nativeBootstrap(ctx: WorkContext) {
	const state = nativeCommands.get(ctx)!;
	if (state.context) return state.context;
	if (!ctx.mcpUrl)
		throw new Error("Work native transport requires the selected gateway");
	const info = await ctx.client.callTool("get_info", {}, nativeOptions(ctx));
	if (!isRecord(info)) throw new Error("Malformed native gateway bootstrap");
	const bootstrap = McpNativeBootstrapSchema.parse({
		nativeContext: info.nativeContext,
		nativeCatalog: info.nativeCatalog,
	});
	if (
		!bootstrap.nativeContext ||
		bootstrap.nativeCatalog.status !== "usable" ||
		(ctx.organizationId !== undefined &&
			bootstrap.nativeContext.organizationId !== ctx.organizationId)
	)
		throw new Error(
			"Work native gateway organization or catalog mismatch; configure authorized native routes for this credential. No Code Mode fallback is available.",
		);
	if (
		usableDescriptor(bootstrap.nativeCatalog.search).endpoint !==
			"catalog/search" ||
		usableDescriptor(bootstrap.nativeCatalog.describe).endpoint !==
			"catalog/describe"
	)
		throw new Error("Native catalog endpoint mismatch");
	state.context = bootstrap;
	return bootstrap;
}

/** Validate the returned configured JSON schema before retaining or publishing data. */
function validateNativeSchema(schema: unknown, value: unknown): void {
	if (!isRecord(schema)) throw new Error("Native Work schema is absent");
	// Zod's converter rejects unsupported schemas instead of silently ignoring them.
	const validator = z.fromJSONSchema(schema);
	const result = validator.safeParse(value);
	if (!result.success)
		throw new Error(
			`Native Work schema validation failed: ${result.error.message}`,
		);
}

/** Resolve an exact configured callable; the catalog's native name is the wire identity. */
async function boardCall(
	ctx: WorkContext,
	callable: string,
	args: Record<string, unknown>,
	destructiveApprovalReason?: string,
): Promise<BoardResult> {
	const input = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
	const state = nativeCommands.get(ctx)!;
	state.callDeadlineAt = Math.min(
		state.deadlineAt,
		Date.now() + ctx.client.getTimeoutMs(),
	);
	try {
		const expectedEndpoint =
			WORK_NATIVE_ENDPOINTS[callable.slice(callable.indexOf(".") + 1)];
		if (!expectedEndpoint) throw new Error("Unknown typed Work endpoint");
		const projectionSchema = CLI_PROJECTION_SCHEMAS[expectedEndpoint];
		projectionSchema?.input.parse(input);
		const bootstrap = await nativeBootstrap(ctx);
		const search = usableDescriptor(bootstrap.nativeCatalog.search);
		const describe = usableDescriptor(bootstrap.nativeCatalog.describe);
		const dot = callable.indexOf(".");
		const result = await ctx.client.callTool(
			search.name,
			{
				query: callable.slice(dot + 1),
				namespace: callable.slice(0, dot),
				limit: 100,
			},
			nativeOptions(ctx),
		);
		if (!isRecord(result) || !Array.isArray(result.results))
			throw new Error("Malformed native Work catalog search");
		const matches = result.results.filter(
			(row: unknown) => isRecord(row) && row.callable === callable,
		);
		if (matches.length !== 1)
			throw new Error(
				`Native Work callable ${callable} is absent or ambiguous`,
			);
		const row = matches[0];
		if (!isRecord(row) || row.aliasOf || row.authorized !== true)
			throw new Error("Native Work callable is an alias or unauthorized");
		const selected = usableDescriptor(row.native);
		if (!expectedEndpoint || selected.endpoint !== expectedEndpoint)
			throw new Error("Native Work endpoint mismatch");
		const detail = await ctx.client.callTool(
			describe.name,
			{ callable },
			nativeOptions(ctx),
		);
		if (
			!isRecord(detail) ||
			detail.callable !== callable ||
			detail.aliasOf ||
			detail.authorized !== true
		)
			throw new Error("Native Work catalog description mismatch");
		const descriptor = usableDescriptor(detail.native);
		if (JSON.stringify(selected) !== JSON.stringify(descriptor))
			throw new Error("Native Work descriptor changed during resolution");
		if (
			!isRecord(detail.schemaFreshness) ||
			detail.schemaFreshness.source !== descriptor.schemaFreshness.source ||
			detail.schemaFreshness.sourceHash !==
				descriptor.schemaFreshness.sourceHash ||
			detail.schemaFreshness.sourceRef !==
				descriptor.schemaFreshness.sourceRef ||
			detail.schemaFreshness.syncedAt !== descriptor.schemaFreshness.syncedAt
		)
			throw new Error("Native Work described schema provenance mismatch");
		if (
			typeof detail.schemaFreshness.toolUpdatedAt === "string" &&
			(!Number.isFinite(Date.parse(detail.schemaFreshness.toolUpdatedAt)) ||
				Date.parse(detail.schemaFreshness.toolUpdatedAt) >
					Date.parse(descriptor.schemaFreshness.syncedAt!))
		)
			throw new Error(
				"Native Work schema is stale relative to the configured tool",
			);
		validateNativeSchema(detail.parameters, input);
		// Prove the output schema is supported before invoking a mutation.
		if (!isRecord(detail.outputSchema))
			throw new Error("Native Work output schema is absent");
		z.fromJSONSchema(detail.outputSchema);
		const value = destructiveApprovalReason
			? await ctx.client.callToolWithDestructiveApproval(
					descriptor.name,
					input,
					destructiveApprovalReason,
					nativeOptions(ctx),
				)
			: await ctx.client.callTool(descriptor.name, input, nativeOptions(ctx));
		if (isRecord(value) && value.__tedix_truncated === true)
			return {
				value: undefined,
				error: {
					code: "RESULT_TRUNCATED",
					message: "Native Work response is incomplete; narrow or paginate",
				},
			};
		const error = boardErrorFromValue(value);
		if (error) return { value, error };
		nativeOptions(ctx);
		validateNativeSchema(detail.outputSchema, value);
		projectionSchema?.output.parse(value);
		return { value };
	} catch (error) {
		return {
			value: undefined,
			error: {
				message: errorText(error),
				...(isRecord(error) &&
				typeof error.retryAfter === "number" &&
				Number.isFinite(error.retryAfter) &&
				error.retryAfter >= 0
					? { retryAfter: error.retryAfter }
					: {}),
				...(isRecord(error) && typeof error.status === "number"
					? { status: error.status }
					: {}),
			},
		};
	}
}

/** Rows per native bounded board page. */
const LIST_PAGE_SIZE = 50;

/** Backstop so a huge `--limit` cannot fan out into unbounded round trips. */
const LIST_MAX_PAGES = 40;

/** Stitch bounded native board pages without publishing partial results. */
async function listBoard(
	ctx: WorkContext,
	callable: string,
	args: Record<string, unknown>,
): Promise<BoardResult> {
	const requested =
		typeof args.limit === "number" && Number.isFinite(args.limit)
			? Math.max(1, Math.trunc(args.limit))
			: LIST_PAGE_SIZE;
	const baseOffset =
		typeof args.offset === "number" && Number.isFinite(args.offset)
			? Math.max(0, Math.trunc(args.offset))
			: 0;

	const rows: unknown[] = [];
	let pagination: unknown;
	for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
		const remaining = requested - rows.length;
		if (remaining <= 0) break;
		// Omit a zero offset: single-page calls stay byte-identical to an
		// unpaged call, so server-side filters (e.g. the idPrefix resolver) are
		// visibly not doing a client-side scan.
		const pageOffset = baseOffset + rows.length;
		const pageArgs = {
			...args,
			limit: Math.min(LIST_PAGE_SIZE, remaining),
			...(pageOffset > 0 ? { offset: pageOffset } : {}),
		};
		const result = await listBoardPage(ctx, callable, pageArgs);
		if (result.error) {
			// Partial pages are not a usable board view; surface the failure.
			return result;
		}
		const value = isRecord(result.value) ? result.value : undefined;
		const pageRows = Array.isArray(value?.data) ? value.data : [];
		rows.push(...pageRows);
		pagination = value?.pagination;
		const hasMore = isRecord(pagination) ? pagination.hasMore === true : false;
		if (pageRows.length < pageArgs.limit || !hasMore) break;
	}

	const total = isRecord(pagination) ? pagination.total : undefined;
	return {
		value: {
			data: rows,
			pagination: {
				limit: requested,
				offset: baseOffset,
				...(typeof total === "number" ? { total } : {}),
				hasMore:
					typeof total === "number" ? baseOffset + rows.length < total : false,
			},
		},
	};
}

/** One gateway round trip for {@link listBoard}. */
async function listBoardPage(
	ctx: WorkContext,
	callable: string,
	args: Record<string, unknown>,
): Promise<BoardResult> {
	const namespace = ctx.work.as
		? tediNamespace(ctx.work.as)
		: callable.slice(0, callable.indexOf("."));
	const view =
		typeof args.idPrefix === "string" || typeof args.titleContains === "string"
			? "resolve"
			: "board";
	const call = await boardCall(ctx, `${namespace}.list_work_item_cli_rows`, {
		...args,
		view,
	});
	if (call.error) return call;
	if (
		!isRecord(call.value) ||
		call.value.view !== view ||
		!Array.isArray(call.value.data) ||
		call.value.data.length > 50 ||
		!isRecord(call.value.pagination) ||
		typeof call.value.pagination.total !== "number" ||
		typeof call.value.pagination.hasMore !== "boolean"
	)
		return {
			value: undefined,
			error: { message: "Malformed native Work board projection" },
		};
	return call;
}

/** List board rows through the canonical work namespace. */
async function listWorkItems(
	ctx: WorkContext,
	args: Record<string, unknown>,
): Promise<BoardResult> {
	return listBoard(ctx, "work.list_work_items", args);
}

/** Read a work item through the canonical work namespace. */
async function getWorkItem(ctx: WorkContext, id: string): Promise<BoardResult> {
	return boardCall(ctx, "work.get_work_items_by_id", { id });
}

/** Work Items reference projects only by canonical UUID. */
function projectArg(project?: string): Record<string, unknown> {
	const value = project?.trim();
	if (!value) return {};
	if (!isUuid(value)) {
		throw new Error("--project requires the canonical project UUID");
	}
	return { projectId: value };
}

async function resolveProjectArg(
	_ctx: WorkContext,
	project?: string,
): Promise<Record<string, unknown>> {
	return projectArg(project);
}

// ─── Output ──────────────────────────────────────────────────────────────────

function fail(ctx: WorkContext, error: BoardError, humanLine: string): number {
	if (ctx.json) {
		console.log(JSON.stringify({ error }));
	} else {
		console.error(humanLine);
	}
	return WORK_EXIT_FAIL;
}

function ok(ctx: WorkContext, value: unknown, render: () => void): number {
	if (ctx.json) console.log(JSON.stringify(value));
	else render();
	return 0;
}

function shortId(id: unknown): string {
	return typeof id === "string" && id.length >= 8 ? id.slice(0, 8) : "—";
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function itemsFromList(value: unknown): Record<string, unknown>[] {
	const rows =
		isRecord(value) && Array.isArray(value.data)
			? value.data
			: Array.isArray(value)
				? value
				: [];
	return rows.filter(isRecord);
}

function dispositionPaint(disposition: string, color: ColorMode): string {
	if (disposition === "completed") return green(disposition, color);
	if (disposition === "cancelled") return red(disposition, color);
	if (disposition === "proposed") return yellow(disposition, color);
	return cyan(disposition, color);
}

/** Pad a possibly-colorized cell to a visible width, ignoring ANSI length. */
function padCell(rawText: string, painted: string, width: number): string {
	const pad = Math.max(0, width - rawText.length);
	return painted + " ".repeat(pad);
}

/** Pad that never truncates — callers shorten deliberately. */
function padEnd(value: string, width: number): string {
	return value.length >= width ? value : value.padEnd(width);
}

/**
 * Who is holding a Work Item right now, in one short cell.
 *
 * An agent session key is the useful identity (`codex:…`, `claude-code:…`) and
 * the harness prefix is the part a reader scans, so the prefix survives and the
 * uuid is clipped. A tedi or an unkeyed executor falls back to its executor id.
 */
export function workItemHolderLabel(active: unknown): string {
	if (!active || typeof active !== "object") return "—";
	const row = active as Record<string, unknown>;
	const session = typeof row.agentSession === "string" ? row.agentSession : "";
	if (session) {
		const [harness, id = ""] = session.split(":");
		return id ? `${harness}:${id.slice(0, 8)}` : truncate(session, 22);
	}
	const executor = typeof row.executorId === "string" ? row.executorId : "";
	return executor ? truncate(executor, 22) : "held";
}

export function renderWorkItemsTable(
	items: Record<string, unknown>[],
	color: ColorMode,
): string {
	if (items.length === 0) return dim("No work items.", color);
	const lines = [
		dim(
			`${"ID".padEnd(8)}  ${"KIND".padEnd(13)}  ${"DISPOSITION".padEnd(11)}  ${"RISK".padEnd(8)}  ${"HOLDER".padEnd(22)}  TITLE`,
			color,
		),
	];
	for (const item of items) {
		const id = shortId(item.id).padEnd(8);
		const kind = String(item.workKind ?? "—").padEnd(13);
		const rawDisposition = String(item.disposition ?? "—");
		const disposition = padCell(
			rawDisposition,
			dispositionPaint(rawDisposition, color),
			11,
		);
		const risk = String(item.riskLevel ?? "—").padEnd(8);
		// PRI was the least useful column here — every row in practice reads
		// "medium" — and "who is holding this right now" is the question a
		// second agent actually arrives with. Priority is still in --json.
		const holder = padEnd(workItemHolderLabel(item.activeAttempt), 22);
		const title = truncate(String(item.title ?? ""), 44);
		lines.push(`${id}  ${kind}  ${disposition}  ${risk}  ${holder}  ${title}`);
	}
	return lines.join("\n");
}

// ─── Id resolution (prefix → full id) ──────────────────────────────────────

/** Shortest id prefix we will attempt to resolve — below this it's too ambiguous. */
const MIN_ID_PREFIX = 6;
/** Soft cap on `find` results so a broad title match stays bounded. */
const FIND_MAX_RESULTS = 30;

/**
 * True when `token` is neither a full UUID nor obvious garbage, but a plausible
 * work-item id PREFIX we should resolve org-wide: ≥6 hex chars, optionally
 * hyphenated, shorter than a full UUID. A non-hex token (e.g. a slug or a typo
 * with letters outside a-f) is passed through untouched so current behavior and
 * the board's own error message are preserved.
 */
function isResolvablePrefix(token: string): boolean {
	const t = token.trim();
	if (t.length < MIN_ID_PREFIX || t.length > 35) return false;
	if (!/^[0-9a-f-]+$/i.test(t)) return false;
	return t.replace(/-/g, "").length >= MIN_ID_PREFIX;
}

/**
 * Resolve a work-item id TOKEN to exactly one full id.
 *   - A full UUID is used as-is (fast path — no network).
 *   - A short hex prefix (≥6 chars) is resolved with ONE server-side-filtered
 *     `work.list_work_items` call (`idPrefix`, limit 2 — two rows are enough to
 *     prove ambiguity):
 *       0 matches  → clear "no work item matches prefix X" error
 *       1 match    → that item's full id
 *       ≥2 matches → "ambiguous prefix X matches N items: <ids+titles>" (never
 *                    guesses which one was meant)
 *   - Any other token (slug/typo) is passed through unchanged so the board's own
 *     validation reports it.
 */
async function resolveWorkItemId(
	ctx: WorkContext,
	token: string,
): Promise<string> {
	const raw = token.trim();
	if (!raw) return token;
	if (isUuid(raw)) return raw;
	if (!isResolvablePrefix(raw)) return token;

	const prefix = raw.toLowerCase();
	const call = await listWorkItems(ctx, {
		idPrefix: prefix,
		limit: 2,
	});
	if (call.error) {
		throw new Error(
			`could not resolve work item prefix ${raw}: ${call.error.message}`,
		);
	}
	const matches = itemsFromList(call.value);
	if (matches.length === 0) {
		throw new Error(`no work item matches prefix ${raw}`);
	}
	if (matches.length > 1) {
		const candidates = matches
			.map((m) => `${String(m.id)} (${String(m.title ?? "").trim()})`)
			.join(", ");
		throw new Error(
			`ambiguous prefix ${raw} matches ${matches.length} items: ${candidates}`,
		);
	}
	return String(matches[0]?.id);
}

/**
 * `find` — discover a full work-item id when you only remember a fragment.
 * A hex-shaped query filters server-side by `idPrefix` (falling back to a
 * title search when no id starts with it); anything else filters server-side
 * by `titleContains` (case-insensitive). Prints the FULL id so it can be
 * copied straight into lifecycle writes.
 */
async function workFind(ctx: WorkContext, query: string): Promise<number> {
	const q = query.trim();
	if (!q) {
		throw new Error(
			"work find requires a <query> (an id prefix or a title substring)",
		);
	}
	const limit = ctx.work.limit ?? FIND_MAX_RESULTS;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new Error("work find --limit requires an integer from 1 to 100");
	const disposition = ctx.work.disposition;
	if (disposition && !WorkItemDispositionSchema.safeParse(disposition).success)
		throw new Error(
			"work find --disposition requires a canonical Work disposition",
		);
	const filters = {
		limit,
		...projectArg(ctx.work.project),
		...(disposition ? { disposition } : {}),
	};
	let call: BoardResult | undefined;
	if (isResolvablePrefix(q)) {
		call = await listWorkItems(ctx, {
			idPrefix: q.toLowerCase(),
			...filters,
		});
		// A hex-looking fragment that matches no id may still live in a title
		// (e.g. a sha pasted into one) — retry as a title search before giving up.
		if (!call.error && itemsFromList(call.value).length === 0) call = undefined;
	}
	if (!call) {
		call = await listWorkItems(ctx, {
			titleContains: q,
			...filters,
		});
	}
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not search work items: ${call.error.message}`,
		);
	}
	const matches = itemsFromList(call.value);
	return ok(ctx, { data: matches }, () => {
		if (matches.length === 0) {
			console.log(dim(`No work item matches "${q}".`, ctx.color));
			return;
		}
		for (const m of matches) {
			const rawDisposition = String(m.disposition ?? "—");
			const disposition = dispositionPaint(rawDisposition, ctx.color);
			console.log(
				`${String(m.id)}  ${disposition}  ${truncate(String(m.title ?? ""), 60)}`,
			);
		}
	});
}

// ─── Verbs ─────────────────────────────────────────────────────────────────

async function workList(ctx: WorkContext, _id: string): Promise<number> {
	const { as, project, disposition, mine, limit } = ctx.work;
	const base: Record<string, unknown> = {
		limit: limit ?? DEFAULT_LIST_LIMIT,
		...(disposition ? { disposition } : {}),
		...projectArg(project),
	};

	let call: BoardResult;
	if (mine) {
		if (!as) {
			throw new Error(
				"work list --mine needs --as <tediSlug> (whose items to show)",
			);
		}
		call = await listBoard(
			ctx,
			identityBoundCallable(as, "work.list_work_items", "work_items_list"),
			{ ...base, mine: true },
		);
	} else {
		call = await listWorkItems(ctx, base);
	}

	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not list work items: ${call.error.message}`,
		);
	}
	const items = itemsFromList(call.value);
	return ok(ctx, call.value, () =>
		console.log(renderWorkItemsTable(items, ctx.color)),
	);
}

/** Purpose-exception classes `create` accepts (objective work uses --objective). */
const CREATE_EXCEPTION_CLASSES = new Set([
	"maintenance",
	"incident",
	"hygiene",
]);
const CREATE_WORK_KINDS = new Set([
	"coding",
	"research",
	"document",
	"design",
	"browser",
	"operations",
	"communication",
	"finance",
	"legal",
	"stewardship",
	"incident",
	"other",
]);
const CREATE_PRIORITIES = new Set(["critical", "high", "medium", "low"]);

/**
 * `--expires` accepts a relative duration (`45m`, `72h`, `7d`, `2w`) or an
 * absolute ISO datetime, normalized to the ISO instant the purpose gate stores.
 */
export function expiresToIso(raw: string, now = Date.now()): string {
	const t = raw.trim();
	const duration = t.match(/^(\d+)\s*([mhdw])$/i);
	if (duration) {
		const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
			duration[2]!.toLowerCase() as "m" | "h" | "d" | "w"
		];
		return new Date(now + Number(duration[1]) * unitMs).toISOString();
	}
	const parsed = Date.parse(t);
	if (!Number.isFinite(parsed)) {
		throw new Error(
			`--expires must be a duration (45m, 72h, 7d) or an ISO datetime, got "${raw}"`,
		);
	}
	return new Date(parsed).toISOString();
}

/**
 * `create` — guided Work Item creation that surfaces the board's purpose gate
 * ergonomically: every item needs either an objective (`--objective <id>`) or a
 * time-bounded operational exception (`--class maintenance|incident|hygiene`
 * plus `--expires`). Both are validated BEFORE any network call so the failure
 * mode is a usage error, not a board rejection.
 */
async function workCreate(ctx: WorkContext, title: string): Promise<number> {
	const t = title.trim();
	if (!t) throw new Error('work create requires a "<title>"');
	const { as, desc, kind, priority, objective, workClass, expires } = ctx.work;

	// The purpose gate, enforced client-side first.
	if (!objective && !workClass) {
		throw new Error(
			"work create requires a purpose: pass --objective <objectiveId> for objective work, " +
				"or --class maintenance|incident|hygiene --expires <duration|iso> for a time-bounded " +
				"operational exception (e.g. --class hygiene --expires 72h). The board rejects purposeless items.",
		);
	}
	if (objective && workClass) {
		throw new Error(
			"pass either --objective (objective work) or --class (operational exception), not both",
		);
	}
	if (objective && !isUuid(objective)) {
		throw new Error("--objective requires an objective UUID");
	}
	let purposeExceptionExpiresAt: string | undefined;
	if (workClass) {
		if (!CREATE_EXCEPTION_CLASSES.has(workClass)) {
			throw new Error(
				`--class must be one of maintenance|incident|hygiene, got "${workClass}"`,
			);
		}
		if (!expires?.trim()) {
			throw new Error(
				`--class ${workClass} requires --expires <duration|iso> (e.g. 72h, 7d) — operational exceptions are time-bounded`,
			);
		}
		purposeExceptionExpiresAt = expiresToIso(expires);
	}
	if (kind && !CREATE_WORK_KINDS.has(kind)) {
		throw new Error(
			`--kind must be one of ${[...CREATE_WORK_KINDS].join("|")}, got "${kind}"`,
		);
	}
	if (priority && !CREATE_PRIORITIES.has(priority)) {
		throw new Error(
			`--priority must be one of critical|high|medium|low, got "${priority}"`,
		);
	}

	const args: Record<string, unknown> = {
		title: t,
		...(desc?.trim() ? { description: desc.trim() } : {}),
		...(kind ? { workKind: kind } : {}),
		...(priority ? { priority } : {}),
		...(objective ? { objectiveId: objective.trim() } : {}),
		...(workClass ? { workClass, purposeExceptionExpiresAt } : {}),
		...(await resolveProjectArg(ctx, ctx.work.project)),
	};
	const call = await boardCall(
		ctx,
		mutationCallable(as, "work.create_work_items"),
		withSession(ctx, args),
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not create work item: ${call.error.message}`,
		);
	}
	// The platform tool returns the row; a namespaced variant may wrap it.
	const item = isRecord(call.value)
		? isRecord(call.value.workItem)
			? call.value.workItem
			: call.value
		: {};
	const id = typeof item.id === "string" ? item.id : "";
	return ok(ctx, call.value, () => {
		console.log(
			`${green("Created", ctx.color)} ${id || "(id unavailable)"}  ${dispositionPaint(
				String(item.disposition ?? "proposed"),
				ctx.color,
			)}  ${truncate(t, 60)}`,
		);
		if (id) {
			console.log(
				dim(
					`  accept it, then start: tedix work accept ${id} --done-when "<what done looks like>"`,
					ctx.color,
				),
			);
		}
	});
}

async function workStart(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work start requires a work item id");
	const { as } = ctx.work;
	id = await resolveWorkItemId(ctx, id);
	const call = await boardCall(
		ctx,
		mutationCallable(as, "work.start_work_item_attempt"),
		withSession(ctx, { id }),
	);

	if (call.error) {
		if (call.error.code === "CONFLICT") {
			// Admission returns CONFLICT for every reason it refuses, not only a
			// live attempt: a reserved resource key, a stale specification
			// revision, and an exhausted budget all land here. Asserting one of
			// them printed the wrong reason for the others — a budget refusal read
			// as "already has a live attempt" — so the server's own message leads
			// and the hint follows it.
			return fail(
				ctx,
				call.error,
				`Could not start attempt for ${id}: ${call.error.message}\nInspect the failed gate with \`tedix work readiness ${id}\` or the item with \`tedix work context ${id}\`.`,
			);
		}
		return fail(
			ctx,
			call.error,
			`Could not start attempt for ${id}: ${call.error.message}`,
		);
	}
	const attempt = isRecord(call.value) ? call.value.attempt : undefined;
	const attemptId = isRecord(attempt) ? attempt.id : undefined;
	const serverAgentSession =
		isRecord(attempt) && typeof attempt.externalSessionKey === "string"
			? attempt.externalSessionKey.trim()
			: undefined;
	const resumed = isRecord(call.value) && call.value.resumed === true;
	if (typeof attemptId !== "string" || !attemptId.trim()) {
		return fail(
			ctx,
			{ code: "INVALID_RESULT", message: "Start returned no attempt fence" },
			`Could not retain attempt ${id}: the board returned no attempt id.`,
		);
	}
	try {
		ctx.attemptStore.set(
			workAttemptKey(ctx, id, serverAgentSession),
			attemptId,
		);
	} catch (error) {
		const detail = errorText(error);
		return fail(
			ctx,
			{
				code: "LOCAL_ATTEMPT_STORE_FAILED",
				message: `${detail}; attempt ${attemptId} remains live and must be settled explicitly`,
			},
			`Attempt ${attemptId} started for ${id}, but its fence could not be stored locally. Settle it explicitly before retrying.`,
		);
	}
	let worktree: { path: string; branch: string; reused: boolean } | undefined;
	if (ctx.work.worktree) {
		if (!serverAgentSession) {
			return fail(
				ctx,
				{
					code: "WORKTREE_REQUIRES_EXTERNAL_SESSION",
					message: `attempt ${attemptId} remains live and must be settled explicitly`,
				},
				"Attempt started, but worktree provisioning requires a server-certified external Agent-Session.",
			);
		}
		try {
			worktree = (ctx.provisionWorktree ?? provisionAttemptWorktree)({
				workItemId: id,
				attemptId,
				agentSession: serverAgentSession,
				...(ctx.work.worktreeRoot ? { root: ctx.work.worktreeRoot } : {}),
			});
		} catch (error) {
			return fail(
				ctx,
				{
					code: "LOCAL_WORKTREE_FAILED",
					message: `${errorText(error)}; attempt ${attemptId} remains live and must be settled explicitly`,
				},
				`Attempt ${attemptId} started for ${id}, but its isolated worktree could not be provisioned.`,
			);
		}
	}
	const output =
		worktree && isRecord(call.value)
			? { ...call.value, localWorktree: worktree }
			: call.value;
	return ok(ctx, output, () => {
		const expiresAt =
			isRecord(attempt) && typeof attempt.expiresAt === "string"
				? attempt.expiresAt
				: undefined;
		console.log(
			`${green(resumed ? "Resumed" : "Started", ctx.color)} ${id} as ${as ?? "verified external credential"}${
				attemptId ? ` — attempt ${attemptId}` : ""
			}${expiresAt ? ` (attempt expires ${expiresAt})` : ""}`,
		);
		if (worktree) {
			console.log(
				`${green(worktree.reused ? "Reused" : "Provisioned", ctx.color)} ${worktree.path} — ${worktree.branch}`,
			);
		}
		console.log(
			dim(
				`  keep it alive: tedix work heartbeat ${id}${as ? ` --as ${as}` : ""}`,
				ctx.color,
			),
		);
	});
}

/**
 * Post a comment as the acting identity implied by `--as` (or the operator).
 * Discussion is deliberately separate from lifecycle events and attempt state.
 */
async function postComment(
	ctx: WorkContext,
	id: string,
	body: string,
	extraMeta?: Record<string, unknown>,
): Promise<BoardResult> {
	const { as } = ctx.work;
	const meta =
		extraMeta && Object.keys(extraMeta).length > 0
			? { metadata: extraMeta }
			: {};
	if (as) {
		return boardCall(
			ctx,
			mutationCallable(as, "work.add_comment"),
			withSession(ctx, {
				id,
				body,
				...meta,
			}),
		);
	}
	return boardCall(
		ctx,
		"work.add_comment",
		withSession(ctx, {
			id,
			body,
			...meta,
		}),
	);
}

async function workComment(
	ctx: WorkContext,
	id: string,
	text: string,
): Promise<number> {
	if (!id || !text.trim()) {
		throw new Error("work comment requires a work item id and comment text");
	}
	id = await resolveWorkItemId(ctx, id);
	const call = await postComment(ctx, id, text.trim());
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not comment on ${id}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(`${green("Commented", ctx.color)} on ${id}.`),
	);
}

async function workAuthorizeBlog(
	ctx: WorkContext,
	id: string,
): Promise<number> {
	if (!id) throw new Error("work authorize-blog requires a work item id");
	if (ctx.work.as) {
		throw new Error(
			"work authorize-blog requires an owner/admin user principal; remove --as and use an authenticated user login",
		);
	}
	const identityError = oauthHarnessGuard(ctx);
	if (identityError) {
		return fail(
			ctx,
			identityError,
			`Could not authorize blog publishing on ${id}: ${identityError.message}`,
		);
	}
	const campaignKey = ctx.work.campaign?.trim();
	const validUntil = ctx.work.validUntil?.trim();
	const contentIds = [
		...new Set(
			(ctx.work.contentIds ?? "")
				.split(",")
				.map((contentId) => contentId.trim())
				.filter(Boolean),
		),
	];
	if (!campaignKey || contentIds.length === 0 || !validUntil) {
		throw new Error(
			"work authorize-blog requires --campaign, --content-ids, and --valid-until",
		);
	}
	id = await resolveWorkItemId(ctx, id);
	if (ctx.work.operatorOverride) {
		const session = resolveAgentSession(ctx.work.session);
		const override = await postComment(
			ctx,
			id,
			`Owner/admin credential override: blog authorization from ${session?.session ?? "an unidentified harness session"} using ${ctx.authSource ?? "an unknown credential source"}.`,
		);
		if (override.error) {
			return fail(
				ctx,
				override.error,
				`Could not audit the operator override for ${id}: ${override.error.message}`,
			);
		}
	}
	const call = await boardCall(
		ctx,
		"work.authorize_owned_channel",
		{
			id,
			campaignKey,
			contentIds,
			validUntil,
		},
		`Authorize bounded blog publishing for campaign ${campaignKey} on ${id}`,
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not authorize blog campaign on ${id}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(
			`${green("Authorized", ctx.color)} ${contentIds.length} blog draft${contentIds.length === 1 ? "" : "s"} for campaign ${campaignKey} on ${id} until ${validUntil}.`,
		),
	);
}

async function workRevokeBlog(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work revoke-blog requires a work item id");
	if (ctx.work.as) {
		throw new Error(
			"work revoke-blog requires an owner/admin user principal; remove --as and use an authenticated user login",
		);
	}
	const identityError = oauthHarnessGuard(ctx);
	if (identityError) {
		return fail(
			ctx,
			identityError,
			`Could not revoke blog publishing on ${id}: ${identityError.message}`,
		);
	}
	const campaignKey = ctx.work.campaign?.trim();
	const reason = ctx.work.reason?.trim();
	if (!campaignKey || !reason) {
		throw new Error("work revoke-blog requires --campaign and --reason");
	}
	id = await resolveWorkItemId(ctx, id);
	if (ctx.work.operatorOverride) {
		const session = resolveAgentSession(ctx.work.session);
		const override = await postComment(
			ctx,
			id,
			`Owner/admin credential override: blog authorization revocation from ${session?.session ?? "an unidentified harness session"} using ${ctx.authSource ?? "an unknown credential source"}.`,
		);
		if (override.error) {
			return fail(
				ctx,
				override.error,
				`Could not audit the operator override for ${id}: ${override.error.message}`,
			);
		}
	}
	const call = await boardCall(
		ctx,
		"work.revoke_owned_channel",
		{
			id,
			campaignKey,
			reason,
		},
		`Revoke blog publishing for campaign ${campaignKey} on ${id}: ${reason}`,
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not revoke blog campaign on ${id}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(
			`${yellow("Revoked", ctx.color)} blog campaign ${campaignKey} on ${id}.`,
		),
	);
}

async function workHeartbeat(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work heartbeat requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const attemptId = cachedAttemptId(ctx, id);
	if (!attemptId) {
		return fail(
			ctx,
			missingAttemptResult(id).error!,
			`Could not heartbeat ${id}: no active attempt is cached. Start the item in this workspace first.`,
		);
	}
	const key = workAttemptKey(ctx, id);
	const clock = ctx.heartbeatClock ?? { now: Date.now, wait: sleep };
	const deadline = clock.now() + (ctx.work.watch ?? 0) * 1_000;
	const callable = mutationCallable(
		ctx.work.as,
		"work.heartbeat_work_item_attempt",
	);
	let confirmedLeaseExpiry: number | undefined;
	let rateRetries = 0;
	for (;;) {
		// Pin the original fence. Another process may settle or replace its cache.
		if (ctx.attemptStore.get(key) !== attemptId) {
			return fail(
				ctx,
				{
					code: "STALE_ATTEMPT",
					message: "The cached Attempt changed; heartbeat watch stopped.",
				},
				"Heartbeat watch stopped: the cached Attempt changed.",
			);
		}
		if (
			confirmedLeaseExpiry !== undefined &&
			clock.now() >= confirmedLeaseExpiry
		) {
			return fail(
				ctx,
				{
					code: "INVALID_LEASE",
					message:
						"The last confirmed Attempt lease expired; heartbeat watch stopped.",
				},
				"The last confirmed Attempt lease expired; heartbeat watch stopped.",
			);
		}
		const touch = await boardCall(ctx, callable, { id, attemptId });
		if (touch.error) {
			const rateLimited =
				touch.error.status === 429 ||
				(touch.error.status === undefined &&
					isRateLimitError(touch.error.message));
			// Retry only an explicit rate denial, after a confirmed renewal. Neither
			// a transport failure nor a guessed lease grants permission to keep trying.
			if (
				ctx.work.watch !== undefined &&
				rateLimited &&
				confirmedLeaseExpiry !== undefined
			) {
				const hint =
					touch.error.retryAfter !== undefined
						? touch.error.retryAfter * 1000
						: rateLimitRetryAfterMs(touch.error.message);
				const delay = Math.max(
					500,
					hint ?? 0,
					Math.min(60_000, 5_000 * 2 ** Math.min(rateRetries, 4)),
				);
				const retryDeadline = Math.min(deadline, confirmedLeaseExpiry);
				if (clock.now() + delay >= retryDeadline) {
					return fail(
						ctx,
						{
							...touch.error,
							message:
								"Rate-limited heartbeat cannot retry within the original watch horizon and confirmed lease; watch stopped.",
						},
						"Rate-limited heartbeat cannot retry within the original watch horizon and confirmed lease; watch stopped.",
					);
				}
				rateRetries++;
				console.error(
					`Heartbeat rate limited; retrying the same Attempt in ${delay / 1000}s.`,
				);
				await clock.wait(delay);
				if (clock.now() >= deadline)
					return fail(
						ctx,
						touch.error,
						"Heartbeat retry reached the original watch horizon; watch stopped.",
					);
				continue;
			}
			// A stale response can be a concurrent-write conflict, not a dead lease.
			// Keep the lookup pointer; every retry still revalidates server authority.
			return fail(
				ctx,
				touch.error,
				`Could not heartbeat ${id}: ${touch.error.message}`,
			);
		}
		const expiresAt =
			isRecord(touch.value) && typeof touch.value.expiresAt === "string"
				? touch.value.expiresAt
				: undefined;
		ok(ctx, touch.value, () => {
			console.log(
				`${green("Heartbeat", ctx.color)} touched attempt ${attemptId} on ${id}${expiresAt ? ` (attempt expires ${expiresAt})` : ""}.`,
			);
		});
		if (ctx.work.watch === undefined) return 0;
		const remainingLease = expiresAt
			? Date.parse(expiresAt) - clock.now()
			: NaN;
		if (!Number.isFinite(remainingLease) || remainingLease <= 0) {
			return fail(
				ctx,
				{
					code: "INVALID_LEASE",
					message: "Heartbeat returned no future expiry; watch stopped.",
				},
				"Heartbeat returned no future expiry; watch stopped.",
			);
		}
		confirmedLeaseExpiry = Date.parse(expiresAt!);
		rateRetries = 0;
		const remainingWatch = deadline - clock.now();
		if (remainingWatch <= 0) return 0;
		// Serial calls; leave most of the server-issued lease for request latency.
		await clock.wait(Math.min(30_000, remainingLease / 3, remainingWatch));
		if (clock.now() >= deadline) return 0;
	}
}

/**
 * Corroborate an EXISTING item you independently hit, instead of filing a
 * duplicate. Calls the canonical credential-derived corroboration ledger; a
 * stable principal counts once across every session and API key. Evidence is
 * mandatory because raw comments never affect ranking.
 */
async function workConfirm(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work confirm requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const body =
		ctx.work.note?.trim() ||
		(ctx.work.contradicts
			? "independently checked this settled claim and it does not hold"
			: "independently reproduced this issue");
	const evidence = ctx.work.evidence?.trim();
	if (!evidence) {
		throw new Error("work confirm requires --evidence <ref>");
	}
	if (ctx.work.as && isUuid(ctx.work.as)) {
		throw new Error(
			"work confirm cannot impersonate a tedi UUID; use its slug namespace or the tedi credential",
		);
	}
	const callable = mutationCallable(ctx.work.as, "work.corroborate_work_items");
	const call = await boardCall(ctx, callable, {
		id,
		evidenceRef: evidence,
		stance: ctx.work.contradicts ? "contradicts" : "corroborates",
		body,
	});
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not confirm ${id}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(
			`${green("Confirmed", ctx.color)} ${id} (corroboration recorded).`,
		),
	);
}

function parseObjectArgument(
	raw: string,
	flag: string,
): Record<string, unknown> {
	const source = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
	const parsed: unknown = JSON.parse(source);
	if (!isRecord(parsed))
		throw new Error(`${flag} must contain one JSON object`);
	return parsed;
}

/**
 * Build the acceptance contract an `accept` will write.
 *
 * One `doneLooksLike` sentence is the whole contract. The previous
 * `--acceptance <json>` escape hatch is gone: it existed to submit a full
 * stored contract, and every field that made a full contract meaningful —
 * claims, evidence kinds, review requirements — stopped being consulted by any
 * gate. Keeping a flag that wrote unread fields and silently overrode
 * `--done-when` only offered a way to get acceptance wrong.
 *
 * See `decisions/minimal-gates-over-pre-proof.md`. Stored legacy
 * contracts still PARSE on read so live rows keep deserializing; nothing
 * writes one.
 */
export function buildAcceptanceContract(
	doneWhen: string | undefined,
): Record<string, unknown> {
	const done = doneWhen?.trim();
	if (!done)
		throw new Error(
			'work accept requires --done-when "<what done looks like>"',
		);
	return { version: 1, doneLooksLike: done };
}

async function workAccept(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work accept requires a work item id");
	mutationCallable(ctx.work.as?.trim(), "work.accept_work_item");
	id = await resolveWorkItemId(ctx, id);
	const acceptanceContract = buildAcceptanceContract(ctx.work.doneWhen);
	const call = await boardCall(ctx, "work.accept_work_item", {
		id,
		acceptanceContract,
	});
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not accept ${id}: ${call.error.message}`,
		);
	return ok(ctx, call.value, () =>
		console.log(`${green("Accepted", ctx.color)} ${id}.`),
	);
}

async function workReadiness(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work readiness requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const call = await boardCall(ctx, "work.get_work_item_readiness", { id });
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not read readiness for ${id}: ${call.error.message}`,
		);
	return ok(ctx, call.value, () =>
		console.log(JSON.stringify(call.value, null, 2)),
	);
}

/**
 * Resolve every repeated `--commit <sha>` into the settlement metadata block.
 *
 * Under `decisions/minimal-gates-over-pre-proof.md` settling IS the
 * completion, and for coding work the commits on `main` are the ledger entry
 * — so the shas have to travel with the settlement rather than through a
 * separate evidence submission that nothing reads any more.
 *
 * Each value goes through `resolveCommitFlag`, which expands the short sha
 * `git push` prints and REFUSES one that names no object in this checkout.
 * That local refusal is the whole anti-fabrication story now that the digest
 * ceremony is gone: a fabricated sha fails at the terminal of the agent that
 * typed it, where the mistake is still fixable, instead of being recorded as a
 * pointer to nothing. It degrades rather than blocks outside a worktree.
 *
 * `commitSha` repeats the first entry so a consumer reading one sha does not
 * have to know about the array; duplicates collapse and order is preserved.
 */
export function buildSettlementMetadata(
	commits: readonly string[] | undefined,
	cwd = process.cwd(),
): Record<string, unknown> | undefined {
	if (!commits?.length) return undefined;
	const resolved: string[] = [];
	for (const value of commits) {
		if (!value.trim()) continue;
		const sha = resolveCommitFlag(value, cwd);
		if (!resolved.includes(sha)) resolved.push(sha);
	}
	if (resolved.length === 0) return undefined;
	return {
		settlement: {
			mode: "commit",
			commitSha: resolved[0],
			commitShas: resolved,
		},
	};
}

async function workSettle(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work settle requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const outcome = ctx.work.outcome?.trim();
	if (
		!outcome ||
		!["succeeded", "failed", "cancelled", "expired"].includes(outcome)
	) {
		throw new Error(
			"work settle requires --outcome succeeded|failed|cancelled|expired",
		);
	}
	const attemptId = cachedAttemptId(ctx, id);
	if (!attemptId)
		return fail(
			ctx,
			missingAttemptResult(id).error!,
			`Could not settle ${id}: no attempt is cached.`,
		);
	const as = ctx.work.as?.trim();
	// Resolve BEFORE the board call: a fabricated sha must fail locally, not
	// land as a settled pointer to nothing.
	const metadata = buildSettlementMetadata(ctx.work.commit);
	const call = await boardCall(
		ctx,
		mutationCallable(as, "work.settle_work_item_attempt"),
		withSession(ctx, {
			id,
			attemptId,
			outcome,
			...(ctx.work.note?.trim() ? { summary: ctx.work.note.trim() } : {}),
			...(metadata ? { metadata } : {}),
		}),
	);
	if (call.error) {
		// Preserve the pointer on failure: a heartbeat may have raced settlement.
		return fail(
			ctx,
			call.error,
			`Could not settle ${id}: ${call.error.message}`,
		);
	}
	ctx.attemptStore.remove(workAttemptKey(ctx, id), attemptId);
	return ok(ctx, call.value, () =>
		console.log(`${green("Settled", ctx.color)} ${id} (${outcome}).`),
	);
}

async function workSubmitEvidence(
	ctx: WorkContext,
	id: string,
): Promise<number> {
	if (!id) throw new Error("work submit-evidence requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const attemptId = cachedAttemptId(ctx, id);
	if (!attemptId)
		return fail(
			ctx,
			missingAttemptResult(id).error!,
			`Could not submit evidence for ${id}: no attempt is cached.`,
		);
	const claimKey = ctx.work.claimKey?.trim();
	const kind = ctx.work.evidenceKind?.trim();
	const uri = ctx.work.evidence?.trim();
	if (!claimKey || !kind || !uri)
		throw new Error(
			"work submit-evidence requires --claim-key, --evidence-kind, and --evidence",
		);
	const as = ctx.work.as?.trim();
	// No client-side digest and no per-kind repackaging: submission is a plain
	// record now, and the kind vocabulary is the server's to police. The
	// `--evidence-digest` demand invited hand-typed sha256 values, so the flag
	// is gone rather than guarded
	// (decisions/minimal-gates-over-pre-proof.md).
	const metadata = ctx.work.evidenceMetadata?.trim()
		? parseObjectArgument(
				ctx.work.evidenceMetadata.trim(),
				"--evidence-metadata",
			)
		: undefined;
	const call = await boardCall(
		ctx,
		mutationCallable(as, "work.submit_work_item_evidence"),
		withSession(ctx, {
			id,
			attemptId,
			claimKey,
			kind,
			uri,
			...(ctx.work.evidenceMediaType?.trim()
				? { mediaType: ctx.work.evidenceMediaType.trim() }
				: {}),
			...(ctx.work.evidenceLabel?.trim()
				? { label: ctx.work.evidenceLabel.trim() }
				: {}),
			...(metadata ? { metadata } : {}),
		}),
	);
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not submit evidence for ${id}: ${call.error.message}`,
		);
	return ok(ctx, call.value, () =>
		console.log(`${green("Submitted evidence", ctx.color)} for ${id}.`),
	);
}

async function workComplete(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work complete requires a work item id");
	mutationCallable(ctx.work.as?.trim(), "work.complete_work_item");
	id = await resolveWorkItemId(ctx, id);
	const call = await boardCall(ctx, "work.complete_work_item", { id });
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not complete ${id}: ${call.error.message}`,
		);
	return ok(ctx, call.value, () =>
		console.log(`${green("Completed", ctx.color)} ${id}.`),
	);
}

async function workTrailers(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work trailers requires a work item id");
	const identityError = oauthHarnessGuard(ctx);
	if (identityError) {
		return fail(
			ctx,
			identityError,
			`Could not generate trailers: ${identityError.message}`,
		);
	}
	const resolvedId = await resolveWorkItemId(ctx, id);
	const session = resolveAgentSession(ctx.work.session);
	if (isDetectedExternalHarness(session) && session?.derived) {
		throw new Error(
			"work trailers requires an immutable Agent-Session. Set TEDIX_AGENT_SESSION or use the harness-native session id before `tedix agent start`.",
		);
	}
	// Refuse to hand back a trailer the deploy gate will reject.
	//
	// The suffix is intentionally opaque. Immutable Git certification joins this
	// exact value to the settled attempt; only the harness prefix and the
	// control-character/length boundary can be checked locally.
	if (session && !session.derived && !GATE_SESSION_KEY.test(session.session)) {
		throw new Error(
			[
				`Agent-Session "${session.session}" cannot carry Git certification: expected <harness>:<opaque-session-key> without control characters.`,
				"Start a traceable external-agent session and use its exact session key.",
			].join("\n"),
		);
	}
	const trailers = [
		`Work-Item: ${resolvedId}`,
		...(session && !session.derived
			? [`Agent-Session: ${session.session}`]
			: []),
	];
	if (ctx.json) {
		console.log(
			JSON.stringify({
				workItemId: resolvedId,
				agentSession: session?.session,
				trailers,
			}),
		);
	} else {
		console.log(trailers.join("\n"));
	}
	return 0;
}

function renderContextBrief(
	value: Record<string, unknown>,
	color: ColorMode,
): void {
	const item = isRecord(value.workItem) ? value.workItem : {};
	const comments = Array.isArray(value.comments)
		? value.comments.filter(isRecord)
		: [];
	const projections = Array.isArray(value.projections)
		? value.projections.filter(isRecord)
		: [];

	console.log(
		`${cyan(String(item.title ?? "(untitled)"), color)}  ${dim(shortId(item.id), color)}`,
	);
	console.log(
		`  ${String(item.workKind ?? "—")} · ${dispositionPaint(String(item.disposition ?? "—"), color)} · ${String(
			item.priority ?? "—",
		)} · owner ${shortId(item.accountableOwnerId)} · steward ${shortId(item.stewardId)}`,
	);
	if (item.reviewerId) {
		const lease =
			typeof item.reviewerLeaseExpiresAt === "string"
				? item.reviewerLeaseExpiresAt
				: "no lease";
		console.log(
			`  reviewer ${String(item.reviewerType ?? "?")}:${shortId(item.reviewerId)} · lease ${lease}`,
		);
	}
	if (typeof item.description === "string" && item.description.trim()) {
		console.log(`\n${item.description.trim()}`);
	}

	if (projections.length > 0) {
		console.log(dim("\nLinked / projections:", color));
		for (const p of projections) {
			const ref = p.externalUrl || p.externalId || "";
			console.log(`  · ${String(p.provider ?? "?")}: ${String(ref)}`);
		}
	}

	const recent = comments.slice(-5);
	if (recent.length > 0) {
		console.log(
			dim(`\nRecent comments (${recent.length} of ${comments.length}):`, color),
		);
		for (const c of recent) {
			const when =
				typeof c.createdAt === "string" ? c.createdAt.slice(0, 16) : "";
			console.log(
				`  ${dim(`[${String(c.eventType ?? "comment")}]`, color)} ${truncate(String(c.body ?? ""), 100)} ${dim(when, color)}`,
			);
		}
	}
}

/**
 * Compact machine brief for `work context --json` — the SAME selection the
 * concise terminal renderer shows, as data. The raw board payload carries the
 * full description, metadata, provenance, and every comment — materially more
 * than the renderer shows for identical information. Agents wanting the raw row can call
 * `work.get_work_items_by_id` through native transport directly.
 */
export function contextBriefJson(value: Record<string, unknown>): unknown {
	const item = isRecord(value.workItem) ? value.workItem : {};
	const comments = Array.isArray(value.comments)
		? value.comments.filter(isRecord)
		: [];
	const projections = Array.isArray(value.projections)
		? value.projections.filter(isRecord)
		: [];
	return {
		id: item.id ?? null,
		orgId: item.orgId ?? null,
		workKind: item.workKind ?? null,
		disposition: item.disposition ?? null,
		riskLevel: item.riskLevel ?? null,
		priority: item.priority ?? null,
		title: item.title ?? null,
		projectId: item.projectId ?? null,
		accountableOwnerId: item.accountableOwnerId ?? null,
		stewardId: item.stewardId ?? null,
		reviewerId: item.reviewerId ?? null,
		// Read-only now. Nothing binds or enforces a reviewer since the review
		// plane was retired (decisions/minimal-gates-over-pre-proof.md);
		// these three are surfaced so an operator reading a Work Item accepted
		// before that still sees what its stored row says.
		reviewerType: item.reviewerType ?? null,
		reviewerLeaseExpiresAt: item.reviewerLeaseExpiresAt ?? null,
		description:
			typeof item.description === "string" ? item.description.trim() : null,
		acceptanceContract: item.acceptanceContract ?? null,
		links: projections.map((p) => ({
			provider: p.provider ?? null,
			ref: p.externalUrl ?? p.externalId ?? null,
		})),
		commentCount: comments.length,
		recentComments: comments.slice(-5).map((c) => ({
			eventType: c.eventType ?? "comment",
			body: truncate(String(c.body ?? ""), 400),
			createdAt: c.createdAt ?? null,
		})),
	};
}

async function workContext(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work context requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const call = await getWorkItem(ctx, id);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not read context for ${id}: ${call.error.message}`,
		);
	}
	// Parse-recover BEFORE branching so --json gets the compact brief too.
	let parsed = call.value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			/* leave as string */
		}
	}
	if (ctx.json) {
		console.log(
			JSON.stringify(isRecord(parsed) ? contextBriefJson(parsed) : parsed),
		);
		return 0;
	}
	return ok(ctx, call.value, () => {
		// A very large single item can arrive as a truncated JSON string; recover
		// the object when it parses, else say so rather than rendering nothing.
		let value = call.value;
		if (typeof value === "string") {
			try {
				value = JSON.parse(value);
			} catch {
				/* leave as string */
			}
		}
		if (isRecord(value)) renderContextBrief(value, ctx.color);
		else console.log(dim("No context available.", ctx.color));
	});
}

const HANDOFF_ENV_TO_CLEAR = [
	"TEDIX_AGENT_SESSION",
	"TEDIX_EXTERNAL_AGENT",
	"TEDIX_MCP_BEARER_TOKEN",
	"TEDIX_MCP_API_KEY",
] as const;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** One accepted item and a new host session; never transfer an executor fence. */
async function workHandoff(
	ctx: WorkContext,
	id: string,
	text: string,
): Promise<number> {
	if (!id || text)
		throw new Error("work handoff requires exactly one Work Item id");
	if (ctx.work.as)
		throw new Error(
			"work handoff uses the credential-scoped item; --as is not supported",
		);
	const host = ctx.work.host;
	if (host !== "codex" && host !== "claude")
		throw new Error("work handoff requires --host codex|claude");
	if (!/^[a-zA-Z0-9_-]+$/.test(ctx.workspace))
		throw new Error("work handoff requires a named CLI workspace");
	id = await resolveWorkItemId(ctx, id);
	const call = await getWorkItem(ctx, id);
	if (call.error)
		return fail(ctx, call.error, `Could not read ${id}: ${call.error.message}`);
	const item =
		isRecord(call.value) && isRecord(call.value.workItem)
			? call.value.workItem
			: call.value;
	if (!isRecord(item) || item.id !== id || item.disposition !== "accepted")
		throw new Error(
			`work handoff requires an accepted Work Item; inspect ${id} with work context`,
		);
	const prompt = `Continue Tedix Work Item ${id} in CLI workspace ${ctx.workspace}. Read its current context and readiness through tedix first. Establish your own verified external-agent identity and Agent-Session before any Work mutation. Start or resume only your own admitted Attempt, then heartbeat, settle, and complete it under the Work protocol. The launcher did not transfer an Attempt, credential, or permission to act.`;
	// The shared Codex daemon can retain a session without dispatching the
	// plugin SessionStart hook. A fresh host process delivers this opt-in brief.
	const args =
		host === "codex" ? ["--no-daemon", "-C", process.cwd(), prompt] : [prompt];
	const command = [
		"env",
		...HANDOFF_ENV_TO_CLEAR.flatMap((name) => ["-u", name]),
		`TEDIX_PLUGIN_PREFLIGHT=1`,
		`TEDIX_WORKSPACE=${ctx.workspace}`,
		`TEDIX_WORK_ITEM_ID=${id}`,
		host,
		...(host === "codex"
			? ["--no-daemon", "-C", shellQuote(process.cwd())]
			: []),
		shellQuote(prompt),
	].join(" ");
	if (!ctx.work.launch) {
		const preview = {
			workItemId: id,
			workspace: ctx.workspace,
			host,
			command,
			note: "Read-only preview. Add --launch to start a new host session; the host must establish its own identity and Attempt.",
		};
		console.log(
			ctx.json ? JSON.stringify(preview) : `${command}\n${preview.note}`,
		);
		return 0;
	}
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TEDIX_PLUGIN_PREFLIGHT: "1",
		TEDIX_WORKSPACE: ctx.workspace,
		TEDIX_WORK_ITEM_ID: id,
	};
	for (const name of HANDOFF_ENV_TO_CLEAR) delete env[name];
	if (ctx.launchHost) return ctx.launchHost(host, args, env);
	const result = spawnSync(host, args, {
		cwd: process.cwd(),
		env,
		stdio: "inherit",
	});
	if (result.error)
		throw new Error(`Could not launch ${host}: ${result.error.message}`);
	return result.status ?? 1;
}

// ─── Ledger reads (evidence / attempts / events) ─────────────────────────────

/** Bounded cursor ledgers use the exact native CLI projections. */
const LEDGER_DEFAULT_LIMIT = 25;
const LEDGER_MAX_LIMIT = 100;

function ledgerLimit(requested: number | undefined): number {
	if (typeof requested !== "number" || !Number.isFinite(requested)) {
		return LEDGER_DEFAULT_LIMIT;
	}
	return Math.min(LEDGER_MAX_LIMIT, Math.max(1, Math.trunc(requested)));
}

/** Read one compact native ledger and preserve its canonical continuation. */
async function listLedgerPage(
	ctx: WorkContext,
	callable: string,
	args: Record<string, unknown>,
	rowsKey: string,
	nextKey: string,
): Promise<BoardResult> {
	const tools: Record<string, string> = {
		"work.list_work_item_attempts": "work.list_work_attempt_cli_rows",
		"work.list_work_item_evidence": "work.list_work_evidence_cli_rows",
		"work.list_work_item_events": "work.list_work_event_cli_rows",
	};
	const call = await boardCall(ctx, tools[callable]!, args);
	if (call.error) return call;
	if (!isRecord(call.value) || !Array.isArray(call.value[rowsKey]))
		return {
			value: undefined,
			error: { message: "Malformed native Work ledger projection" },
		};
	return {
		value: { data: call.value[rowsKey], next: call.value[nextKey] ?? null },
	};
}

const EVIDENCE_DISPOSITIONS = [
	"pending",
	"accepted",
	"rejected",
	"superseded",
] as const;

/** Short, column-friendly principal label: `agent:1a2b3c4d`. */
export function principalLabel(type: unknown, id: unknown): string {
	const rawId = typeof id === "string" ? id.trim() : "";
	if (!rawId) return "—";
	const rawType = typeof type === "string" ? type.trim() : "";
	const kind = rawType === "external_agent" ? "agent" : rawType || "?";
	return `${kind}:${rawId.length > 8 ? rawId.slice(0, 8) : rawId}`;
}

/** Evidence dispositions paint differently from Work Item dispositions. */
function evidencePaint(disposition: string, color: ColorMode): string {
	if (disposition === "accepted") return green(disposition, color);
	if (disposition === "rejected") return red(disposition, color);
	if (disposition === "pending") return yellow(disposition, color);
	return dim(disposition, color);
}

/**
 * Client-side evidence filters.
 *
 * `work.list_work_item_evidence` takes only `{ id, cursor, limit }` — the board
 * exposes NO server-side claim-key or disposition filter — so these narrow the
 * page that was already fetched. Documented in `work --help` so nobody reads a
 * filtered page as an authoritative whole-ledger query.
 */
export function filterEvidenceRows(
	rows: Record<string, unknown>[],
	filters: { claimKey?: string; disposition?: string },
): Record<string, unknown>[] {
	const claimKey = filters.claimKey?.trim();
	const disposition = filters.disposition?.trim();
	return rows.filter((row) => {
		if (claimKey && String(row.claimKey ?? "") !== claimKey) return false;
		if (disposition && String(row.disposition ?? "") !== disposition)
			return false;
		return true;
	});
}

export function renderWorkEvidenceTable(
	rows: Record<string, unknown>[],
	color: ColorMode,
): string {
	if (rows.length === 0) return dim("No evidence.", color);
	const lines = [
		dim(
			`${"ID".padEnd(8)}  ${"CLAIM".padEnd(19)}  ${"KIND".padEnd(13)}  ${"DISPOSITION".padEnd(11)}  ${"SUBMITTED BY".padEnd(16)}  ${"REVIEWED BY".padEnd(16)}  URI`,
			color,
		),
	];
	for (const row of rows) {
		const id = shortId(row.id).padEnd(8);
		const claim = truncate(String(row.claimKey ?? "—"), 19).padEnd(19);
		const kind = truncate(String(row.kind ?? "—"), 13).padEnd(13);
		const rawDisposition = String(row.disposition ?? "—");
		const disposition = padCell(
			rawDisposition,
			evidencePaint(rawDisposition, color),
			11,
		);
		const submitter = truncate(
			principalLabel(row.submittedByType, row.submittedById),
			16,
		).padEnd(16);
		const reviewer = truncate(
			principalLabel(row.reviewedByType, row.reviewedById),
			16,
		).padEnd(16);
		const uri = truncate(String(row.uri ?? "—"), 60);
		lines.push(
			`${id}  ${claim}  ${kind}  ${disposition}  ${submitter}  ${reviewer}  ${uri}`,
		);
	}
	return lines.join("\n");
}

/**
 * The session that ran an attempt. `externalSessionKey` is the human-meaningful
 * one (`<harness>:<session-id>`); `executorSessionId` is its uuid. Prefer the
 * key, fall back to the uuid, and say so plainly when neither is present.
 */
export function attemptSessionLabel(row: Record<string, unknown>): string {
	const key = row.externalSessionKey;
	if (typeof key === "string" && key.trim()) return key.trim();
	const id = row.executorSessionId;
	if (typeof id === "string" && id.trim()) return shortId(id);
	return "—";
}

export function renderWorkAttemptsTable(
	rows: Record<string, unknown>[],
	color: ColorMode,
): string {
	if (rows.length === 0) return dim("No attempts.", color);
	const lines = [
		dim(
			`${"ID".padEnd(8)}  ${"#".padEnd(3)}  ${"STATE".padEnd(10)}  ${"OUTCOME".padEnd(10)}  ${"EXECUTOR".padEnd(16)}  ${"SESSION".padEnd(20)}  ${"STARTED".padEnd(16)}  HEARTBEAT`,
			color,
		),
	];
	for (const row of rows) {
		const id = shortId(row.id).padEnd(8);
		const number = String(row.attemptNumber ?? "—").padEnd(3);
		const state = String(row.runtimeState ?? "—").padEnd(10);
		const outcome = String(row.outcome ?? "—").padEnd(10);
		const executor = truncate(
			principalLabel(row.executorType, row.executorId),
			16,
		).padEnd(16);
		// Several agent sessions share one external-agent principal, so EXECUTOR
		// alone cannot say WHO ran an attempt — five orphaned attempts were
		// unattributable for exactly this reason. The row already carries the
		// answer; it just was not shown.
		const session = truncate(attemptSessionLabel(row), 20).padEnd(20);
		const started = timestampCell(row.startedAt).padEnd(16);
		const heartbeat = timestampCell(row.heartbeatAt);
		lines.push(
			`${id}  ${number}  ${state}  ${outcome}  ${executor}  ${session}  ${started}  ${heartbeat}`,
		);
	}
	return lines.join("\n");
}

export function renderWorkEventsTable(
	rows: Record<string, unknown>[],
	color: ColorMode,
): string {
	if (rows.length === 0) return dim("No events.", color);
	const lines = [
		dim(
			`${"SEQ".padEnd(6)}  ${"EVENT".padEnd(28)}  ${"ACTOR".padEnd(16)}  ${"ATTEMPT".padEnd(8)}  OCCURRED`,
			color,
		),
	];
	for (const row of rows) {
		const sequence = String(row.sequence ?? "—").padEnd(6);
		const eventType = truncate(String(row.eventType ?? "—"), 28).padEnd(28);
		const actor = truncate(
			principalLabel(row.actorType, row.actorId),
			16,
		).padEnd(16);
		const attempt = shortId(row.attemptId).padEnd(8);
		lines.push(
			`${sequence}  ${eventType}  ${actor}  ${attempt}  ${timestampCell(row.occurredAt)}`,
		);
	}
	return lines.join("\n");
}

/** `2026-08-28T18:00:00.000Z` → `2026-08-28 18:00` (16 visible columns). */
function timestampCell(value: unknown): string {
	if (typeof value !== "string" || value.length < 16) return "—";
	return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}

/**
 * `evidence` — read a Work Item's evidence ledger.
 *
 * Kept after the review plane was retired: the ~22 in-flight items accepted
 * under the old contracts carry historical `work_evidence` rows, and those
 * rows must stay readable. Nothing decides them any more — there is no
 * `review-evidence` verb — so this is a ledger view, not half a review loop.
 */
async function workEvidence(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work evidence requires a work item id");
	const disposition = ctx.work.disposition?.trim();
	if (disposition && !EVIDENCE_DISPOSITIONS.includes(disposition as never)) {
		throw new Error(
			`work evidence --disposition must be one of ${EVIDENCE_DISPOSITIONS.join("|")}`,
		);
	}
	const resolvedId = await resolveWorkItemId(ctx, id);
	const call = await listLedgerPage(
		ctx,
		"work.list_work_item_evidence",
		{ id: resolvedId, limit: ledgerLimit(ctx.work.limit) },
		"data",
		"nextCursor",
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not list evidence for ${resolvedId}: ${call.error.message}`,
		);
	}
	const rows = filterEvidenceRows(itemsFromList(call.value), {
		...(ctx.work.claimKey ? { claimKey: ctx.work.claimKey } : {}),
		...(disposition ? { disposition } : {}),
	});
	const nextCursor = isRecord(call.value) ? (call.value.next ?? null) : null;
	return ok(ctx, { data: rows, nextCursor }, () =>
		console.log(renderWorkEvidenceTable(rows, ctx.color)),
	);
}

/** `attempts` — list a Work Item's attempt ledger (same ledger read path). */
async function workAttempts(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work attempts requires a work item id");
	const resolvedId = await resolveWorkItemId(ctx, id);
	const call = await listLedgerPage(
		ctx,
		"work.list_work_item_attempts",
		{ id: resolvedId, limit: ledgerLimit(ctx.work.limit) },
		"data",
		"nextCursor",
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not list attempts for ${resolvedId}: ${call.error.message}`,
		);
	}
	const rows = itemsFromList(call.value);
	const nextCursor = isRecord(call.value) ? (call.value.next ?? null) : null;
	return ok(ctx, { data: rows, nextCursor }, () =>
		console.log(renderWorkAttemptsTable(rows, ctx.color)),
	);
}

/** `events` — list a Work Item's immutable event ledger. */
async function workEvents(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work events requires a work item id");
	const resolvedId = await resolveWorkItemId(ctx, id);
	const call = await listLedgerPage(
		ctx,
		"work.list_work_item_events",
		{ id: resolvedId, limit: ledgerLimit(ctx.work.limit) },
		"events",
		"nextSequence",
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not list events for ${resolvedId}: ${call.error.message}`,
		);
	}
	const rows = itemsFromList(call.value);
	const nextSequence = isRecord(call.value) ? (call.value.next ?? null) : null;
	return ok(ctx, { data: rows, nextSequence }, () =>
		console.log(renderWorkEventsTable(rows, ctx.color)),
	);
}

// ─── Dispatch + help ──────────────────────────────────────────────────────────

function firstToken(text: string): [string, string] {
	const trimmed = text.trim();
	const match = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
	return match ? [match[1] ?? "", (match[2] ?? "").trim()] : ["", ""];
}

export function workUsage(): string {
	return `tedix work — artifact-neutral factory work

Usage: tedix work <verb> [args] [options]

Lifecycle:
  create "<title>" --kind <kind> (--objective <id> | --class <class> --expires <duration>)
              [--project <id>]
  accept <id> --done-when "<what done looks like>"
  readiness <id>
  start <id> [--worktree [--worktree-root <outside-repo-path>]]
  handoff <id> --host codex|claude [--launch]
  heartbeat <id> [--watch [seconds]]
  settle <id> --outcome succeeded|failed|cancelled|expired [--note <summary>]
              [--commit <sha> ...]
  complete <id>
  cancel <id> [--reason <summary>]

Ledger (historical rows on in-flight items stay readable; nothing reviews them):
  submit-evidence <id> --claim-key <key> --evidence-kind <kind> --evidence <uri>
                    [--evidence-media-type <type>] [--evidence-label <label>]
                    [--evidence-metadata <json|@path>]
  evidence <id> [--claim-key <key>] [--limit <n>]

Discovery: list [--disposition <value>] · find <query> · readiness <id> · context <id>
Ledgers: evidence <id> · attempts <id> · events <id>  (one bounded page; --limit 1–100, default 25)
Checkpoint: checkpoint (read selected chat Work and bounded directed open Interactions; no writes)
Collaboration: comment <id> <text> · confirm <id> --evidence <ref> [--contradicts]

Choose the parent before creating. --project files the item under a portfolio
project; an objective-linked project takes --objective rather than --class.
A Work Item joins a case afterwards with case-attach, not at creation.

Accept states the outcome in plain language: --done-when writes the whole contract.

Settle is the completion for coding work. --commit repeats, and every value is
resolved against this checkout first: a short sha expands, a fabricated one is
refused here rather than recorded as a pointer to nothing.

The evidence verb reads the ledger, which is optional execution telemetry that
nothing reviews. Its --claim-key filter is applied CLIENT-SIDE to the fetched
page — the board exposes no server-side evidence filter — so raise --limit before
trusting a filtered page as a whole-ledger answer.

Factory controls (--input accepts inline JSON or @path):
  agent-turn-triage|agent-reply-label|agent-reply-draft-request|agent-session-report
  case-list|get|create|stage|close|attach|dependency-add
  milestone-list|create|update|attach|dependency-add · health-list|record
  approval-list|approval-audit-list|approval-propose|approval-decide (admission authority)
  interaction-list|interaction-outbox-list|interaction-audit-list|interaction-get|interaction-create|interaction-respond|interaction-cancel
  claim-files <id> --repo-key <stable-repo-key> --path <relative-file> [--path ...]
    Declare file requirements with existing owner/admin authority; reservation occurs at start.
  admission-get|replace · resource-list|put · budget-list|put · fleet · scheduler · clusters --executor-tedi <uuid>

Scheduler receipts distinguish factsTruncated + truncatedFacts (dependency, capability,
approval, resource, budget, or case facts; affected candidates are withheld as
evaluation_required) from graphTruncated (ranking only).
Cluster receipts group ranked ready Work into sequential, resource-compatible waves;
they remain advisory and every start re-evaluates admission.

An attempt id is a local capability fence scoped to workspace, actor, session, and Work Item.
Settled means done: complete carries no evidence count and no review requirement, and a wrong
claim is corrected with the confirm verb when noticed rather than prevented by pre-proof
(decisions/minimal-gates-over-pre-proof.md).

Heartbeat --watch renews only the original Attempt for 900 seconds by default
(maximum 3600). It stops on errors, cache replacement, process exit, or the
horizon. It does not settle, complete, or restart work. JSON output is NDJSON.

Exit codes: 0 success · 2 conflict, stale attempt, rejected evidence, or board error.
`;
}

type VerbHandler = (
	ctx: WorkContext,
	id: string,
	text: string,
) => Promise<number>;

interface StructuredFactoryVerb {
	tool: string;
	namespace?: "projects" | "work" | "agent";
	write: boolean;
	pathField?: string;
	defaultInput?: (ctx: WorkContext) => Record<string, unknown>;
	transform?: (input: Record<string, unknown>) => Record<string, unknown>;
}

const STRUCTURED_FACTORY_VERBS: Record<string, StructuredFactoryVerb> = {
	"agent-turn-triage": {
		tool: "triage_agent_turn",
		namespace: "agent",
		write: false,
	},
	"agent-reply-label": {
		tool: "label_agent_reply",
		namespace: "agent",
		write: false,
	},
	"agent-reply-draft-request": {
		tool: "request_agent_reply_draft",
		namespace: "agent",
		write: true,
	},
	"agent-session-report": {
		tool: "report_work_agent_session_status",
		write: true,
	},
	"case-list": {
		tool: "list_work_cases",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"case-get": { tool: "get_work_case", write: false, pathField: "caseId" },
	"case-create": { tool: "create_work_case", write: true },
	"case-stage": { tool: "update_work_case", write: true, pathField: "caseId" },
	"case-close": {
		tool: "update_work_case",
		write: true,
		pathField: "caseId",
		transform: (input) => ({ ...input, stage: "closed" }),
	},
	"case-attach": {
		tool: "attach_work_case_item",
		write: true,
		pathField: "caseId",
	},
	"case-dependency-add": { tool: "add_work_case_dependency", write: true },
	"milestone-list": {
		tool: "list_project_milestones",
		namespace: "projects",
		write: false,
		pathField: "id",
	},
	"milestone-create": {
		tool: "create_project_milestone",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"milestone-update": {
		tool: "update_project_milestone",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"milestone-attach": {
		tool: "attach_project_milestone_work_item",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"milestone-dependency-add": {
		tool: "add_project_milestone_dependency",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"health-list": {
		tool: "list_project_health_judgments",
		namespace: "projects",
		write: false,
		pathField: "id",
	},
	"health-record": {
		tool: "record_project_health_judgment",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"approval-list": {
		tool: "list_work_approvals",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"approval-audit-list": {
		tool: "list_work_approval_audit",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"approval-propose": { tool: "propose_work_approval", write: true },
	"approval-decide": {
		tool: "decide_work_approval",
		write: true,
		pathField: "proposalId",
	},
	"interaction-list": {
		tool: "list_work_interaction_cli_rows",
		write: false,
		defaultInput: (ctx) => ({ limit: Math.min(5, ctx.work.limit ?? 5) }),
	},
	"interaction-audit-list": {
		tool: "list_work_interaction_audit",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"interaction-outbox-list": {
		tool: "list_work_interaction_outbox",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"interaction-get": {
		tool: "get_work_interaction",
		write: false,
		pathField: "requestId",
		defaultInput: () => ({}),
	},
	"interaction-create": { tool: "create_work_interaction", write: true },
	"interaction-respond": {
		tool: "respond_work_interaction",
		write: true,
		pathField: "requestId",
	},
	"interaction-cancel": {
		tool: "cancel_work_interaction",
		write: true,
		pathField: "requestId",
	},
	"admission-get": {
		tool: "get_work_admission_specification",
		write: false,
		pathField: "id",
	},
	"admission-replace": {
		tool: "replace_work_admission_specification",
		write: true,
		pathField: "id",
	},
	"resource-list": {
		tool: "list_work_resource_pools",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"resource-put": { tool: "put_work_resource_pool", write: true },
	"budget-list": {
		tool: "list_work_budget_envelopes",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"budget-put": { tool: "put_work_budget_envelope", write: true },
	fleet: {
		tool: "get_work_fleet_control_tower",
		write: false,
		defaultInput: () => ({}),
	},
	clusters: {
		tool: "plan_work_execution_clusters",
		write: false,
		defaultInput: (ctx) => ({
			limit: ctx.work.limit ?? 100,
			candidateLimit: 10,
			maxParallelism: 8,
		}),
	},
	scheduler: {
		tool: "list_ready_work",
		write: false,
		defaultInput: (ctx) => ({
			limit: ctx.work.limit ?? 20,
			candidateLimit: 200,
		}),
	},
};

function structuredFactoryInput(
	ctx: WorkContext,
	verb: string,
	spec: StructuredFactoryVerb,
	pathId: string,
): Record<string, unknown> {
	const raw = ctx.work.input?.trim();
	if (!raw) {
		const defaults = spec.defaultInput?.(ctx);
		if (defaults) {
			const withPath =
				spec.pathField && pathId
					? { ...defaults, [spec.pathField]: pathId }
					: defaults;
			return spec.transform?.(withPath) ?? withPath;
		}
		throw new Error(`work ${verb} requires --input <json|@path>`);
	}
	const parsed = parseObjectArgument(raw, "--input");
	const input =
		spec.pathField && pathId ? { ...parsed, [spec.pathField]: pathId } : parsed;
	return spec.transform?.(input) ?? input;
}

async function workStructuredFactory(
	ctx: WorkContext,
	verb: string,
	pathId: string,
): Promise<number> {
	const spec = STRUCTURED_FACTORY_VERBS[verb];
	if (!spec) throw new Error(`Unknown structured Work factory verb ${verb}`);
	const callable = `${spec.namespace ?? "work"}.${spec.tool}`;
	if (spec.write) mutationCallable(ctx.work.as?.trim(), callable);
	else if (ctx.work.as?.trim())
		throw new Error(
			`work ${verb} does not expose a tedi-scoped callable; remove --as and use the credential-scoped canonical read`,
		);
	if (ctx.work.executorTedi && verb !== "clusters")
		throw new Error("--executor-tedi is only valid with work clusters");
	let input = structuredFactoryInput(ctx, verb, spec, pathId);
	if (verb === "clusters") {
		const embeddedExecutor = isRecord(input.executor)
			? input.executor
			: undefined;
		const embedded =
			embeddedExecutor?.type === "tedi" &&
			typeof embeddedExecutor.id === "string"
				? embeddedExecutor.id
				: undefined;
		if (ctx.work.executorTedi && embedded && ctx.work.executorTedi !== embedded)
			throw new Error("--executor-tedi conflicts with executor.id in --input");
		const selected = ctx.work.executorTedi ?? embedded;
		if (ctx.authSource?.startsWith("stored-login") && !selected)
			throw new Error(
				"Operator cluster planning requires --executor-tedi <uuid>",
			);
		if (ctx.work.executorTedi)
			input = {
				...input,
				executor: { type: "tedi", id: ctx.work.executorTedi },
			};
	}
	const call = await boardCall(ctx, callable, input);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not run work ${verb}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(JSON.stringify(call.value, null, 2)),
	);
}

async function workClaimFiles(
	ctx: WorkContext,
	id: string,
	text: string,
): Promise<number> {
	if (!id || text)
		throw new Error(
			"work claim-files requires exactly one Work Item id; pass files with --path",
		);
	mutationCallable(ctx.work.as, "work.replace_work_admission_specification");
	if (ctx.work.input)
		throw new Error("work claim-files uses --repo-key and --path, not --input");
	const keys = fileResourceKeys(ctx.work.repoKey, ctx.work.paths);
	id = await resolveWorkItemId(ctx, id);
	const result = await claimFiles(id, keys, (tool, input) =>
		boardCall(ctx, tool, input),
	);
	if (result.error) return fail(ctx, result.error, result.error.message);
	return ok(ctx, result.value, () =>
		console.log(
			`${result.value.changed ? "Declared" : "Already declared"} ${keys.length} file requirement(s) for ${id}. Resources are reserved only at work start.`,
		),
	);
}

/** Explicit safe-point read; retrieval never acknowledges a guardian request. */
async function workCheckpoint(
	ctx: WorkContext,
	id: string,
	text: string,
): Promise<number> {
	if (id || text || ctx.work.as || ctx.work.input || ctx.work.project)
		throw new Error(
			"work checkpoint uses the current chat selection; no id, --as, --input or --project override",
		);
	const binding = (ctx.resolveContext ?? (() => resolveAgentContext()))();
	if (
		binding.status !== "bound" ||
		!binding.workItemId ||
		!binding.contextSessionId ||
		binding.contextSource !== "chat"
	)
		throw new Error(
			"work checkpoint requires valid chat-scoped selected Work; inspect setup agents context show",
		);
	if (
		binding.workspace !== ctx.workspace ||
		!ctx.mcpUrl ||
		binding.mcpUrl !== ctx.mcpUrl
	)
		throw new Error(
			"work checkpoint cannot correlate the effective gateway and organization with this chat; use its connected profile",
		);
	const bootstrap = await nativeBootstrap(ctx);
	const runtime = bootstrap.nativeContext!;
	const itemCall = await boardCall(ctx, "work.get_work_item_checkpoint", {
		id: binding.workItemId,
	});
	if (itemCall.error) return fail(ctx, itemCall.error, itemCall.error.message);
	const item = isRecord(itemCall.value) ? itemCall.value : undefined;
	if (
		!item ||
		item.id !== binding.workItemId ||
		item.projectId !== binding.projectId ||
		item.orgId !== runtime.organizationId
	)
		throw new Error(
			"work checkpoint selected Work identity, project or organization mismatch",
		);
	const input = { workItemId: binding.workItemId, states: ["open"], limit: 5 };
	const inboxCall = await boardCall(
		ctx,
		"work.list_work_interaction_cli_rows",
		input,
	);
	if (inboxCall.error)
		return fail(ctx, inboxCall.error, inboxCall.error.message);
	const page = inboxCall.value;
	if (
		!isRecord(page) ||
		!Array.isArray(page.data) ||
		page.data.length > 5 ||
		typeof page.observedAt !== "string" ||
		typeof page.hasMore !== "boolean" ||
		!WorkInteractionCursorSchema.nullable().safeParse(page.nextCursor).success
	)
		throw new Error(
			"Malformed checkpoint inbox page; no current decisions were established",
		);
	const requests: Record<string, unknown>[] = [];
	for (const row of page.data) {
		if (!isRecord(row) || !isRecord(row.request))
			throw new Error("Malformed checkpoint interaction");
		const request = row.request;
		if (request.workItemId !== item.id || request.orgId !== item.orgId)
			throw new Error(
				"Checkpoint interaction belongs to another Work or organization",
			);
		if (row.canRespond !== true || row.effectiveState !== "open") continue;
		if (
			typeof request.id !== "string" ||
			!isUuid(request.id) ||
			!Number.isInteger(request.version) ||
			Number(request.version) < 1 ||
			typeof request.prompt !== "string" ||
			typeof request.subject !== "string"
		)
			throw new Error("Malformed actionable checkpoint interaction");
		requests.push({
			id: request.id,
			version: request.version,
			kind: request.kind,
			subject: request.subject.slice(0, 300),
			prompt: request.prompt.slice(0, 800),
			promptComplete:
				request.promptComplete === true && request.prompt.length <= 800,
			requestedFromType: request.requestedFromType,
			requestedFromId: request.requestedFromId,
			requestedAt: request.requestedAt,
		});
	}
	const value = {
		workItem: {
			id: item.id,
			projectId: item.projectId,
			organizationId: item.orgId,
			disposition: item.disposition,
		},
		chatId: binding.contextSessionId,
		observedAt: page.observedAt,
		requests,
		nextCursor: page.nextCursor,
		hasMore: page.hasMore,
		receipt: "retrieved",
		guidance:
			"Retrieval is not acknowledgment or action. Read truncated requests with work interaction-get <id>. Explicitly acknowledge with work interaction-respond <id> --input containing expectedRequestVersion, responseKind=coordination_update, body and resolvesRequest=false; record acted/deferred separately with evidence. No execution authority changed.",
	};
	return ok(ctx, value, () => console.log(JSON.stringify(value, null, 2)));
}

async function workCancel(ctx: WorkContext, id: string): Promise<number> {
	if (!id) throw new Error("work cancel requires a work item id");
	mutationCallable(ctx.work.as?.trim(), "work.cancel_work_items");
	id = await resolveWorkItemId(ctx, id);
	const call = await boardCall(ctx, "work.cancel_work_items", {
		id,
		...(ctx.work.reason ? { reason: ctx.work.reason } : {}),
	});
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Could not cancel ${id}: ${call.error.message}`,
		);
	return ok(ctx, call.value, () =>
		console.log(`${green("Cancelled", ctx.color)} ${id}.`),
	);
}

const VERBS: Record<string, VerbHandler> = {
	checkpoint: (ctx, id, text) => workCheckpoint(ctx, id, text),
	"claim-files": (ctx, id, text) => workClaimFiles(ctx, id, text),
	list: (ctx, id) => workList(ctx, id),
	find: (ctx, id, text) => workFind(ctx, text ? `${id} ${text}` : id),
	create: (ctx, id, text) => workCreate(ctx, text ? `${id} ${text}` : id),
	accept: (ctx, id) => workAccept(ctx, id),
	readiness: (ctx, id) => workReadiness(ctx, id),
	start: (ctx, id) => workStart(ctx, id),
	handoff: (ctx, id, text) => workHandoff(ctx, id, text),
	comment: (ctx, id, text) => workComment(ctx, id, text),
	"authorize-blog": (ctx, id) => workAuthorizeBlog(ctx, id),
	"revoke-blog": (ctx, id) => workRevokeBlog(ctx, id),
	heartbeat: (ctx, id) => workHeartbeat(ctx, id),
	confirm: (ctx, id) => workConfirm(ctx, id),
	settle: (ctx, id) => workSettle(ctx, id),
	"submit-evidence": (ctx, id) => workSubmitEvidence(ctx, id),
	complete: (ctx, id) => workComplete(ctx, id),
	cancel: (ctx, id) => workCancel(ctx, id),
	context: (ctx, id) => workContext(ctx, id),
	evidence: (ctx, id) => workEvidence(ctx, id),
	attempts: (ctx, id) => workAttempts(ctx, id),
	events: (ctx, id) => workEvents(ctx, id),
	trailers: (ctx, id) => workTrailers(ctx, id),
	...Object.fromEntries(
		Object.keys(STRUCTURED_FACTORY_VERBS).map((verb) => [
			verb,
			(ctx: WorkContext, id: string) => workStructuredFactory(ctx, verb, id),
		]),
	),
};

export function workVerbNames(): string[] {
	return Object.keys(VERBS);
}

/** Bounded Levenshtein distance — verbs are short, so the O(n·m) table is fine. */
function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const dist = Array.from({ length: rows }, (_, i) =>
		Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			dist[i]![j] = Math.min(
				dist[i - 1]![j]! + 1,
				dist[i]![j - 1]! + 1,
				dist[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
	}
	return dist[rows - 1]![cols - 1]!;
}

/** Closest known verbs to a typo, nearest first. Empty when nothing is close. */
export function nearestWorkVerbs(input: string, max = 3): string[] {
	const lowered = input.toLowerCase();
	return (
		workVerbNames()
			.map((verb) => ({ verb, d: editDistance(lowered, verb) }))
			// Within 2 edits, or a prefix/substring guess like `stat` → nothing vs
			// `comm` → comment. The threshold keeps "xyz" from matching anything.
			.filter(
				({ verb, d }) =>
					d <= 2 || (lowered.length >= 3 && verb.startsWith(lowered)),
			)
			.sort((a, b) => a.d - b.d)
			.slice(0, max)
			.map(({ verb }) => verb)
	);
}

/**
 * Dispatch `tedix work <verb> ...`. `args` is the verb plus its positional tail
 * (flags are already parsed into `ctx.work`). Returns a process exit code.
 */
export async function runWork(args: string, ctx: WorkContext): Promise<number> {
	ctx = {
		...ctx,
		work: JSON.parse(JSON.stringify(ctx.work)) as WorkOptions,
		client: {
			callTool: ctx.client.callTool.bind(ctx.client),
			callToolWithDestructiveApproval:
				ctx.client.callToolWithDestructiveApproval.bind(ctx.client),
			getTimeoutMs: ctx.client.getTimeoutMs.bind(ctx.client),
		},
	};
	nativeCommands.set(ctx, {
		protocolSequence: {},
		deadlineAt:
			Date.now() +
			Math.max(ctx.client.getTimeoutMs(), (ctx.work.watch ?? 0) * 1000),
	});
	const [verb, rest] = firstToken(args ?? "");
	if (!verb || verb === "help") {
		console.log(workUsage());
		return verb ? 0 : WORK_EXIT_FAIL;
	}
	const handler = VERBS[verb];
	if (!handler) {
		// Nearest-verb guidance instead of the full verb dump: an agent that
		// typed `hearbeat` needs "did you mean heartbeat", not another --help
		// page in its context window.
		const nearest = nearestWorkVerbs(verb);
		const hint =
			nearest.length > 0
				? `Did you mean: ${nearest.join(", ")}?`
				: `Verbs: ${workVerbNames().join(", ")}`;
		throw new Error(
			`Unknown work verb "${verb}". ${hint} (\`tedix work --help\` for details)`,
		);
	}
	if (
		(ctx.work.repoKey !== undefined || ctx.work.paths !== undefined) &&
		verb !== "claim-files"
	) {
		throw new Error(
			"--repo-key and --path are only valid with work claim-files",
		);
	}
	if (ctx.work.watch !== undefined) {
		if (verb !== "heartbeat")
			throw new Error("--watch is only valid with work heartbeat");
		if (
			!Number.isInteger(ctx.work.watch) ||
			ctx.work.watch < 1 ||
			ctx.work.watch > 3600
		) {
			throw new Error("work heartbeat --watch requires 1–3600 seconds");
		}
	}
	if ((ctx.work.worktree || ctx.work.worktreeRoot) && verb !== "start") {
		throw new Error(
			"--worktree and --worktree-root are only valid with work start",
		);
	}
	if ((ctx.work.host || ctx.work.launch) && verb !== "handoff")
		throw new Error("--host and --launch are only valid with work handoff");
	if (ctx.work.worktreeRoot && !ctx.work.worktree) {
		throw new Error("--worktree-root requires --worktree");
	}
	const [id, text] = firstToken(rest);
	return handler(ctx, id, text);
}
