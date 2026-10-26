/**
 * Kernel — context assembly.
 *
 * Gathers a compact, token-bounded snapshot of org state (tedis, apps,
 * active work, top facts, recent rationale, speaker) for the Home route
 * planner, plus a bounded recent transcript of the active Home conversation
 * (read back from the canonical D1 ledger through the extracted
 * `@tedix/tedi-session` harness discipline — see `fetchConversationHistory`).
 * D1 reads and the optional personal-calendar read degrade independently.
 * Provider access remains bound to the admitted human request.
 */

import { listRecentPeopleFacts } from "@tedix/db/queries/memory-entities";
import { resolveKernelConversationAccess } from "../../../kernel/conversation-access";
import { readDraftPreferences } from "../../../services/decision-learning";
import { type ContextCandidateRanker } from "./jev-context-ranking";
import type { DbClient } from "@tedix/db/client";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import { getCapabilityByIdForOrganization } from "@tedix/db/queries/capabilities";
import { listKernelWorkflowCatalog } from "@tedix/db/queries/cognitive/skill-catalog";
import {
	getSkillEntryBySlug,
	isSkillReadableByTedi,
} from "@tedix/db/queries/cognitive/skill-crud";
import {
	type RetrievedSkillMatch,
	SKILL_RETRIEVAL_LIFECYCLE_PRIORITY,
	SKILL_RETRIEVAL_MAX_TOP_K,
	selectSkillsForTurn,
} from "@tedix/context-core/skill-retrieval";
import { parseSkillReferences } from "@tedix/api-contract/utils/skill-reference";
import { listConversationCapabilities } from "@tedix/db/queries/conversation-capabilities";
import { readConversationArtifactPins } from "../../../lib/conversation-artifact-pins";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import {
	summarizeTediSelectionPriors,
	type TediSelectionPrior,
} from "@tedix/db/queries/harness-version/subjects";
import { getFactsByIds } from "@tedix/db/queries/memory-graph/facts";
import { getTopPlatformFacts } from "@tedix/db/queries/memory-graph/platform-facts";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { listRationaleRecords } from "@tedix/db/queries/rationale-records";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import { listWorkItems } from "@tedix/db/queries/work-items/crud";
import { selectKernelConversationIndexPage } from "./conversation-index";
import {
	mentionsWorkRequests,
	type OpenWorkRequest,
	readOpenWorkRequests,
} from "./open-work-requests";
import type { App } from "@tedix/db/schema/apps";
import type { TediSessionMessage } from "@tedix/tedi-session/session-harness";
import {
	type HistorySummarizer,
	type KernelHistoryCheckpoint,
	type StepPressure,
	applyPersistedHistoryCheckpoint,
} from "./context-compaction";
import {
	type CacheTrace,
	createCacheTrace,
	type KernelContextCache,
} from "../../../kernel/context-cache";
import {
	getTediCapabilityCards,
	isKernelVisibleTedi,
	type TediCapabilityCard,
} from "./tedi-capabilities";
import {
	type AgentMemoryCandidate,
	HOME_RELEVANCE_RECALL_CANDIDATE_LIMIT,
	startRelevanceRecall,
} from "../../../integrations/cloudflare/agent-memory";
import type { HomeInventorySnapshot } from "../../../kernel/inventory-snapshot";
import { isMemorySearchFactEligible } from "../../../services/memory-search-filter";
import { recallMemoryFacts } from "../../../services/memory-hybrid-recall";
import type {
	RelevanceRecallOutcome,
	StoredRelevanceRecall,
} from "../../../kernel/relevance-recall-store";

import {
	type ConversationHistoryRead,
	fetchConversationHistory,
} from "./context-history";
import {
	rankHomeContextCandidates,
	applyHomeContextBudget,
	selectionPriorsEnabled,
	DEFAULT_MAX_PROMPT_TOKENS,
	RELEVANCE_RECALL_TOP_K,
	RELEVANCE_RECALL_MIN_CONFIDENCE,
	MESSAGE_RECALL_BUDGET_MS,
	RELEVANCE_RECALL_BUDGET_MS,
	resolveRelevanceCandidates,
} from "./context-relevance";

// ============================================================================
// Public types
// ============================================================================

export function asksPersonalRecall(
	message: string | undefined,
	memberName?: string | null,
): boolean {
	if (
		!message ||
		!/\b(commit(?:ments?|ted|s)?|promis(?:e|ed|es)|meet(?:ings?)?|met|people|follow[ -]?ups?|priorities|schedule|calendar|week|days?)\b/i.test(
			message,
		)
	)
		return false;
	return (
		/\b(I|my|me|mine)\b/i.test(message) ||
		Boolean(
			memberName &&
			memberName.trim().length >= 2 &&
			message.toLowerCase().includes(memberName.trim().toLowerCase()),
		)
	);
}

