import type {
	RankSkillsInput,
	RankSkillsOutput,
} from "@tedix/api-contract/schemas/jev";
import type { RationaleRecord } from "@tedix/api-contract/schemas/rationale-records";
import type { ListWorkApprovalInboxResultSchema } from "@tedix/api-contract/schemas/work-approvals";
/**
 * PlatformClient — Tedix oRPC API contract + HTTP implementation.
 *
 * `PlatformClient` is the runtime-neutral interface every bridge consumes
 * (memory_learn, recordRationale, recordSkill, etc.). Implementations:
 *
 * - `HttpPlatformClient` — direct HTTP calls to `/rpc/{router}/{procedure}`,
 *   authenticated via Descope access-key exchange or an injected API service
 *   binding fetcher.
 *
 * Transport is owned by `@tedix/api-client`; this wrapper only selects the
 * procedure path, caller identity, and authentication mode.
 */

import { randomUUID } from "node:crypto";
import { callRpc } from "@tedix/api-client/internal";
import type {
	RecordArtifactInput,
	TediArtifact,
	TediRuntimeEvent,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import type {
	HarnessEvalResult,
	HarnessEvalRun,
	HarnessVersion,
	TraceBundle,
} from "@tedix/api-contract/schemas/harness-version";
import type {
	WorkAttemptOutcomeSchema,
	WorkAttemptSchema,
	WorkEvidenceSchema,
	WorkItem,
	WorkItemAcceptanceContractSchema,
} from "@tedix/api-contract/schemas/work-items";
import { DescopeAccessKeyExchange } from "@tedix/auth/access-key-exchange";

// ── Public types (shared across implementations) ─────────────────────────────

export interface PlatformClientConfig {
	apiBaseUrl: string;
	descopeAccessKey?: string;
	descopeProjectId?: string;
	descopeBaseUrl?: string;
	apiAuthMode?: "descope" | "service-binding";
	tediId: string;
	organizationId?: string;
	/**
	 * Least-privilege machine scopes delegated by a trusted service-binding
	 * caller. The API authenticates the binding transport separately and only
	 * authorizes scoped procedures when this explicit grant is present.
	 */
	serviceBindingScopes?: readonly string[];
	/**
	 * Optional fetch implementation. When the runtime shares a Cloudflare service
	 * binding to the API Worker (`env.API_SERVICE`), pass its `fetch` here so RPC
	 * calls travel over the binding instead of the public edge. Service-binding
	 * transport is required for `apiAuthMode: "service-binding"` to actually be
	 * trusted by apps/api: its public ingress strips `X-Service-Binding`, so the
	 * marker survives only on the binding's InternalEntrypoint. A plain global
	 * `fetch` to a public API hostname is rejected as a non-service-binding
	 * caller. Defaults to global `fetch`.
	 */
	fetch?: typeof fetch;
}

export type WorkItemForContext = WorkItem;

export type WorkAttemptOutcome = typeof WorkAttemptOutcomeSchema._output;
export type WorkItemAcceptanceContract =
	typeof WorkItemAcceptanceContractSchema._output;

export type WorkAttempt = typeof WorkAttemptSchema._output;
export type WorkEvidence = typeof WorkEvidenceSchema._output;

export type WorkApprovalInboxForContext =
	typeof ListWorkApprovalInboxResultSchema._output;

export interface WorkApprovalDecisionForContext {
	proposal: Record<string, unknown>;
	decision: Record<string, unknown>;
}

export interface WorkItemProjectionForContext {
	id: string;
	workItemId: string;
	provider: string;
	status: "pending" | "synced" | "failed" | "stale";
	externalId?: string | null;
	externalUrl?: string | null;
	externalProjectId?: string | null;
	externalSectionId?: string | null;
	lastSyncedAt?: string | null;
	lastError?: string | null;
}

export interface SkillSearchEntry {
	id: string;
	title: string;
	slug?: string | null;
	summary?: string | null;
	description?: string | null;
	/** Full SKILL.md body. `skills/find` and `skills/listByOrg` return raw
	 * `skill_entries` rows, so the body rides along; the isolate's act-time
	 * retrieval corpus stores a capped excerpt of it. */
	content?: string | null;
	tags?: string[] | null;
	toolIds?: string[] | null;
	successCount?: number | null;
	failureCount?: number | null;
	lastUsedAt?: string | null;
	lifecycleState?: string | null;
	preconditions?: {
		requires?: string[];
		notWhen?: string[];
		validUntil?: string;
		staleSince?: string;
	} | null;
	appId?: string | null;
	/** Owning tedi (null/undefined = org-wide skill). Used by the isolate's
	 * skill-guidance block to inject ONLY tedi-owned skills. */
	tediId?: string | null;
	visibility?: string | null;
}

export interface SkillForMcpEntry {
	id: string;
	title: string;
	slug?: string | null;
	summary?: string | null;
	content?: string | null;
	description?: string | null;
	tags?: string[] | null;
	domain?: string | null;
	lifecycleState?: string | null;
	visibility?: string | null;
	tediId?: string | null;
	appId?: string | null;
	version?: number | null;
	files?: Record<string, string> | null;
	preconditions?: {
		requires?: string[];
		notWhen?: string[];
		validUntil?: string;
		staleSince?: string;
	} | null;
}

export interface MemorySearchResult {
	results: Array<{
		factId: string;
		score: number;
		fact?: {
			id?: string;
			summary?: string;
			content?: string;
			confidence?: number;
			domain?: string;
			updatedAt?: string | null;
		};
	}>;
}

export interface RationaleChainResult {
	data: Array<{
		id: string;
		action: string;
		rationale: string;
		category: string;
		confidence: number;
		outcome: string | null;
		outcomeStatus: string;
		createdAt: string;
	}>;
}

export interface ContrastiveDecisionsResult {
	successes: Array<{
		action: string;
		rationale: string;
		outcome: string | null;
	}>;
	failures: Array<{
		action: string;
		rationale: string;
		outcome: string | null;
	}>;
}

export type RationaleBlameComponent =
	| "brain_fact"
	| "directive"
	| "skill"
	| "graph_edge"
	| "missing_skill";

export interface RationaleBlameEntry {
	component: RationaleBlameComponent;
	id?: string;
	contribution: "high" | "medium" | "low";
	reason: string;
}

export interface MemoryLearnParams {
	summary: string;
	content: string;
	factType: string;
	confidence: number;
	source?: string;
	sourceSessionId?: string;
	sourceUrl?: string;
	sourceHash?: string;
	topicKey?: string;
	memoryScope?: "org" | "tedi" | "kernel" | "session" | "graph";
	usePolicy?:
		| "can_use_as_instruction"
		| "can_use_as_evidence"
		| "requires_user_confirmation"
		| "do_not_inject_automatically";
	reviewStatus?:
		| "pending"
		| "confirmed"
		| "evidence_only"
		| "restricted"
		| "stale"
		| "disputed"
		| "rejected"
		| "superseded";
	tediId?: string | null;
	domains?: string[];
	metadata?: Record<string, unknown>;
	priority?: "core" | "active" | "background";
	visibility?: "private" | "shared" | "org";
}

export interface RecordSkillParams {
	title: string;
	content: string;
	domain: string;
	summary?: string;
	tags?: string[];
	lifecycleState?: string;
	visibility?: "private" | "shared" | "org";
}

export interface ImproveSkillParams {
	id: string;
	content?: string;
	revisionReasoning?: string;
}

/** Span-checkable proof for a rationale outcome claim (WS1). */
export interface RationaleProofRef {
	kind: "run" | "tool_call" | "artifact" | "work_item";
	ref: string;
}

export interface CreateRationaleParams {
	/** Stable semantic key for retry-safe write-and-close episode projection. */
	idempotencyKey?: string;
	action: string;
	rationale: string;
	category?: string;
	confidence?: number;
	evidence?: Record<string, unknown>;
	/** Execution link (WS1): the runtime run this decision belongs to. */
	runId?: string;
	/** Execution link (WS1): the Work Item this decision serves. */
	workItemId?: string;
	/** Execution link (WS1): tool-call refs from the runtime event ledger. */
	toolCallRefs?: string[];
	outcomeStatus?: "success" | "failure" | "partial";
	outcome?: string;
}

export interface CompleteRationaleParams {
	id: string;
	outcome: string;
	outcomeStatus: "success" | "failure" | "partial";
	/**
	 * Span-checkable proof for a `success` claim (WS1). Without it the
	 * platform stores the completion as `unverified`, never `success`.
	 */
	proofRef?: RationaleProofRef;
	blameChain?: RationaleBlameEntry[];
}

export interface MemoryLearnResult {
	fact: {
		id: string;
		content: string;
		summary?: string | null;
		factType: string;
		confidence: number;
		tediId?: string | null;
		memoryScope?: "org" | "tedi" | "kernel" | "session" | "graph" | null;
		usePolicy?: string | null;
		reviewStatus?: string | null;
		archivedAt?: string | null;
		validTo?: string | null;
	};
	invalidated?: Array<{ factId: string; summary: string | null }>;
	deduplicated?: boolean;
}

// ── Interface ────────────────────────────────────────────────────────────────

/** Service-bound discovery shortlist; the caller has already enforced scope. */
export interface DiscoveryRankingInput {
	query: string;
	candidates: Array<{
		id: string;
		kind: "tool" | "skill";
		description: string;
	}>;
	runId?: string;
}

export interface DiscoveryRankingOutput {
	rankedIds: string[] | null;
	usagePersistence: "not_dispatched" | "persisted" | "unknown" | "failed";
	executionAttempts: RankSkillsOutput["executionAttempts"];
}

/**
 * The runtime-neutral platform writer surface consumed by bridges.
 *
 * The Agent runtime uses `HttpPlatformClient` with Descope authentication or
 * an injected API service binding fetcher.
 */
export interface PlatformClient {
	rankSkills?(
		input: Omit<RankSkillsInput, "tediId">,
	): Promise<RankSkillsOutput>;
	rankDiscovery?(input: DiscoveryRankingInput): Promise<DiscoveryRankingOutput>;
	/** Bind/clear the active turn's episode id for cognitive-write correlation (P0.2). */
	setEpisodeTrace(traceId: string | null): void;
	memorySearch(query: string, limit?: number): Promise<MemorySearchResult>;

	memoryLearn(params: MemoryLearnParams): Promise<MemoryLearnResult>;

	findSkills(
		query: string,
		limit?: number,
	): Promise<{ entries: SkillSearchEntry[] }>;
	/**
	 * List compact skill summaries for this tedi (tedi-scoped + org baseline).
	 * Used by the isolate to build the per-turn skill guidance block.
	 */
	listSkillsForTedi(params?: {
		limit?: number;
		lifecycleState?: string;
	}): Promise<{ entries: SkillSearchEntry[]; total: number }>;
	/**
	 * Fetch the full SKILL.md content for one skill by id or slug.
	 * Used by the isolate `read_skill` native tool.
	 */
	getSkillForMcp(params: {
		id?: string;
		slug?: string;
	}): Promise<{ entry: SkillForMcpEntry | null }>;
	recordSkill(
		params: RecordSkillParams,
	): Promise<{ entry: { id: string; title: string } }>;
	improveSkill(params: ImproveSkillParams): Promise<{ entry: { id: string } }>;
	createRationaleRecord(
		params: CreateRationaleParams,
	): Promise<Pick<RationaleRecord, "id" | "outcomeStatus">>;
	getRationaleRecord(
		id: string,
	): Promise<Pick<RationaleRecord, "id" | "outcomeStatus">>;
	completeRationaleRecord(params: CompleteRationaleParams): Promise<unknown>;
	getRationaleChain(limit?: number): Promise<RationaleChainResult>;
	getContrastiveDecisions(
		category: string,
		limit?: number,
	): Promise<ContrastiveDecisionsResult>;
	muscleRegister(params: {
		name: string;
		description: string;
		kind?: string;
		origin?: string;
	}): Promise<{ entry?: { id?: string } }>;
	createTask(params: { title: string; kind?: string }): Promise<{ id: string }>;
	updateTask(params: {
		taskId: string;
		title?: string;
		status?: string;
		result?: string;
	}): Promise<unknown>;
	createWorkItem(params: {
		title: string;
		description?: string;
		workKind?: WorkItem["workKind"];
		riskLevel?: WorkItem["riskLevel"];
		priority?: "critical" | "high" | "medium" | "low";
		objectiveId?: string;
		workClass?: "objective" | "maintenance" | "incident" | "hygiene";
		purposeExceptionExpiresAt?: string;
		projectId?: string;
		sourceSessionKey?: string;
		sourceIntentId?: string;
		dueDate?: string;
		deadline?: string;
		provenance?: Record<string, unknown>;
		metadata?: Record<string, unknown>;
	}): Promise<WorkItemForContext>;
	updateWorkItemSpecification(params: {
		workItemId: string;
		title?: string;
		description?: string | null;
		workKind?: WorkItem["workKind"];
		riskLevel?: WorkItem["riskLevel"];
		priority?: WorkItem["priority"];
	}): Promise<WorkItemForContext>;
	acceptWorkItem(params: {
		workItemId: string;
		acceptanceContract: WorkItemAcceptanceContract;
	}): Promise<WorkItemForContext>;
	listWorkApprovalInbox(params?: {
		proposalId?: string;
		workItemId?: string;
		limit?: number;
		cursor?: { at: string; id: string };
	}): Promise<WorkApprovalInboxForContext>;
	decideWorkApproval(params: {
		proposalId: string;
		expectedProposalVersion: number;
		decision: "approved" | "rejected";
		rationale: string;
	}): Promise<WorkApprovalDecisionForContext>;

	startWorkAttempt(params: {
		workItemId: string;
		runId?: string;
		expiresAt?: string;
		metadata?: Record<string, unknown>;
	}): Promise<{ workItem: WorkItem; attempt: WorkAttempt; resumed: boolean }>;
	listWorkAttempts(params: {
		workItemId: string;
		cursor?: { at: string; id: string };
	}): Promise<{
		data: WorkAttempt[];
		nextCursor: { at: string; id: string } | null;
	}>;
	heartbeatWorkAttempt(params: {
		workItemId: string;
		attemptId: string;
	}): Promise<WorkAttempt>;
	settleWorkAttempt(params: {
		workItemId: string;
		attemptId: string;
		outcome: WorkAttemptOutcome;
		summary?: string;
		metadata?: Record<string, unknown>;
	}): Promise<{ workItem: WorkItem; attempt: WorkAttempt }>;
	submitWorkEvidence(params: {
		workItemId: string;
		attemptId: string;
		claimKey: string;
		kind: string;
		uri: string;
		digest?: string;
		mediaType?: string;
		label?: string;
		metadata?: Record<string, unknown>;
	}): Promise<WorkEvidence>;
	completeWorkItem(workItemId: string): Promise<WorkItemForContext>;
	upsertWorkItemProjection(params: {
		workItemId: string;
		provider: string;
		status: "pending" | "synced" | "failed" | "stale";
		externalId?: string;
		externalUrl?: string;
		externalProjectId?: string;
		externalSectionId?: string;
		lastSyncedAt?: string;
		lastError?: string | null;
		providerState?: Record<string, unknown>;
	}): Promise<WorkItemProjectionForContext>;
	recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown>;
	recordArtifact(input: RecordArtifactInput): Promise<unknown>;
	getArtifact(params: {
		artifactId: string;
	}): Promise<{ artifact: TediArtifact }>;
	listArtifacts(params: {
		conversationId?: string;
		runId?: string;
		kind?: TediArtifact["kind"];
		name?: string;
		limit?: number;
	}): Promise<{ artifacts: TediArtifact[]; nextCursor?: string | null }>;
	listRuntimeEvents(params: {
		runId?: string;
		conversationId?: string;
		limit?: number;
		before?: string;
	}): Promise<{ events: TediRuntimeEvent[]; nextBefore?: string | null }>;
	stopRuntimeRun(params: {
		runId: string;
		conversationId?: string;
		reason?: string;
	}): Promise<StopRuntimeRunResult>;
	/**
	 * Ensure an `active` HarnessVersion exists whose `components` content-hash
	 * set matches the supplied one. Server decides bump vs no-op by diffing
	 * against the current active version. `tediId` is injected from config.
	 */
	ensureActiveHarnessVersion(params: {
		components: Record<string, string>;
		runtimeKind?: string;
		reason?: string;
		orgId?: string;
		/** Trace-safety policy id in force; stamped onto the version row. */
		traceSafetyPolicyId?: string;
	}): Promise<{ version: HarnessVersion; bumped: boolean }>;
	/** Persist a per-run trace bundle (idempotent on its deterministic id). */
	recordTraceBundle(bundle: TraceBundle): Promise<{ bundle: TraceBundle }>;
	/**
	 * Persist one HarnessEvalResult — the leaf scored record for a harness
	 * version. Idempotent on its deterministic `id`. Used by live-turn scoring
	 * (Slice B) to accumulate a real meanScore from production episodes.
	 */
	recordEvalResult(
		result: HarnessEvalResult,
	): Promise<{ result: HarnessEvalResult }>;
	/**
	 * Persist one HarnessEvalRun (N results rolled up on one lane). Idempotent on
	 * its deterministic `id`. The post-write stamp on the api side merges
	 * `latestEval` onto the version metadata + marks promotable candidates.
	 */
	recordEvalRun(run: HarnessEvalRun): Promise<{ run: HarnessEvalRun }>;

	getDomains(): Promise<Map<string, string>>;
}

export type StopRuntimeRunResult =
	| { ok: true; event?: TediRuntimeEvent }
	| { ok: false; reason: string };

// ── Internal helpers ─────────────────────────────────────────────────────────

const RPC_TIMEOUT_MS = 15_000;

// ── HttpPlatformClient ───────────────────────────────────────────────────────

export class HttpPlatformClient implements PlatformClient {
	private readonly apiBaseUrl: string;
	private readonly accessKeyExchange: DescopeAccessKeyExchange | null;
	private readonly apiAuthMode: "descope" | "service-binding";
	private readonly tediId: string;
	private readonly organizationId: string | undefined;
	private readonly serviceBindingScopes: readonly string[];
	private readonly fetchImpl: typeof fetch;
	/** Episode trace bound to the active turn (P0.2). Null = out-of-turn. */
	private episodeTrace: string | null = null;
	private requestSignal?: AbortSignal;
	private readonly config: PlatformClientConfig;

	/**
	 * Bind (or clear) the active turn's episode id so every brain RPC made during
	 * the turn is correlated under it. Safe as a single mutable field because the
	 * runtime serializes turns per DO instance (mirrors the DO's own turn-state
	 * invariant). Pass null at turn end so out-of-turn calls fall back to random.
	 */
	setEpisodeTrace(traceId: string | null): void {
		this.episodeTrace = traceId;
	}

	constructor(
		config: PlatformClientConfig,
		sharedAuth?: DescopeAccessKeyExchange | null,
	) {
		this.config = { ...config };
		this.apiBaseUrl = config.apiBaseUrl;
		this.apiAuthMode = config.apiAuthMode ?? "descope";
		this.accessKeyExchange =
			sharedAuth ??
			(config.descopeAccessKey && config.descopeProjectId
				? new DescopeAccessKeyExchange({
						descopeAccessKey: config.descopeAccessKey,
						descopeProjectId: config.descopeProjectId,
						descopeBaseUrl: config.descopeBaseUrl,
					})
				: null);
		this.tediId = config.tediId;
		this.organizationId = config.organizationId;
		this.serviceBindingScopes = config.serviceBindingScopes ?? [];
		this.fetchImpl = config.fetch ?? fetch;
	}

	/** Independent run cancellation/attribution; authentication cache stays shared. */
	forRequest(context: {
		signal: AbortSignal;
		traceId: string;
	}): HttpPlatformClient {
		const scoped = new HttpPlatformClient(this.config, this.accessKeyExchange);
		scoped.requestSignal = context.signal;
		scoped.episodeTrace = context.traceId;
		return scoped;
	}

	// ── API methods ──────────────────────────────────────────────────────────

	async memorySearch(query: string, limit = 5): Promise<MemorySearchResult> {
		return this.rpc("memoryGraph", "search", {
			query,
			tediId: this.tediId,
			topK: limit,
			minConfidence: 0.3,
			includeRelated: false,
		});
	}

	/**
	 * Durable execution stamp for a cognitive cron fire. `phase: "started"`
	 * marks the fire running at dispatch; `phase: "finished"` seals it
	 * success/failure with a JSON transitions summary. Writes the
	 * `tedi_cron_executions` ledger `flywheel.crons_flywheel_health` reads.
	 */
	async recordCronExecution(stamp: {
		fireKey: string;
		cronName: string;
		runId?: string;
		startedAt: string;
		phase: "started" | "finished";
		status?: "success" | "failure";
		finishedAt?: string;
		transitions?: Record<string, unknown>;
		error?: string;
	}): Promise<{ ok: boolean }> {
		return this.rpc("flywheelHealth", "recordCronExecution", {
			tediId: this.tediId,
			...stamp,
		});
	}

	/**
	 * Trajectory mining (WS2): deterministic consolidation operator — mines
	 * recurring successful tool-call sequences from this tedi's evidence-linked
	 * rationale episodes into draft Skill Workshop proposals. Invoked from the
	 * skill-development cognitive cron fire; also exposed as the
	 * `mine_skill_candidates` MCP tool for manual runs.
	 */
	async mineSkillCandidates(params?: {
		windowDays?: number;
		minSupport?: number;
		maxProposals?: number;
		dryRun?: boolean;
	}): Promise<{
		episodesExamined: number;
		runsExamined: number;
		patterns: Array<{
			key: string;
			tools: string[];
			support: number;
			supportRunIds: string[];
		}>;
		proposed: Array<{ id: string; title: string }>;
		skipped: Array<{ key: string; reason: string; skillId: string }>;
	}> {
		return this.rpc("skills", "mineCandidates", {
			tediId: this.tediId,
			...params,
		});
	}

	async recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown> {
		return this.rpc("cognitiveRuntime", "recordEvent", event);
	}

	async recordArtifact(input: RecordArtifactInput): Promise<unknown> {
		return this.rpc("cognitiveRuntime", "recordArtifact", input);
	}

	async getArtifact(params: {
		artifactId: string;
	}): Promise<{ artifact: TediArtifact }> {
		return this.rpc("cognitiveRuntime", "getArtifact", {
			tediId: this.tediId,
			...params,
		});
	}

	async listArtifacts(params: {
		conversationId?: string;
		runId?: string;
		kind?: TediArtifact["kind"];
		name?: string;
		limit?: number;
	}): Promise<{ artifacts: TediArtifact[]; nextCursor?: string | null }> {
		return this.rpc("cognitiveRuntime", "listArtifacts", {
			tediId: this.tediId,
			...params,
		});
	}

	async listRuntimeEvents(params: {
		runId?: string;
		conversationId?: string;
		limit?: number;
		before?: string;
	}): Promise<{ events: TediRuntimeEvent[]; nextBefore?: string | null }> {
		return this.rpc("cognitiveRuntime", "listEvents", {
			tediId: this.tediId,
			...params,
		});
	}

	async stopRuntimeRun(params: {
		runId: string;
		conversationId?: string;
		reason?: string;
	}): Promise<StopRuntimeRunResult> {
		return this.rpc("cognitiveRuntime", "stopRun", {
			tediId: this.tediId,
			...params,
		});
	}

	async ensureActiveHarnessVersion(params: {
		components: Record<string, string>;
		runtimeKind?: string;
		reason?: string;
		orgId?: string;
		traceSafetyPolicyId?: string;
	}): Promise<{ version: HarnessVersion; bumped: boolean }> {
		return this.rpc("harness", "ensureActiveHarnessVersion", {
			tediId: this.tediId,
			components: params.components,
			...(params.runtimeKind ? { runtimeKind: params.runtimeKind } : {}),
			...(params.reason ? { reason: params.reason } : {}),
			...(params.traceSafetyPolicyId
				? { traceSafetyPolicyId: params.traceSafetyPolicyId }
				: {}),
			...((params.orgId ?? this.organizationId)
				? { orgId: params.orgId ?? this.organizationId }
				: {}),
		});
	}

	async recordTraceBundle(
		bundle: TraceBundle,
	): Promise<{ bundle: TraceBundle }> {
		return this.rpc("harness", "recordTraceBundle", bundle);
	}

	async recordEvalResult(
		result: HarnessEvalResult,
	): Promise<{ result: HarnessEvalResult }> {
		return this.rpc("harness", "recordEvalResult", result);
	}

	async recordEvalRun(run: HarnessEvalRun): Promise<{ run: HarnessEvalRun }> {
		return this.rpc("harness", "recordEvalRun", run);
	}

	async rankSkills(
		input: Omit<RankSkillsInput, "tediId">,
	): Promise<RankSkillsOutput> {
		return this.rpc(
			"cognitiveRuntime",
			"rankSkills",
			{ ...input, tediId: this.tediId },
			6000,
		);
	}

	async rankDiscovery(
		input: DiscoveryRankingInput,
	): Promise<DiscoveryRankingOutput> {
		return this.rpc("cognitiveRuntime", "rankDiscovery", { ...input }, 6000);
	}

	async findSkills(
		query: string,
		limit = 5,
	): Promise<{ entries: SkillSearchEntry[] }> {
		return this.rpc("skills", "find", {
			query,
			tediId: this.tediId,
			limit,
		});
	}

	async listSkillsForTedi(
		params: { limit?: number; lifecycleState?: string } = {},
	): Promise<{ entries: SkillSearchEntry[]; total: number }> {
		return this.rpc("skills", "listByOrg", {
			tediId: this.tediId,
			limit: params.limit ?? 50,
			...(params.lifecycleState
				? { lifecycleState: params.lifecycleState }
				: {}),
		});
	}

	async getSkillForMcp(params: {
		id?: string;
		slug?: string;
	}): Promise<{ entry: SkillForMcpEntry | null }> {
		return this.rpc("skills", "getForMcp", {
			...(params.id ? { id: params.id } : {}),
			...(params.slug ? { slug: params.slug } : {}),
			// Readability is tedi-relative for BOTH selectors. Omitting this for
			// id-addressed reads made a tedi's own private skill look missing.
			tediId: this.tediId,
		});
	}

	async memoryLearn(params: MemoryLearnParams): Promise<MemoryLearnResult> {
		const tediId =
			params.tediId === null || params.memoryScope === "org"
				? undefined
				: (params.tediId ?? this.tediId);
		const sourceSessionId =
			params.sourceSessionId ?? this.episodeTrace ?? undefined;
		const metadata = {
			...params.metadata,
			...(this.episodeTrace ? { sourceTraceId: this.episodeTrace } : {}),
			...(params.memoryScope ? { memoryScope: params.memoryScope } : {}),
			...(params.usePolicy ? { usePolicy: params.usePolicy } : {}),
			...(params.reviewStatus ? { reviewStatus: params.reviewStatus } : {}),
			...(params.topicKey ? { topicKey: params.topicKey } : {}),
		};
		return this.rpc<MemoryLearnResult>("memoryGraph", "learn", {
			content: params.content,
			summary: params.summary,
			domain: params.domains?.[0] || "observations",
			factType: params.factType,
			...(tediId ? { tediId } : {}),
			confidence: params.confidence,
			source: params.source,
			...(sourceSessionId ? { sourceSessionId } : {}),
			...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
			...(params.sourceHash ? { sourceHash: params.sourceHash } : {}),
			...(params.topicKey ? { topicKey: params.topicKey } : {}),
			...(params.memoryScope ? { memoryScope: params.memoryScope } : {}),
			...(params.usePolicy ? { usePolicy: params.usePolicy } : {}),
			...(params.reviewStatus ? { reviewStatus: params.reviewStatus } : {}),
			...(Object.keys(metadata).length > 0 ? { metadata } : {}),
			...(params.priority ? { priority: params.priority } : {}),
			...(params.visibility ? { visibility: params.visibility } : {}),
		});
	}

	async getRationaleChain(limit = 20): Promise<RationaleChainResult> {
		return this.rpc("rationaleRecords", "chain", {
			tediId: this.tediId,
			limit,
		});
	}

	async getContrastiveDecisions(
		category: string,
		limit = 10,
	): Promise<ContrastiveDecisionsResult> {
		const result = await this.getRationaleChain(limit);
		const records = result.data || [];
		const filtered = records.filter((r) => r.category === category);

		const successes = filtered
			.filter((r) => r.outcomeStatus === "success")
			.map((r) => ({
				action: r.action,
				rationale: r.rationale,
				outcome: r.outcome,
			}));

		const failures = filtered
			.filter((r) => r.outcomeStatus === "failure")
			.map((r) => ({
				action: r.action,
				rationale: r.rationale,
				outcome: r.outcome,
			}));

		return { successes, failures };
	}

	async createTask(params: {
		title: string;
		kind?: string;
	}): Promise<{ id: string }> {
		if (!this.organizationId)
			throw new Error("organizationId required for createTask");
		return this.rpc("tediObjectives", "createTask", {
			tediId: this.tediId,
			orgId: this.organizationId,
			title: params.title,
			kind: params.kind || "general",
		});
	}

	async createWorkItem(params: {
		title: string;
		description?: string;
		workKind?: WorkItem["workKind"];
		riskLevel?: WorkItem["riskLevel"];
		priority?: "critical" | "high" | "medium" | "low";
		objectiveId?: string;
		workClass?: "objective" | "maintenance" | "incident" | "hygiene";
		purposeExceptionExpiresAt?: string;
		projectId?: string;
		sourceSessionKey?: string;
		sourceIntentId?: string;
		dueDate?: string;
		deadline?: string;
		provenance?: Record<string, unknown>;
		metadata?: Record<string, unknown>;
	}): Promise<WorkItemForContext> {
		// Purpose-context policy mirrors `workItemPurposeFor` in
		// `packages/db/src/queries/work-items/purpose.ts` (objective link wins;
		// otherwise class + DEFAULT_PURPOSE_EXCEPTION_TTL_MS = 7d expiry).
		// Kept inline: brain-bridge cannot depend on @tedix/db, and this RPC
		// payload also carries caller-supplied workClass/expiry overrides that
		// the server-side purpose resolver validates.
		const workClass =
			params.workClass ?? (params.objectiveId ? "objective" : "maintenance");
		return this.rpc("workItems", "create", {
			title: params.title,
			description: params.description,
			workKind: params.workKind ?? "other",
			riskLevel: params.riskLevel ?? "medium",
			priority: params.priority ?? "medium",
			accountableOwnerType: "tedi",
			accountableOwnerId: this.tediId,
			stewardType: "tedi",
			stewardId: this.tediId,
			objectiveId: params.objectiveId,
			workClass,
			purposeExceptionExpiresAt:
				workClass === "objective"
					? undefined
					: (params.purposeExceptionExpiresAt ??
						new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()),
			projectId: params.projectId,
			sourceSessionKey: params.sourceSessionKey,
			sourceIntentId: params.sourceIntentId,
			dueDate: params.dueDate,
			deadline: params.deadline,
			provenance: params.provenance,
			metadata: {
				...params.metadata,
				...(params.objectiveId
					? { purposeContext: "objective" }
					: { purposeContext: "transitional_task_intent_exception" }),
			},
		});
	}

	async updateWorkItemSpecification(params: {
		workItemId: string;
		title?: string;
		description?: string | null;
		workKind?: WorkItem["workKind"];
		riskLevel?: WorkItem["riskLevel"];
		priority?: WorkItem["priority"];
	}): Promise<WorkItemForContext> {
		return this.rpc("workItems", "updateSpecification", {
			id: params.workItemId,
			title: params.title,
			description: params.description,
			workKind: params.workKind,
			riskLevel: params.riskLevel,
			priority: params.priority,
		});
	}

	async acceptWorkItem(params: {
		workItemId: string;
		acceptanceContract: WorkItemAcceptanceContract;
	}): Promise<WorkItemForContext> {
		return this.rpc("workItems", "accept", {
			id: params.workItemId,
			acceptanceContract: params.acceptanceContract,
		});
	}

	async listWorkApprovalInbox(
		params: {
			proposalId?: string;
			workItemId?: string;
			limit?: number;
			cursor?: { at: string; id: string };
		} = {},
	): Promise<WorkApprovalInboxForContext> {
		return this.rpc("workApprovals", "listInbox", params);
	}

	async decideWorkApproval(params: {
		proposalId: string;
		expectedProposalVersion: number;
		decision: "approved" | "rejected";
		rationale: string;
	}): Promise<WorkApprovalDecisionForContext> {
		return this.rpc("workApprovals", "decide", params);
	}

	async startWorkAttempt(params: {
		workItemId: string;
		runId?: string;
		expiresAt?: string;
		metadata?: Record<string, unknown>;
	}): Promise<{ workItem: WorkItem; attempt: WorkAttempt; resumed: boolean }> {
		return this.rpc("workItems", "startAttempt", {
			id: params.workItemId,
			runId: params.runId,
			expiresAt: params.expiresAt,
			metadata: params.metadata,
		});
	}

	async listWorkAttempts(params: {
		workItemId: string;
		cursor?: { at: string; id: string };
	}): Promise<{
		data: WorkAttempt[];
		nextCursor: { at: string; id: string } | null;
	}> {
		return this.rpc("workItems", "listAttempts", {
			id: params.workItemId,
			cursor: params.cursor,
			limit: 100,
		});
	}

	async heartbeatWorkAttempt(params: {
		workItemId: string;
		attemptId: string;
	}): Promise<WorkAttempt> {
		return this.rpc("workItems", "heartbeatAttempt", {
			id: params.workItemId,
			attemptId: params.attemptId,
		});
	}

	async settleWorkAttempt(params: {
		workItemId: string;
		attemptId: string;
		outcome: WorkAttemptOutcome;
		summary?: string;
		metadata?: Record<string, unknown>;
	}): Promise<{ workItem: WorkItem; attempt: WorkAttempt }> {
		return this.rpc("workItems", "settleAttempt", {
			id: params.workItemId,
			attemptId: params.attemptId,
			outcome: params.outcome,
			summary: params.summary,
			metadata: params.metadata,
		});
	}

	async submitWorkEvidence(params: {
		workItemId: string;
		attemptId: string;
		claimKey: string;
		kind: string;
		uri: string;
		digest?: string;
		mediaType?: string;
		label?: string;
		metadata?: Record<string, unknown>;
	}): Promise<WorkEvidence> {
		return this.rpc("workItems", "submitEvidence", {
			id: params.workItemId,
			attemptId: params.attemptId,
			claimKey: params.claimKey,
			kind: params.kind,
			uri: params.uri,
			digest: params.digest,
			mediaType: params.mediaType,
			label: params.label,
			metadata: params.metadata,
		});
	}

	async completeWorkItem(workItemId: string): Promise<WorkItemForContext> {
		return this.rpc("workItems", "complete", { id: workItemId });
	}

	async upsertWorkItemProjection(params: {
		workItemId: string;
		provider: string;
		status: "pending" | "synced" | "failed" | "stale";
		externalId?: string;
		externalUrl?: string;
		externalProjectId?: string;
		externalSectionId?: string;
		lastSyncedAt?: string;
		lastError?: string | null;
		providerState?: Record<string, unknown>;
	}): Promise<WorkItemProjectionForContext> {
		return this.rpc("workItems", "upsertProjection", {
			id: params.workItemId,
			provider: params.provider,
			direction: "projection",
			status: params.status,
			externalId: params.externalId,
			externalUrl: params.externalUrl,
			externalProjectId: params.externalProjectId,
			externalSectionId: params.externalSectionId,
			lastSyncedAt: params.lastSyncedAt,
			lastError: params.lastError,
			providerState: params.providerState,
		});
	}

	async updateTask(params: {
		taskId: string;
		title?: string;
		status?: string;
		result?: string;
	}): Promise<unknown> {
		return this.rpc("tediObjectives", "updateTask", {
			id: params.taskId,
			status: params.status,
			result: params.result,
		});
	}

	async muscleRegister(params: {
		name: string;
		description: string;
		kind?: string;
		origin?: string;
	}): Promise<{ entry?: { id?: string } }> {
		return this.rpc("muscle", "register", {
			tediId: this.tediId,
			kind: params.kind || "action_template",
			name: params.name,
			description: params.description,
			origin: params.origin || "crystallized",
		});
	}

	async getRationaleRecord(
		id: string,
	): Promise<Pick<RationaleRecord, "id" | "outcomeStatus">> {
		return this.rpc("rationaleRecords", "getById", { id });
	}

	async createRationaleRecord(
		params: CreateRationaleParams,
	): Promise<Pick<RationaleRecord, "id" | "outcomeStatus">> {
		if (!this.organizationId)
			throw new Error("organizationId required for createRationaleRecord");
		return this.rpc("rationaleRecords", "create", {
			tediId: this.tediId,
			orgId: this.organizationId,
			...(params.idempotencyKey
				? { idempotencyKey: params.idempotencyKey }
				: {}),
			action: params.action,
			rationale: params.rationale,
			category: params.category || "custom",
			confidence: params.confidence ?? 0.7,
			evidence: {
				...params.evidence,
				...(this.episodeTrace ? { traceId: this.episodeTrace } : {}),
			},
			// WS1 execution links — required by the platform write path.
			...(params.runId ? { runId: params.runId } : {}),
			...(params.workItemId ? { workItemId: params.workItemId } : {}),
			...(params.toolCallRefs?.length
				? { toolCallRefs: params.toolCallRefs }
				: {}),
			...(params.outcomeStatus
				? {
						outcomeStatus: params.outcomeStatus,
						outcome: params.outcome ?? params.rationale,
					}
				: {}),
		});
	}

	async completeRationaleRecord(
		params: CompleteRationaleParams,
	): Promise<unknown> {
		return this.rpc("rationaleRecords", "complete", {
			id: params.id,
			outcome: params.outcome,
			outcomeStatus: params.outcomeStatus,
			...(params.proofRef ? { proofRef: params.proofRef } : {}),
			...(params.blameChain?.length ? { blameChain: params.blameChain } : {}),
		});
	}

	async recordSkill(
		params: RecordSkillParams,
	): Promise<{ entry: { id: string; title: string } }> {
		return this.rpc("skills", "record", {
			tediId: this.tediId,
			title: params.title,
			content: params.content,
			domain: params.domain,
			summary: params.summary,
			tags: params.tags,
			...(params.lifecycleState
				? { lifecycleState: params.lifecycleState }
				: {}),
			...(params.visibility ? { visibility: params.visibility } : {}),
		});
	}

	async improveSkill(
		params: ImproveSkillParams,
	): Promise<{ entry: { id: string } }> {
		return this.rpc("skills", "improve", {
			id: params.id,
			content: params.content,
			revisionReasoning: params.revisionReasoning,
		});
	}

	async getDomains(): Promise<Map<string, string>> {
		const result = await this.rpc<{
			domains: Array<{ id: string; name: string }>;
		}>("memoryGraph", "listDomains", { tediId: this.tediId });
		const map = new Map<string, string>();
		for (const d of result.domains ?? []) {
			map.set(d.id, d.name);
		}
		return map;
	}

	// ── Transport ────────────────────────────────────────────────────────────

	private async rpc<T = unknown>(
		router: string,
		procedure: string,
		input: Record<string, unknown>,
		timeoutMs = RPC_TIMEOUT_MS,
	): Promise<T> {
		this.requestSignal?.throwIfAborted();
		const headers = await this.getHeaders();
		this.requestSignal?.throwIfAborted();
		const procedurePath = procedure.replace(/\./g, "/");
		// Episode trace (P0.2): when the runtime has bound the active turn's id via
		// setEpisodeTrace(), propagate it as X-Trace-Id so apps/api stamps every
		// cognitive write (decision/skill/memory) with the SAME id as the turn's
		// other runtime events — making one tedi turn replayable as one episode.
		// Fall back to a per-call random id only when no turn is bound (preserves
		// prior behavior for out-of-turn calls).
		if (this.episodeTrace) {
			headers["X-Trace-Id"] = this.episodeTrace;
			headers["X-Tedix-Trace-Id"] = this.episodeTrace;
		} else {
			headers["X-Tedix-Trace-Id"] = randomUUID();
		}

		return callRpc<T>([router, ...procedurePath.split("/")], input, {
			apiUrl: this.apiBaseUrl,
			fetch: this.fetchImpl,
			headers,
			timeoutMs,
			signal: this.requestSignal,
		});
	}

	private async getHeaders(): Promise<Record<string, string>> {
		const headers: Record<string, string> = {
			Accept: "application/json",
			"Accept-Encoding": "identity",
			"Content-Type": "application/json",
			"X-Tedix-Tedi-Id": this.tediId,
			"X-Tedix-Caller": "brain-bridge",
			"X-Tedix-Caller-Source": "http-platform-client",
		};
		if (this.organizationId) {
			headers["X-Tedix-Org-Id"] = this.organizationId;
		}
		if (this.apiAuthMode === "service-binding") {
			headers["X-Service-Binding"] = "true";
			if (this.serviceBindingScopes.length > 0) {
				headers["X-Tedix-Tedi-Scopes"] = this.serviceBindingScopes.join(" ");
			}
			return headers;
		}

		const jwt = await this.getToken();
		headers.Authorization = `Bearer ${jwt}`;
		return headers;
	}

	// ── Descope JWT Exchange ─────────────────────────────────────────────────

	private async getToken(): Promise<string> {
		if (!this.accessKeyExchange) {
			throw new Error("Descope exchange requires project id and access key");
		}
		return this.accessKeyExchange.getToken();
	}
}