export interface KernelContext {
	personalRecall?: boolean;
	operatorUserId?: string;
	/** Installation capability, independent of a worker's standby/running state. */
	delegationAvailable?: boolean;
	/** Server-authorized bounded snapshot of the explicitly selected document. */
	selectedWorkspaceDocument?: string | null;
	savedToday?: string | null;
	personalCalendar?: string | null;
	/** Server-validated Workspace selection for this turn. Context only; never authority. */
	workspace?: {
		id: string;
		name: string;
		workpiece?: { kind: "gadget" | "output"; id: string; name: string };
		/** Active references only. These labels and ids grant no file access. */
		resources?: {
			id: string;
			name: string;
			providerId: string;
			resourceType: string;
		}[];
		moreResources?: boolean;
	} | null;
	tedis: {
		id: string;
		slug: string;
		name: string;
		scope?: "personal" | "organization" | null;
		ownerUserId?: string | null;
		role?: string;
		status?: string;
		/**
		 * Bounded capability card sourced from canonical D1 (see
		 * `getTediCapabilityCards`). Enriches the thin tedi entry so the planner's
		 * `delegate_tedi` step can move from recognition to authorized dispatch.
		 * Absent when the capability lookup failed (fail-soft → thin entry only).
		 */
		capability?: TediCapabilityCard;
		/**
		 * Bounded per-tedi delegation success prior derived from the kernel's
		 * tedi-selection eval lane (`summarizeTediSelectionPriors`). Lets past
		 * delegation outcomes bias future selection: surfaced into the roster as a
		 * `track-record=NN% (M turns)` token so the planner weighs it alongside the
		 * static capability card. Absent when priors are disabled, the read failed
		 * (fail-soft), or this tedi has no graded delegations yet — the roster then
		 * renders exactly as before (zero regression).
		 */
		selectionPrior?: { successRate: number; total: number };
	}[];
	apps: {
		slug: string;
		name: string;
		capabilities?: string[];
		/** A Code Mode gateway: it carries Tedix OS writes. Not rendered. */
		codeMode?: true;
	}[];
	/**
	 * Org-wide runnable workflow catalog (slug + title), surfaced so the planner
	 * can ground a `run_workflow` route on a real slug independent of whether a
	 * kernel-visible tedi carries the skill on its capability card. Sourced from
	 * `listKernelWorkflowCatalog`; bounded + deduped by slug.
	 */
	workflows: { slug: string; title: string }[];
	/**
	 * Active named capability references attached to this conversation. These are
	 * revalidated against the organization capability catalog on every turn and
	 * are planner context only: they never add MCP tools, scopes, or FGA grants.
	 */
	conversationCapabilities?: {
		id: string;
		capabilityId: string;
		replayName: string;
		name: string;
		slug: string;
		whyPresent: { type: string; actorId: string; attachedAt: string };
	}[];
	/** Immutable, revalidated artifact revision descriptors; context only. */
	conversationArtifactPins?: {
		id: string;
		artifactId: string;
		replayName: string;
		revision: { algorithm: "sha256"; digest: string };
		artifact: {
			name: string;
			kind: string;
			mimeType: string | null;
			uri: string;
		};
		state: "active" | "stale";
		whyPresent: { type: string; actorId: string; attachedAt: string };
	}[];
	workItems: {
		id: string;
		title: string;
		status: string;
		updatedAt?: string | null;
	}[];
	/**
	 * The organization's recent Home conversations, newest first — the same
	 * rows the conversation list shows. Read only when the operator message
	 * asks about conversations or chats; absent otherwise, so ordinary turns
	 * keep the same prompt.
	 */
	recentConversations?: {
		id: string;
		title: string | null;
		lastMessageAt: string | null;
	}[];
	/** Whether {@link recentConversations} is this workspace's list or the
	 * whole organization's; unset reads as the organization's. */
	recentConversationsScope?: "workspace" | "organization";
	/**
	 * Open Work requests (handoffs, questions, proposals) addressed to the
	 * operator, with the requestId and version a response needs. Read only when
	 * the message mentions them.
	 */
	openWorkRequests?: OpenWorkRequest[];
	facts: { text: string; confidence?: number }[];
	rationale: { action: string; category?: string; outcome?: string }[];
	/**
	 * The acting operator's org membership. `approvalAuthority` is the bounded,
	 * real authority flag derived from the member's org role (owner/admin → true;
	 * member/viewer/absent → false) — threaded into the delegation dispatch gate.
	 * This is only the approval flag, not the full Speaker Authority envelope.
	 */
	speaker: { role?: string; email?: string; approvalAuthority: boolean } | null;
	/**
	 * Bounded recent transcript of this Home conversation (oldest → newest),
	 * read back from the canonical D1 ledger (`kernel_runtime_events`). Empty when
	 * no `conversationId` was provided, the conversation is new, or the
	 * transcript read failed (fail-soft). The current turn's already-persisted
	 * user message is excluded — it reaches the planner separately as the
	 * operator message. Untrusted content: render fenced, never as instructions.
	 *
	 * This is the replay projection, not the canonical transcript. Under budget
	 * pressure the oldest turns are folded into a leading checkpoint message (see
	 * {@link historyCheckpoint} and `context-compaction.ts`); the canonical ledger
	 * rows are never touched, so the UI still pages back through every turn.
	 */
	history: TediSessionMessage[];
	/** Wall time of the assembly waves (stamped on the context manifest). */
	assemblyTimings?: {
		contextReadsMs: number;
		rankingMs: number;
		rankingTimedOut: boolean;
		rankingSkipped: boolean;
	};
	/**
	 * Present when this turn's replay history was compacted: what the leading
	 * checkpoint message stands in for. Observability only — the checkpoint text
	 * itself already rides in {@link history}.
	 */
	historyCheckpoint?: KernelHistoryCheckpoint;
	/**
	 * Provider-reported prompt tokens of the newest persisted assistant step in
	 * this conversation (`message.completed` → `payload.usage.inputTokens`), or
	 * null when the provider reported none. This is the measured number the
	 * per-step pressure check projects the next request from; the caller carries
	 * it forward so a second pass does not re-read the ledger for it.
	 */
	lastStepPromptTokens?: number | null;
	/**
	 * The turn-start estimator's measurement of the whole assembled prompt, in
	 * chars (system-prompt reserve + rendered context + history + operator
	 * message + {@link AssembleHomeContextOptions.extraPromptChars}). Published so
	 * the caller can re-check pressure after it appends to the prompt.
	 */
	promptCharsEstimate?: number;
	/**
	 * How this turn's relevance facts were sourced (`fresh` in-flight recall,
	 * the conversation's `previous` completed recall, or `static` top-N only).
	 * Observability only; stamped into `contextManifest.recall`.
	 */
	relevanceRecall?: RelevanceRecallOutcome;
	/** The per-step verdict this assembly pass measured. Observability only. */
	stepPressure?: StepPressure;
	/**
	 * Skills the operator named outright in this turn's message — the OS
	 * composer's `/skill <slug>` references — resolved against the org-readable
	 * library and fed through the shared act-time retrieval seam
	 * (`@tedix/context-core/skill-retrieval`) rather than a second injection
	 * path. An explicit reference outranks relevance; it does not bypass the
	 * lifecycle gate.
	 *
	 * `unresolved` carries references that resolved to nothing injectable so the
	 * turn can say so. Absent when the message referenced no skills, which is
	 * the overwhelmingly common case and leaves the prompt byte-identical.
	 */
	referencedSkills?: {
		matches: RetrievedSkillMatch[];
		unresolved: string[];
	};
	/**
	 * Which slow-changing inputs this pass served from the per-org cache
	 * (`context-cache.ts`). Stamped into `contextManifest.cache`; never
	 * rendered into the prompt. Absent when assembly ran without a cache.
	 */
	cache?: CacheTrace;
	/**
	 * The conversation's frozen tedi/app/workflow inventory (KernelDO storage),
	 * rendered in place of the live inventory so the stable prefix stays
	 * byte-identical across turns. Set by `runKernel` after assembly.
	 */
	inventorySnapshot?: HomeInventorySnapshot;
	/**
	 * What changed in the live inventory since {@link inventorySnapshot} was
	 * taken. Rendered after the conversation history; absent when nothing did.
	 */
	inventoryChangeNote?: string;
}

// ============================================================================
// Tuning constants (token-bounded prompt rendering)
// ============================================================================

const FACTS_LIMIT = 20;
const WORK_ITEMS_LIMIT = 40;
const RATIONALE_LIMIT = 15;
// Query-scoped retrieval pool: read a wider candidate set, rank by relevance to
// the operator message, and fill the same bounded render slots. The prompt
// shape never grows — only what fills the slots changes (the docs-consistent
// scale answer: bounded card + retrieval behind the card, one LLM pass).
const WORKFLOW_CATALOG_POOL = 120;

const RENDER_CAPABILITIES_CAP = 6;
/**
 * Active (non-terminal) work item statuses. Terminal states (`done`,
 * `cancelled`, `stale`) are excluded so Home only sees live work.
 */
const ACTIVE_WORK_ITEM_STATUSES = new Set(["proposed", "accepted"]);

// ============================================================================
// Helpers
// ============================================================================

type ContextReadSource =
	| "tedis"
	| "apps"
	| "tediCapabilities"
	| "referencedSkill"
	| "workItems"
	| "facts"
	| "messageFacts"
	| "rationale"
	| "workflows"
	| "speaker"
	| "history"
	| "selectionPriors"
	| "conversationCapabilities"
	| "conversationArtifactPins"
	| "workspaceResources"
	| "recentConversations"
	| "openWorkRequests"
	| "personalCalendar";

/**
 * Run a read defensively: any failure degrades to the provided fallback
 * (an empty slice) rather than throwing, keeping the kernel fail-soft.
 */
async function safeRead<T>(
	read: () => Promise<T>,
	fallback: T,
	source: ContextReadSource,
): Promise<T> {
	try {
		return await read();
	} catch (error) {
		console.warn({
			component: "kernel.context",
			event: "read_failed",
			source,
			exception: safeExceptionTopology(error),
		});
		return fallback;
	}
}

/**
 * Derive a compact list of enabled capability flags from an app's structured
 * `AppMetadata.capabilities` object. We surface the primary vertical plus any
 * boolean feature whose `.enabled` flag is set (checkout, cart, wishlist, …)
 * and any top-level boolean flag — enough for the planner to reason about what
 * an app can do without dumping the whole config.
 */
export function deriveAppCapabilities(app: App): string[] | undefined {
	const caps = app.metadata?.capabilities;
	const out: string[] = [];
	if (caps && typeof caps === "object") {
		if (typeof caps.vertical === "string" && caps.vertical.length > 0) {
			out.push(caps.vertical);
		}

		for (const [key, value] of Object.entries(caps)) {
			if (key === "vertical") continue;
			if (value === true) {
				out.push(key);
				continue;
			}
			if (
				value &&
				typeof value === "object" &&
				(value as { enabled?: unknown }).enabled === true
			) {
				out.push(key);
			}
		}
	}

	// Unified gateways expose tenant control-plane tools through Code Mode rather
	// than app_tools rows. Surface narrow routing capabilities; injecting
	// the full aggregate catalog would couple Home prompt size to tool inventory.
	const mcpConfig =
		app.metadata?.mcpConfig && typeof app.metadata.mcpConfig === "object"
			? (app.metadata.mcpConfig as Record<string, unknown>)
			: null;
	const toolScopes =
		mcpConfig?.toolScopes && typeof mcpConfig.toolScopes === "object"
			? (mcpConfig.toolScopes as Record<string, unknown>)
			: null;
	const catalogScopes = Array.isArray(toolScopes?.catalog)
		? toolScopes.catalog
		: [];
	if (
		mcpConfig?.codeMode === true &&
		catalogScopes.includes("mcp:catalog.write")
	) {
		out.push("catalog.install");
	}

	const workScopes = Array.isArray(toolScopes?.work) ? toolScopes.work : [];
	if (mcpConfig?.codeMode === true && workScopes.includes("mcp:work.write")) {
		out.push("work_items.create");
	}

	if (out.length === 0) return undefined;
	return [...new Set(out)].slice(0, RENDER_CAPABILITIES_CAP);
}

function kernelContextApps(appRows: readonly App[]): KernelContext["apps"] {
	return appRows.map((app) => {
		const capabilities = deriveAppCapabilities(app);
		const mcpConfig = app.metadata?.mcpConfig as
			| { codeMode?: unknown }
			| null
			| undefined;
		return {
			slug: app.slug ?? app.id,
			name: app.name,
			...(capabilities ? { capabilities } : {}),
			...(mcpConfig?.codeMode === true ? { codeMode: true as const } : {}),
		};
	});
}

/** Only the organization's apps, from the same per-org cache entry assembly uses. */
export async function readKernelContextApps(
	db: DbClient,
	organizationId: string,
	contextCache?: KernelContextCache,
): Promise<KernelContext["apps"]> {
	const read = () => getAppsByOrganization(db, organizationId);
	return kernelContextApps(
		await (contextCache
			? contextCache.read(organizationId, "apps", read)
			: read()),
	);
}

/**
 * Derive the bounded approval-authority flag from the operator's org member
 * role. Owners and admins carry authority; members, viewers, and an absent
 * member do not. This is the real authority the delegation dispatch gate
 * consumes — not the coarse role-label heuristic it replaced — but it is still
 * only the bounded approval flag, not the full Speaker Authority envelope.
 */
const APPROVAL_AUTHORITY_ROLES = new Set<string>(["owner", "admin"]);

export function deriveApprovalAuthority(
	role: string | null | undefined,
): boolean {
	return role ? APPROVAL_AUTHORITY_ROLES.has(role) : false;
}

// ============================================================================
// ============================================================================
// Assembly
// ============================================================================

const CONVERSATION_CAPABILITIES_LIMIT = 20;

async function fetchActiveConversationCapabilities(
	db: DbClient,
	organizationId: string,
	conversationId: string,
): Promise<KernelContext["conversationCapabilities"]> {
	const references = (
		await listConversationCapabilities(db, { organizationId, conversationId })
	).slice(0, CONVERSATION_CAPABILITIES_LIMIT);
	const capabilities = await Promise.all(
		references.map(async (reference) => {
			const capability = await getCapabilityByIdForOrganization(
				db,
				organizationId,
				reference.capabilityId,
			);
			if (!capability || capability.status !== "active") return null;
			return {
				id: reference.id,
				capabilityId: reference.capabilityId,
				replayName: reference.replayName,
				name: capability.name,
				slug: capability.slug,
				whyPresent: {
					type: reference.attachedByType,
					actorId: reference.attachedById,
					attachedAt: reference.createdAt,
				},
			};
		}),
	);
	return capabilities.filter(
		(value): value is NonNullable<typeof value> => value !== null,
	);
}

/**
 * Can this row back an operator `/skill <slug>` reference on a Home turn?
 *
 * One predicate, used by both the enqueue-time validation and the planning-time
 * injection, so "the composer accepted it" and "the turn loaded it" can never
 * disagree. Two gates, both load-bearing:
 *
 *  - Scope: `isSkillReadableByTedi(row)` with no tedi — the un-widened half of
 *    `readableSkillCondition`. Home has no single fixed tedi, so only org-level
 *    non-private rows are readable. This is also what stops a reference from
 *    being used to probe another tedi's private library.
 *  - Lifecycle: the same `SKILL_RETRIEVAL_LIFECYCLE_PRIORITY` table the act-time
 *    retriever gates on. A draft, stale, or archived skill never passed the
 *    execute-to-promote gate and carries no evidence to steer a turn, so naming
 *    it explicitly does not make it injectable.
 */
export function isInjectableSkillReference(
	row:
		| {
				tediId?: string | null;
				visibility: string;
				lifecycleState?: string | null;
		  }
		| undefined,
): boolean {
	if (!row) return false;
	if (
		!isSkillReadableByTedi(row as Parameters<typeof isSkillReadableByTedi>[0])
	)
		return false;
	return (
		SKILL_RETRIEVAL_LIFECYCLE_PRIORITY[row.lifecycleState ?? ""] !== undefined
	);
}

/**
 * Referenced slugs in `content` that do not resolve to an injectable skill.
 *
 * Used by the enqueue path to refuse a turn whose reference would silently do
 * nothing. Returns `[]` for a message with no references, and performs no reads
 * in that case — the overwhelmingly common path.
 */
export async function unresolvedSkillReferences(
	db: DbClient,
	organizationId: string,
	content: string,
): Promise<string[]> {
	const slugs = parseSkillReferences(content).slice(
		0,
		SKILL_RETRIEVAL_MAX_TOP_K,
	);
	if (slugs.length === 0) return [];
	const rows = await Promise.all(
		slugs.map((slug) =>
			safeRead(
				() => getSkillEntryBySlug(db, organizationId, slug),
				undefined,
				"referencedSkill",
			),
		),
	);
	return slugs.filter((_, index) => !isInjectableSkillReference(rows[index]));
}

/** Recent conversations rendered when the operator asks about them. */
const RECENT_CONVERSATIONS_LIMIT = 40;
const CONVERSATION_LIST_REQUEST_RE =
	/\b(?:conversations|chats|threads|chat history|my (?:conversation|chat|thread))\b/i;

/** Whether this message asks about the operator's conversations as a set. */
export function asksAboutConversations(message: string | undefined): boolean {
	return Boolean(message && CONVERSATION_LIST_REQUEST_RE.test(message));
}

const THIS_WORKSPACE_RE =
	/\b(?:(?:this|the|current|our)\s+workspace|in\s+here)\b/i;

/**
 * The workspace a conversation list is scoped to: the selected workspace when
 * the message asks about "this workspace", otherwise none (the whole
 * organization).
 */
export function conversationListWorkspaceId(
	message: string | undefined,
	selectedWorkspaceId: string | undefined,
): string | undefined {
	return selectedWorkspaceId && message && THIS_WORKSPACE_RE.test(message)
		? selectedWorkspaceId
		: undefined;
}

export async function assembleHomeContext(
	db: DbClient,
	organizationId: string,
	opts?: {
		delegationAvailable?: boolean;
		descopeUserId?: string;
		/** Home conversation id — enables the bounded turn-history section. */
		conversationId?: string;
		/** Ledger message id of the current turn's already-persisted user
		 * message (persist-first ordering) — excluded from history so it is not
		 * duplicated alongside the operator message. */
		excludeMessageId?: string;
		/**
		 * Token budget for the assembled prompt (char/4 heuristic), measured
		 * against the window of the model that will actually serve this turn.
		 * Crossing COMPACTION_TRIGGER_RATIO of it folds the oldest turns into a
		 * checkpoint; only a prompt whose fixed sections still will not fit falls
		 * through to section truncation (history → facts → rationale).
		 *
		 * Defaults to {@link DEFAULT_MAX_PROMPT_TOKENS} (the Azure window minus the
		 * completion reserve). Callers on the Workers AI fallback lane must pass
		 * `maxPromptTokensForWindow(WORKERS_AI_CONTEXT_WINDOW_TOKENS)` — its window
		 * is 24 000 tokens, and an Azure-sized prompt would overflow it.
		 */
		maxPromptTokens?: number;
		/**
		 * Model seam for history compaction. When the assembled prompt approaches
		 * the budget, the oldest turns are folded into a checkpoint instead of
		 * being erased; this call produces its summary. Fail-soft: absent, empty,
		 * or throwing degrades to the deterministic extractive digest — the turn
		 * never fails and history is never silently emptied while it still fits.
		 */
		summarizeHistory?: HistorySummarizer;
		/**
		 * Fold on this pass regardless of what the estimator measures. Set by the
		 * caller's per-step re-check (`runKernel`) when the request it is about to
		 * send crossed the trigger after assembly measured it — the pass that
		 * detected the pressure ends without prompting, and this is the reload.
		 */
		forceCompaction?: boolean;
		/**
		 * Chars the caller will append to the prompt after assembly returns
		 * (hydrated attachment bodies). Counted by the estimator so the trigger
		 * measures the whole request, not the part assembly happens to own.
		 */
		extraPromptChars?: number;
		/**
		 * Override for the last persisted step's provider-reported prompt tokens.
		 * `undefined` reads it from the ledger rows this pass already loads;
		 * `null` states explicitly that the provider reported none (the caller then
		 * gets the `remeasure` verdict). Used by the caller's second pass so a
		 * reload does not re-derive a number it already holds.
		 */
		measuredPromptTokens?: number | null;
		/** Agent Memory binding used only to retrieve canonical fact IDs. */
		agentMemory?: AgentMemoryNamespace;
		/**
		 * A semantic recall already in flight for this turn (started at DO ingress
		 * by `KernelDO.processTurn`, before the turn body's module imports). When
		 * present it replaces the in-assembly `agentMemory` recall, so the
		 * multi-second model-backed call overlaps the pre-planning gap instead of
		 * starting here. Must never reject (see `startRelevanceRecall`).
		 */
		relevanceCandidates?: Promise<AgentMemoryCandidate[]>;
		/**
		 * The conversation's last completed recall (KernelDO storage), already
		 * validated against the age cap. Blended when the in-flight recall is not
		 * settled inside the budget.
		 */
		previousRelevanceRecall?: StoredRelevanceRecall | null;
		/**
		 * The conversation's last persisted compaction checkpoint (KernelDO
		 * storage). Replayed in place of the messages it folded when it still
		 * lines up with the canonical history; otherwise ignored.
		 */
		previousHistoryCheckpoint?: KernelHistoryCheckpoint | null;
		/**
		 * Critical-path wait for the candidate-ranking wave, ms. Default
		 * {@link CONTEXT_RANKING_BUDGET_MS}; `0` skips the reranks (lexical
		 * orders, no Jev calls) for this turn.
		 */
		rankingBudgetMs?: number;
		/** Override of {@link RELEVANCE_RECALL_BUDGET_MS} (env / tests). */
		relevanceRecallBudgetMs?: number;
		/** Injectable epoch-ms clock for recall age/wait accounting (tests). */
		now?: () => number;
		/**
		 * The current operator's message text. Used as the query for semantic
		 * relevance recall when {@link agentMemory} is present.
		 */
		operatorMessage?: string;
		/** Optional paid relevance ordering; never changes candidate eligibility. */
		candidateRanker?: ContextCandidateRanker;
		/** Canonical ids/names resolved at Home ingress, never raw browser metadata. */
		workspaceContext?: {
			workspaceId: string;
			workspaceName: string;
			workpiece?: { kind: "gadget" | "output"; id: string; name: string };
		};
		selectedWorkspaceDocument?: string | null;
		readPersonalCalendar?: (apps: App[]) => Promise<string>;
		/**
		 * Per-org TTL cache for the slow-changing inputs (roster, apps, workflow
		 * catalogue, priors, member row, workspace resources, capability-card
		 * pieces). Supplied by the org `KernelDO`; absent (tests, the inline
		 * fallback path) every read goes to D1 as before. Per-turn inputs —
		 * history, work items, facts, recall, conversation state, referenced
		 * skills, the selected document — are never cached.
		 */
		contextCache?: KernelContextCache;
	},
): Promise<KernelContext> {
	const descopeUserId = opts?.descopeUserId;
	const memberPromise = descopeUserId
		? safeRead(
				() => getMemberByUserId(db, organizationId, descopeUserId),
				undefined,
				"speaker",
			)
		: Promise.resolve(undefined);
	const personalRecallPromise = memberPromise.then(
		(member) =>
			member?.status === "active" &&
			asksPersonalRecall(opts?.operatorMessage, member.name),
	);
	const savedToday = personalRecallPromise.then((personalRecall) =>
		descopeUserId &&
		(personalRecall ||
			/\b(today|progress|purpose|goals?)\b/i.test(opts?.operatorMessage ?? ""))
			? import("./today-context")
					.then(({ readSavedToday }) =>
						readSavedToday(db, organizationId, descopeUserId),
					)
					.catch(() => null)
			: null,
	);
	const peopleFactsPromise = personalRecallPromise.then((personalRecall) =>
		personalRecall
			? safeRead(
					() =>
						listRecentPeopleFacts(db, {
							organizationId,
							since: new Date(
								(opts?.now?.() ?? Date.now()) - 7 * 24 * 60 * 60 * 1000,
							).toISOString(),
						}),
					[],
					"facts",
				)
			: [],
	);
	const contextCache = opts?.contextCache;
	const cacheTrace = contextCache ? createCacheTrace() : undefined;
	// Cached entries resolve immediately inside the same parallel wave; a miss
	// runs the very same query the uncached path runs.
	const cached = <T>(key: string, read: () => Promise<T>): Promise<T> =>
		contextCache
			? contextCache.read(organizationId, key, read, cacheTrace)
			: read();
	const conversationId = opts?.conversationId;
	const maxPromptTokens = opts?.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS;
	const extraPromptChars = Math.max(0, opts?.extraPromptChars ?? 0);
	const operatorMessage = opts?.operatorMessage;
	const agentMemory = opts?.agentMemory;
	const selectedWorkspaceId = opts?.workspaceContext?.workspaceId;
	const workspace: KernelContext["workspace"] = opts?.workspaceContext
		? {
				id: opts.workspaceContext.workspaceId,
				name: opts.workspaceContext.workspaceName,
				...(opts.workspaceContext.workpiece
					? { workpiece: opts.workspaceContext.workpiece }
					: {}),
			}
		: null;

	// Start every independent read in the first D1 wave. Capability cards still
	// depend on tedis + apps, but chaining that one read behind their promises
	// avoids holding unrelated work/fact/rationale/workflow/member/history reads
	// until the roster arrives. Production stage timings showed that the former
	// two-wave barrier cost 4.2s before the planner could start.
	const tediRowsPromise = safeRead(
		() => cached("tedis", () => getTedisByOrganization(db, organizationId)),
		[],
		"tedis",
	);
	const appRowsPromise = safeRead(
		() => cached("apps", () => getAppsByOrganization(db, organizationId)),
		[],
		"apps",
	);
	const personalCalendarPromise = Promise.all([
		personalRecallPromise,
		appRowsPromise,
	]).then(([personalRecall, apps]) =>
		personalRecall && opts?.readPersonalCalendar
			? safeRead(
					() => opts.readPersonalCalendar!(apps),
					"Calendar read unavailable",
					"personalCalendar",
				)
			: null,
	);
	const visibleTediRowsPromise = Promise.all([
		tediRowsPromise,
		personalRecallPromise,
	]).then(([rows, personalRecall]) =>
		rows.filter(
			(tedi) =>
				isKernelVisibleTedi(tedi) &&
				(!personalRecall ||
					tedi.scope !== "personal" ||
					Boolean(descopeUserId && tedi.ownerUserId === descopeUserId)),
		),
	);

	// Tedis + apps are read once and reused here, so capability enrichment adds
	// only its own skills + policy-pack reads — no duplicate roster queries.
	const capabilityCardsPromise = Promise.all([
		visibleTediRowsPromise,
		appRowsPromise,
	]).then(([tedis, apps]) =>
		safeRead(
			() =>
				getTediCapabilityCards(db, organizationId, {
					tedis,
					apps,
					...(contextCache
						? { cache: { cache: contextCache, trace: cacheTrace } }
						: {}),
				}),
			[] as TediCapabilityCard[],
			"tediCapabilities",
		),
	);
	type FlatFact = { id: string; text: string; confidence?: number };
	// Semantic recall is independent of the roster and every other context read.
	// Start both its vector lookup and canonical D1 hydration in the first wave;
	// awaiting it after the main Promise.all serialized the whole path behind the
	// slowest inventory read even though no data dependency exists. Authorization
	// remains unchanged: Agent Memory contributes ids only, and D1 still hydrates
	// and filters every candidate before any content reaches the prompt.
	// The recall itself is model-backed and multi-second (see
	// RELEVANCE_RECALL_BUDGET_MS); prefer one started at DO ingress, else start
	// it here. Whatever has not settled inside the budget is replaced by the
	// conversation's previous completed recall, else static facts.
	const candidatesInFlight: Promise<AgentMemoryCandidate[]> | null =
		opts?.relevanceCandidates ??
		(agentMemory && operatorMessage?.trim()
			? startRelevanceRecall(agentMemory, {
					orgId: organizationId,
					query: operatorMessage,
					limit: HOME_RELEVANCE_RECALL_CANDIDATE_LIMIT,
				})
			: null);
	let relevanceRecall: RelevanceRecallOutcome = {
		source: "static",
		ageMs: null,
		candidates: 0,
		waitedMs: 0,
	};
	const relevanceFactsPromise: Promise<FlatFact[]> =
		candidatesInFlight || opts?.previousRelevanceRecall
			? (async () => {
					try {
						const resolved = await resolveRelevanceCandidates({
							inFlight: candidatesInFlight,
							previous: opts?.previousRelevanceRecall,
							budgetMs:
								opts?.relevanceRecallBudgetMs ?? RELEVANCE_RECALL_BUDGET_MS,
							now: opts?.now ?? Date.now,
						});
						relevanceRecall = resolved.outcome;
						const candidates = resolved.candidates;
						if (candidates.length === 0) return [];
						const hydrated = await getFactsByIds(
							db,
							candidates.map((candidate) => candidate.factId),
						);
						const byId = new Map(hydrated.map((fact) => [fact.id, fact]));
						return candidates
							.map((candidate) => byId.get(candidate.factId))
							.filter((fact): fact is NonNullable<typeof fact> => Boolean(fact))
							.filter((fact) =>
								isMemorySearchFactEligible(fact, {
									orgId: organizationId,
									minConfidence: RELEVANCE_RECALL_MIN_CONFIDENCE,
								}),
							)
							.slice(0, RELEVANCE_RECALL_TOP_K)
							.map((fact) => ({
								id: fact.id,
								text: fact.content,
								confidence: fact.confidence,
							}));
					} catch (error) {
						console.error({
							component: "kernel.context",
							event: "memory_hydration_failed",
							exception: safeExceptionTopology(error),
						});
						return [];
					}
				})()
			: Promise.resolve([]);
	// The semantic recall above usually belongs to the previous turn (its budget
	// is 0; see RELEVANCE_RECALL_BUDGET_MS). Rank canonical D1 memory against
	// THIS message too: BM25, entity and calendar arms answer in milliseconds,
	// so an exact topic or a date cue reaches the prompt on the turn it is asked.
	const messageFactsPromise: Promise<FlatFact[]> = operatorMessage?.trim()
		? safeRead(
				async () =>
					(
						await recallMemoryFacts(db, {
							orgId: organizationId,
							query: operatorMessage,
							topK: RELEVANCE_RECALL_TOP_K,
							budgetMs: MESSAGE_RECALL_BUDGET_MS,
							minConfidence: RELEVANCE_RECALL_MIN_CONFIDENCE,
						})
					)
						.filter(({ fact }) =>
							isMemorySearchFactEligible(fact, {
								orgId: organizationId,
								minConfidence: RELEVANCE_RECALL_MIN_CONFIDENCE,
							}),
						)
						.map(({ fact }) => ({
							id: fact.id,
							text: fact.content,
							confidence: fact.confidence,
						})),
				[],
				"messageFacts",
			)
		: Promise.resolve([]);

	// Operator skill references (`/skill <slug>`). Bounded by the shared top-K
	// ceiling so a pasted wall of references cannot turn one turn into an
	// unbounded fan-out of reads; the remainder is reported unresolved rather
	// than silently ignored. Each read is a single indexed slug lookup and joins
	// the same first wave as every other assembly read.
	const referencedSlugs = parseSkillReferences(operatorMessage ?? "");
	const injectableSlugs = referencedSlugs.slice(0, SKILL_RETRIEVAL_MAX_TOP_K);
	const referencedSkillRowsPromise =
		injectableSlugs.length > 0
			? Promise.all(
					injectableSlugs.map((slug) =>
						safeRead(
							() => getSkillEntryBySlug(db, organizationId, slug),
							undefined,
							"referencedSkill",
						),
					),
				)
			: Promise.resolve([]);

	// Home has no conversation-list tool; the list rides in context instead,
	// only on turns that ask about it.
	const conversationListWorkspace = conversationListWorkspaceId(
		operatorMessage,
		selectedWorkspaceId,
	);
	const recentConversationsPromise = personalRecallPromise.then(
		async (personalRecall) => {
			if (!personalRecall && !asksAboutConversations(operatorMessage))
				return null;
			const rows = await safeRead(
				() =>
					selectKernelConversationIndexPage(db, {
						organizationId,
						cursor: null,
						limit: personalRecall ? 12 : RECENT_CONVERSATIONS_LIMIT,
						...(!personalRecall && conversationListWorkspace
							? { workspaceId: conversationListWorkspace }
							: {}),
					}),
				[],
				"recentConversations",
			);
			const cutoff = (opts?.now?.() ?? Date.now()) - 7 * 24 * 60 * 60 * 1000;
			const eligible = personalRecall
				? rows.filter(
						(row) =>
							row.lastMessageAt && Date.parse(row.lastMessageAt) >= cutoff,
					)
				: rows;
			const access = await Promise.all(
				eligible.map((row) =>
					resolveKernelConversationAccess(db, {
						organizationId,
						conversationId: row.conversationId,
						descopeUserId,
						required: "read",
					}),
				),
			);
			return eligible.filter((_, index) => access[index]?.allowed);
		},
	);
	const openWorkRequestsPromise = personalRecallPromise.then(
		(personalRecall) =>
			descopeUserId && (personalRecall || mentionsWorkRequests(operatorMessage))
				? safeRead(
						() => readOpenWorkRequests(db, { organizationId, descopeUserId }),
						[],
						"openWorkRequests",
					)
				: null,
	);
	// Its own two serial reads overlap the first wave instead of following it.
	const draftPreferencesPromise = descopeUserId
		? readDraftPreferences(db, organizationId, descopeUserId)
		: Promise.resolve(null);

	const readsStartedAtMs = Date.now();
	const [
		visibleTediRows,
		appRows,
		capabilityCards,
		workItemsResult,
		factRows,
		rationaleResult,
		workflowCatalog,
		member,
		historyRead,
		selectionPriors,
		relevanceFacts,
		messageFacts,
		conversationCapabilities,
		conversationArtifactPins,
		referencedSkillRows,
		workspaceResourceRows,
	] = await Promise.all([
		visibleTediRowsPromise,
		appRowsPromise,
		capabilityCardsPromise,
		safeRead(
			() =>
				listWorkItems(db, { orgId: organizationId, limit: WORK_ITEMS_LIMIT }),
			[],
			"workItems",
		),
		safeRead(
			() => getTopPlatformFacts(db, organizationId, { limit: FACTS_LIMIT }),
			[],
			"facts",
		),
		safeRead(
			() =>
				listRationaleRecords(db, {
					orgId: organizationId,
					limit: RATIONALE_LIMIT,
				}),
			{ data: [], total: 0 },
			"rationale",
		),
		safeRead(
			() =>
				cached("workflows", () =>
					listKernelWorkflowCatalog(db, organizationId, {
						// Wider pool than the render cap — ranked down to
						// WORKFLOW_CATALOG_LIMIT by relevance to the operator message below.
						limit: WORKFLOW_CATALOG_POOL,
					}),
				),
			[] as { slug: string; title: string }[],
			"workflows",
		),
		memberPromise,
		conversationId
			? safeRead(
					() =>
						fetchConversationHistory(
							db,
							organizationId,
							conversationId,
							opts?.excludeMessageId,
						),
					{
						messages: [] as TediSessionMessage[],
						lastStepPromptTokens: null,
					} satisfies ConversationHistoryRead,
					"history",
				)
			: Promise.resolve({
					messages: [] as TediSessionMessage[],
					lastStepPromptTokens: null,
				} satisfies ConversationHistoryRead),
		// Per-tedi delegation success priors (one bounded indexed read). Gated by
		// KERNEL_SELECTION_PRIORS; fail-soft → empty Map leaves the roster as-is.
		selectionPriorsEnabled()
			? safeRead(
					() =>
						cached("selectionPriors", () =>
							summarizeTediSelectionPriors(db, { orgId: organizationId }),
						),
					new Map<string, TediSelectionPrior>(),
					"selectionPriors",
				)
			: Promise.resolve(new Map<string, TediSelectionPrior>()),
		relevanceFactsPromise,
		messageFactsPromise,
		conversationId
			? safeRead(
					() =>
						fetchActiveConversationCapabilities(
							db,
							organizationId,
							conversationId,
						),
					[],
					"conversationCapabilities",
				)
			: Promise.resolve([] as KernelContext["conversationCapabilities"]),
		conversationId
			? safeRead(
					() =>
						readConversationArtifactPins(db, {
							organizationId,
							conversationId,
						}),
					[],
					"conversationArtifactPins",
				)
			: Promise.resolve([] as KernelContext["conversationArtifactPins"]),
		referencedSkillRowsPromise,
		selectedWorkspaceId
			? safeRead(
					() =>
						cached(`workspaceResources:${selectedWorkspaceId}`, () =>
							listOsWorkspaceResources(db, {
								organizationId,
								workspaceId: selectedWorkspaceId,
								status: "active",
								limit: 13,
							}),
						),
					[],
					"workspaceResources",
				)
			: Promise.resolve(
					[] as Awaited<ReturnType<typeof listOsWorkspaceResources>>,
				),
	]);
	const recentConversationRows = await recentConversationsPromise;
	const openWorkRequests = await openWorkRequestsPromise;
	const contextReadsMs = Date.now() - readsStartedAtMs;
	if (workspace) {
		workspace.resources = workspaceResourceRows
			.slice(0, 12)
			.map((resource) => ({
				id: resource.id,
				name: resource.name,
				providerId: resource.providerId,
				resourceType: resource.resourceType,
			}));
		workspace.moreResources = workspaceResourceRows.length > 12;
	}

	/**
	 * Resolve the operator's references through the shared retrieval seam — the
	 * same retrieve leg the Agent runtime uses, given a stronger signal, not a
	 * second injection path. A row that fails
	 * {@link isInjectableSkillReference} is treated as absent and reported
	 * unresolved.
	 */
	const referencedSkills: KernelContext["referencedSkills"] =
		referencedSlugs.length > 0
			? (() => {
					const corpus = referencedSkillRows
						.filter((row): row is NonNullable<typeof row> =>
							isInjectableSkillReference(row),
						)
						.map((row) => ({
							id: row.id,
							slug: row.slug,
							title: row.title,
							summary: row.summary,
							description: row.description,
							tags: row.tags,
							toolIds: row.toolIds,
							lifecycleState: row.lifecycleState,
							successCount: row.successCount,
							failureCount: row.failureCount,
							lastUsedAt: row.lastUsedAt,
							content: row.content,
							preconditions: row.preconditions,
						}));
					const selection = selectSkillsForTurn(corpus, operatorMessage ?? "", {
						referencedSlugs: injectableSlugs,
						topK: SKILL_RETRIEVAL_MAX_TOP_K,
					});
					return {
						matches: selection.matches,
						// References past the ceiling never got a read; they are
						// unresolved for this turn and the operator is told so.
						unresolved: [
							...selection.unresolvedReferences,
							...referencedSlugs.slice(SKILL_RETRIEVAL_MAX_TOP_K),
						],
					};
				})()
			: undefined;

	const cardByTediId = new Map(
		capabilityCards.map((card) => [card.tediId, card]),
	);
	const tedis: KernelContext["tedis"] = visibleTediRows.map((tedi) => {
		const capability = cardByTediId.get(tedi.id);
		const prior = selectionPriors.get(tedi.id);
		return {
			id: tedi.id,
			slug: tedi.slug,
			name: tedi.displayName || tedi.name || tedi.slug,
			scope: tedi.scope,
			ownerUserId: tedi.ownerUserId,
			...(tedi.runtimeKind ? { role: tedi.runtimeKind } : {}),
			...(tedi.status ? { status: tedi.status } : {}),
			...(capability ? { capability } : {}),
			...(prior
				? {
						selectionPrior: {
							successRate: prior.successRate,
							total: prior.total,
						},
					}
				: {}),
		};
	});

	const apps = kernelContextApps(appRows);

	const workItems: KernelContext["workItems"] = workItemsResult
		.filter((item) => ACTIVE_WORK_ITEM_STATUSES.has(item.disposition))
		.slice(0, WORK_ITEMS_LIMIT)
		.map((item) => ({
			id: item.id,
			title: item.title,
			status: item.disposition,
			updatedAt: item.updatedAt,
		}));

	// ── Relevance recall: bounded semantic search (fail-soft) ────────────────
	// Results are blended ahead of the static top-N and deduped by factId so
	// the total set fed into the render cap is relevance-first, then priority-
	// ranked static facts for any remaining slots.
	// Build flat static facts from getTopPlatformFacts (unchanged shape).
	const staticFacts: FlatFact[] = factRows
		.filter((row) =>
			isMemorySearchFactEligible(row.fact, { orgId: organizationId }),
		)
		.map((row) => ({
			id: row.fact.id,
			text: row.fact.content,
			...(typeof row.fact.confidence === "number"
				? { confidence: row.fact.confidence }
				: {}),
		}));

	// Blend: relevance facts first, then static facts, deduped by id.
	const seenFactIds = new Set<string>();
	const blendedFacts: FlatFact[] = [];
	const peopleFacts: FlatFact[] = (await peopleFactsPromise)
		.filter((fact) =>
			isMemorySearchFactEligible(fact, { orgId: organizationId }),
		)
		.slice(0, 8)
		.map((fact) => ({
			id: fact.id,
			text: `[${fact.updatedAt ?? fact.createdAt}] ${fact.content}`,
			confidence: fact.confidence,
		}));
	for (const f of [
		...peopleFacts,
		...relevanceFacts,
		...messageFacts,
		...staticFacts,
	]) {
		if (!seenFactIds.has(f.id)) {
			seenFactIds.add(f.id);
			blendedFacts.push(f);
		}
	}

	const rationale: KernelContext["rationale"] = rationaleResult.data.map(
		(record) => ({
			action: record.action,
			...(record.category ? { category: record.category } : {}),
			...(record.outcome ? { outcome: record.outcome } : {}),
		}),
	);

	const speaker: KernelContext["speaker"] =
		member?.status === "active"
			? {
					...(member.role ? { role: member.role } : {}),
					...(member.email ? { email: member.email } : {}),
					approvalAuthority: deriveApprovalAuthority(member.role),
				}
			: null;

	const {
		rankedWorkflows,
		rankedTedis,
		rankedFacts,
		rankedRationale,
		rankingMs,
		rankingTimedOut,
		rankingSkipped,
	} = await rankHomeContextCandidates(
		workflowCatalog,
		tedis,
		blendedFacts,
		rationale,
		operatorMessage,
		opts,
	);
	// Internal fact IDs are used solely to validate the permutation; the prompt
	// keeps its existing shape and only receives visible content and confidence.
	const facts: KernelContext["facts"] = rankedFacts.map(
		({ text, confidence }) => ({
			text,
			...(typeof confidence === "number" ? { confidence } : {}),
		}),
	);

	const preferences = await draftPreferencesPromise;
	if (preferences) facts.unshift({ text: preferences });

	// Persisted checkpoint first: the replay is the checkpoint message plus the
	// messages after its fold, so a settled compaction stays settled across
	// turns instead of being recomputed from the full ledger every time.
	const persistedReplay = opts?.previousHistoryCheckpoint
		? applyPersistedHistoryCheckpoint(
				historyRead.messages,
				opts.previousHistoryCheckpoint,
			)
		: null;
	const draftCtx: KernelContext = {
		personalRecall: await personalRecallPromise,
		...(member?.status === "active" && descopeUserId
			? { operatorUserId: descopeUserId }
			: {}),
		selectedWorkspaceDocument: opts?.selectedWorkspaceDocument ?? null,
		savedToday: await savedToday,
		personalCalendar: await personalCalendarPromise,
		delegationAvailable: opts?.delegationAvailable,
		...(cacheTrace ? { cache: cacheTrace } : {}),
		workspace,
		tedis: (await personalRecallPromise)
			? [...rankedTedis].sort(
					(a, b) =>
						Number(b.scope === "personal" && b.ownerUserId === descopeUserId) -
						Number(a.scope === "personal" && a.ownerUserId === descopeUserId),
				)
			: rankedTedis,
		apps,
		workflows: rankedWorkflows,
		conversationCapabilities,
		conversationArtifactPins,
		workItems,
		...(recentConversationRows
			? {
					recentConversations: recentConversationRows.map((row) => ({
						id: row.conversationId,
						title: row.title ?? null,
						lastMessageAt: row.lastMessageAt ?? null,
					})),
					recentConversationsScope: conversationListWorkspace
						? ("workspace" as const)
						: ("organization" as const),
				}
			: {}),
		...(openWorkRequests ? { openWorkRequests } : {}),
		facts,
		rationale: rankedRationale,
		speaker,
		assemblyTimings: {
			contextReadsMs,
			rankingMs,
			rankingTimedOut,
			rankingSkipped,
		},
		history: persistedReplay ?? historyRead.messages,
		...(persistedReplay && opts?.previousHistoryCheckpoint
			? { historyCheckpoint: opts.previousHistoryCheckpoint }
			: {}),
		// On draftCtx deliberately, so `estimateContextChars` — which renders the
		// context — measures the injected procedure as part of the real prompt
		// and the compaction trigger fires against it like any other section.
		...(referencedSkills ? { referencedSkills } : {}),
	};

	return applyHomeContextBudget(
		draftCtx,
		maxPromptTokens,
		extraPromptChars,
		operatorMessage,
		historyRead,
		relevanceRecall,
		opts,
	);
}
