import { guardKernelRouteDecision } from "./delegation-intent";
import { createJevContextRanker } from "./jev-context-ranking";
import { createJevDelegationRanker } from "./jev-delegation-fit";
import type { KernelExecutionAttempt } from "./gateway-attribution";
/**
 * Kernel — orchestrator.
 *
 * LLM-backed typed route planner with one bounded, context-grounded roster
 * answer. Wires the leaf
 * modules together:
 *
 *   kernelModel(env)        — fail-soft Azure chat model (null when unconfigured)
 *   assembleHomeContext(db, …)  — cheap, single-indexed D1 org snapshot
 *
 * Compaction is checked per step, not per turn. `runKernel` owns the pass loop:
 * assemble + measure + fold, hydrate the attachment bodies, then re-check the
 * request it is about to send against the last persisted step's measured
 * provider usage. A pass that finds pressure ends without prompting and reloads;
 * only a pass that clears the trigger reaches `planKernelRoute`. The provider
 * overflow retry below it is the backstop, not the routine path.
 *   planKernelRoute({ … })        — Azure → Workers AI typed KernelRouteDecision (null only when both fail)
 *   renderRouteResponse(route)  — routeKind → concise, operator-grade message
 *
 * LLM-only: when every routing model fails (Azure + Workers AI fallback both
 * unavailable), `planKernelRoute` returns `null` and `runKernel` returns `null`.
 * The caller then settles the turn `failed` with a clear "model unavailable"
 * notice — there is no heuristic responder, so a provider/gateway outage is
 * legible instead of masked. The Home Kernel is deliberately not a deploy gate
 * (authenticated AI Gateway BYOK is required for Azure routing).
 *
 * Scope: produces a typed route decision + rationale, prepares write proposals
 * behind approval, and records delegation work orders + dispatch verdicts.
 * The kernel is a pure router — it never executes provider reads itself; all
 * live data access is delegated to the owning tedi. Supervised child dispatch
 * is performed by the kernel-runtime turn body when the verdict and feature
 * gates allow it; this module stays the pure planner/orchestrator.
 */

import { isContextOverflowError } from "@tedix/context-core/context-overflow";
import { isLocalDemoProject } from "@tedix/auth/local-demo";
import type { AgentMemoryCandidate } from "../../../integrations/cloudflare/agent-memory";
import { kernelServesWorkersAiLane } from "./llm";
import type { DbClient } from "@tedix/db/client";
import type { TediMessageAttachment } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	homeAttachmentContent,
	hydrateHomeHistory,
	type HomeAttachmentResolver,
} from "./attachment-content";
import { chunkAnswerForDelivery } from "./answer-delivery";
import {
	assembleHomeContext,
	DEFAULT_MAX_PROMPT_TOKENS,
	type KernelContext,
	maxPromptTokensForWindow,
	WORKERS_AI_CONTEXT_WINDOW_TOKENS,
} from "./context-assembly";
import {
	assessStepPressure,
	getHistoryTokenLimits,
	historyReplayChars,
} from "./context-compaction";
import {
	buildDelegationWorkOrder,
	type DelegationWorkOrder,
	type DispatchDecision,
	decideDelegationDispatch,
	deriveExecutionRequirement,
} from "./delegation-dispatch";
import {
	type DispatchPolicyLayer,
	resolveEarnedDelegationEnforcement,
} from "./dispatch-policy";
import { groundedRosterDecision } from "./grounded-roster";
import { createKernelHistorySummarizer } from "./history-summarizer";
import type { KernelEnv } from "./llm";
import { kernelModel } from "./llm";
import type { KernelRouteTraceInput, KernelRouteUsage } from "./route-planner";
import { planKernelRoute } from "./route-planner";
import type { KernelRouteDecision } from "./route-schema";
import { readOrgDispatchPolicyLayer } from "./tedi-capabilities";
import {
	type HomeDelegationAgentReview,
	type ResolvedDelegationApprover,
	renderHeldDelegationLine,
	resolveDelegationApprover,
} from "./delegation-approver";
// Type-only (erased — no runtime cycle): shared progress contract so the
// forwarded executor progress carries structured per-tool events.
import type { KernelTurnProgress } from "./turn-work";
import type { KernelWriteProposalDeclined } from "./write-proposal";
import { renderWriteDeclined } from "./write-proposal";

export interface KernelResult {
	assistantContent: string;
	route: KernelRouteDecision;
	/**
	 * Present when a `delegate_tedi` route resolved a target tedi that carries a
	 * capability card. Records the constructed work order + the fail-closed
	 * auto-dispatch decision as durable evidence. The kernel-runtime turn body
	 * consumes this verdict and may spawn a supervised child run when the gate
	 * returns `auto` and autonomous dispatch is enabled.
	 */
	delegation?: HomeDelegationEvidence | null;
	/**
	 * Token usage of the route planner's single `generateObject` pass — the one
	 * LLM call the kernel makes per turn. The turn body threads this into the
	 * kernel `bodyExecutionResult.usage`/`cost` so those fields populate instead
	 * of defaulting null. Absent when the planner fell back (model null / threw).
	 */
	routeUsage?: KernelRouteUsage | null;
	contextManifest: {
		version: 1;
		budgetTokens: number;
		sources: Array<{ name: string; count: number }>;
		historyCompaction: null | {
			compactedMessages: number;
			retainedMessages: number;
			source: "model" | "extractive";
		};
	};
	/** Model-facing request text and media shape, held only for the fail-closed
	 * redacted Kernel trace writer. Never persist this object in D1 metadata. */
	traceInput?: KernelRouteTraceInput;
}

export interface HomeDelegationEvidence {
	workOrder: DelegationWorkOrder;
	decision: DispatchDecision;
	/**
	 * The org's validated agent approver for an agent-routable hold. Null when
	 * the hold is human-reserved or no valid approver resolved
	 * (`approverUnavailableReason` says why); the operator card then decides.
	 */
	approver?: ResolvedDelegationApprover | null;
	approverUnavailableReason?: string | null;
	/** Stamped by the turn body once the Work approval proposal exists. */
	agentReview?: HomeDelegationAgentReview | null;
}

type KernelTediRosterEntry = {
	id: string;
	slug: string;
	name: string;
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsToken(text: string, token: string): boolean {
	const trimmed = token.trim().toLowerCase();
	if (!trimmed) return false;
	return new RegExp(
		`(^|[^a-z0-9])${escapeRegExp(trimmed)}(?=$|[^a-z0-9])`,
	).test(text);
}

function approvalHeldDelegationIntent(content: string): boolean {
	const text = content.toLowerCase();
	const asksForDelegation =
		/\b(delegat(?:e|ion|ing)|handoff|hand-off|work\s*order)\b/.test(text);
	const asksForApproval = /\b(approval|approve|sign[ -]?off)\b/.test(text);
	const holdsDispatch =
		/\b(?:do not|don't|not)\s+(?:dispatch|delegate|send|start)\b/.test(text) ||
		/\bpark(?:ed)?\b.{0,80}\bapproval\b/.test(text) ||
		/\bapproval\b.{0,80}\b(?:before|first|then wait|wait)\b/.test(text);
	return asksForDelegation && asksForApproval && holdsDispatch;
}

function findMentionedTedi(
	content: string,
	tedis: readonly KernelTediRosterEntry[],
): KernelTediRosterEntry | null {
	const text = content.toLowerCase();
	const matches = tedis.filter((tedi) => {
		const labels = [tedi.slug, tedi.name].filter(Boolean);
		return labels.some((label) => containsToken(text, label));
	});
	return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function coerceParkedApprovalDelegationRoute<
	T extends KernelRouteDecision,
>(route: T, content: string, tedis: readonly KernelTediRosterEntry[]): T {
	if (
		route.routeKind !== "answer_in_home" &&
		route.routeKind !== "propose_tool_write"
	) {
		return route;
	}
	if (!approvalHeldDelegationIntent(content)) return route;
	const target = findMentionedTedi(content, tedis);
	if (!target) return route;
	return {
		...route,
		routeKind: "delegate_tedi",
		rationale: `${route.rationale} The operator asked for an approval-held delegation, so this must be a machine-readable delegate_tedi recommendation rather than a text-only answer.`,
		answer: null,
		targetTediId: target.id,
		targetTediLabel: target.name || target.slug,
		targetActivityId: null,
		plannedToolIds: [],
		toolIntent: null,
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation:
			route.evidenceExpectation ??
			`After approval, ${target.name || target.slug} should complete the work order and return evidence to Home.`,
	} as T;
}

export function constrainUnavailableDelegation<T extends KernelRouteDecision>(
	route: T,
	delegationAvailable: boolean | undefined,
): T {
	if (
		delegationAvailable !== false ||
		(route.routeKind !== "delegate_tedi" &&
			route.routeKind !== "suggest_handoff")
	)
		return route;
	return {
		...route,
		routeKind: "answer_in_home",
		answer:
			"This local installation does not run tedis. I can draft in Home or use available local tools; use Tedix Cloud for delegated worker tasks.",
		rationale:
			"The installation has no tedi runtime, so approval cannot make this delegation executable.",
		targetTediId: null,
		targetTediLabel: null,
		targetActivityId: null,
		plannedToolIds: [],
		toolIntent: null,
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: null,
	};
}

/** Last intent boundary before any executable recommendation is constructed. */
export function finalizeKernelRouteDecision<T extends KernelRouteDecision>(
	route: T,
	operatorContent: string,
	tedis: readonly KernelTediRosterEntry[],
	delegationAvailable?: boolean,
): T {
	const coerced = coerceParkedApprovalDelegationRoute(
		route,
		operatorContent,
		tedis,
	);
	return constrainUnavailableDelegation(
		guardKernelRouteDecision(operatorContent, coerced),
		delegationAvailable,
	);
}

export function renderDelegationResponse(
	route: KernelRouteDecision,
	delegation?: HomeDelegationEvidence | null,
): string {
	const owner = route.targetTediLabel?.trim() || "the selected tedi";
	if (!route.targetTediId) {
		return "This needs a tedi handoff, but I could not identify one exact tedi. Name the tedi to delegate this to.";
	}
	if (!delegation) {
		return `I recommend handing this to ${owner}, but I could not build a dispatchable work order from the current tedi catalog.`;
	}
	switch (delegation.decision.mode) {
		case "auto":
			return `On it — delegating to ${owner} now. I'll bring ${owner}'s result back here when it's done.`;
		case "needs_approval":
			return renderHeldDelegationLine(owner, delegation.approver?.label);
		case "blocked":
		case "boot_unavailable":
			return `I can't dispatch ${owner}: ${delegation.decision.reason}`;
		default:
			return `I prepared a delegation to ${owner}. It is not dispatched yet; approve this Home run to dispatch the work order.`;
	}
}

/**
 * Map a typed route decision to a concise, operator-grade assistant message.
 *
 * Never claims work was executed that v0 does not execute — delegate/read/write/
 * workflow routes describe the recommendation and the next step (which stays on
 * the existing approval path), they do not assert completion.
 *
 * @param writeDeclined - when a `propose_tool_write` route was internally
 *   declined by the write-proposal planner, pass the decline record here so the
 *   rendered message is honest about the outcome instead of over-promising
 *   "Confirm and I'll prepare it for approval" for a write that never formed.
 */
export function renderRouteResponse(
	route: KernelRouteDecision,
	writeDeclined?: KernelWriteProposalDeclined | null,
): string {
	switch (route.routeKind) {
		case "answer_in_home":
			return (
				route.answer?.trim() ||
				"I don't have enough to answer that from Home yet — could you add a bit more detail?"
			);

		case "ask_human":
			// Fallback when the planner routed ask_human without an actual question
			// (common for greetings/small talk): offer capabilities instead of a
			// dead-end "clarify" loop.
			return (
				route.clarifyingQuestion?.trim() ||
				"Tell me what you'd like done and I'll take it from there — I can answer questions about this org, read data from connected apps, or delegate work to your tedis."
			);

		case "propose_tool_write": {
			const capability = route.toolIntent?.capability?.trim();
			const appSlug = route.toolIntent?.appSlug?.trim();
			const capLabel = capability ?? "that change";
			const appLabel = appSlug ?? "the relevant app";
			// When the write-proposal planner already declined, render the honest
			// decline line instead of the optimistic "I'll prepare it for approval"
			// promise (which is false when nothing was formed). This covers render
			// paths where the decline outcome is already known at render time.
			// turn-work.ts independently overrides assistantContent from the outcome
			// too — this parameter avoids the optimistic text in any intermediate
			// render (logs, streaming previews, unit tests).
			if (writeDeclined) {
				return renderWriteDeclined(writeDeclined, route);
			}
			return `This looks like a write — ${capLabel} via ${appLabel}. I'll attempt to prepare it for approval — confirm to proceed.`;
		}

		case "delegate_tedi": {
			return renderDelegationResponse(route);
		}

		case "run_workflow": {
			const workflow = route.workflowHint?.trim() || "a workflow";
			// evidenceExpectation is a full clause ("You should expect …"), not a
			// verb phrase, so the old `It will ${expectation}.` produced
			// "It will You should expect …." — emit it as its own sentence instead
			// (trailing period stripped, first letter capitalized → no double period).
			const raw = route.evidenceExpectation?.trim().replace(/[.\s]+$/, "");
			const expectation = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
			const base = `This fits the ${workflow} workflow.`;
			// Always leave an out: a wrong workflow match should cost the operator
			// one sentence, not a dead-end confirm loop.
			const out = "Or tell me what you're after and I'll route it differently.";
			return expectation
				? `${base} ${expectation}. Want me to start it? ${out}`
				: `${base} Want me to start it? ${out}`;
		}

		default:
			return (
				route.answer?.trim() ||
				route.rationale?.trim() ||
				"I'm not sure how to route that yet — could you say a bit more?"
			);
	}
}

/**
 * Run the Kernel for a single operator message.
 *
 * db / env / organizationId / descopeUserId come from the oRPC BaseContext
 * (`apps/api/src/rpc/orpc.ts`). Returns `null` only when no routing model is
 * available (Azure + Workers AI both failed); the caller then settles the turn
 * `failed` (model unavailable) — there is no heuristic responder.
 */
export async function runKernel(args: {
	onExecutionAttempts?: (attempts: readonly KernelExecutionAttempt[]) => void;
	attachments?: TediMessageAttachment[];
	resolveAttachments?: HomeAttachmentResolver;
	db: DbClient;
	env: KernelEnv;
	organizationId: string;
	descopeUserId?: string;
	content: string;
	/** A request that passed Home ingress catalog admission. */
	modelRef?: string;
	/** Home conversation id — enables bounded conversation-history assembly
	 * (kernel conversational memory). Absent ⇒ today's history-less behavior. */
	conversationId?: string;
	/** Immutable Home run correlation for paid route-planner inference. */
	runId?: string;
	/** Canonical Work Item when this Home turn already has one. */
	workItemId?: string;
	/** Compact initiating purpose. Defaults to `kernel:route`. */
	inferenceSource?: string;
	/** Ledger message id of the current turn's user message. Persist-first
	 * ordering inserts the `message.received` row before the kernel runs, so
	 * assembly must exclude it — the turn already arrives as `content`. */
	currentUserMessageId?: string;
	/** Advisory mid-turn progress callback (turn-work seam). The caller wraps it
	 * fail-soft, so a progress error never affects the turn. */
	onProgress?: (progress: KernelTurnProgress) => void;
	/**
	 * Optional session/conversation-scoped gating policy — the highest-precedence
	 * layer above the now-live tedi + org gating layers (precedence session → tedi
	 * → org, deny short-circuits). The tedi/org layers are sourced automatically
	 * from policy-pack `gatingPolicy` slots inside `runKernel`; this `session`
	 * input is the one layer with no durable store yet, so no live caller supplies
	 * it. Absent ⇒ the session layer defers (tedi/org still enforce); bind it at
	 * the call site once a session-policy source is chosen (no schema migration —
	 * it is a parsed `gatingPolicy`-shaped bag). */
	sessionPolicy?: DispatchPolicyLayer | null;
	/**
	 * Optional per-turn operator-abort signal (`KernelDO.cancelTurn` — see
	 * `docs/engineering/cognition/kernel-execution-model.md` "Operator cancel"). Forwarded
	 * verbatim to `planKernelRoute`, which combines it with its own internal
	 * timeout/idle signals so an operator cancel actually stops the in-flight
	 * route-planner LLM call instead of running to completion unattended.
	 */
	abortSignal?: AbortSignal;
	/**
	 * Read side: the depth of this run in the parent→child→grandchild
	 * delegation chain, read from the incoming run metadata (stamped by
	 * `kernelDelegateRunner`). Threaded into `decideDelegationDispatch` so the
	 * `MAX_DELEGATION_DEPTH` bound is enforced end-to-end — a grandchild that
	 * itself tries to delegate is blocked. Absent ⇒ 0 (a top-level Home turn).
	 * See decisions/agentic-kernel-architecture.md.
	 */
	delegationDepth?: number;
	/**
	 * Delegating parent tedi of a nested (`delegationDepth > 0`) run and the
	 * tedi principal that asked Home for this turn, when either is known. Only
	 * used to prove the agent approver's independence; absent at depth > 0 the
	 * hold stays with the operator.
	 */
	parentTediId?: string | null;
	requesterTediId?: string | null;
	/** Server-validated Workspace selection; shapes context but grants no capability. */
	workspaceContext?: {
		workspaceId: string;
		workspaceName: string;
		workpiece?: { kind: "gadget" | "output"; id: string; name: string };
	};
	selectedWorkspaceDocument?: string | null;
	/**
	 * Semantic recall already started at DO ingress (`KernelDO.processTurn`),
	 * so the multi-second Agent Memory call overlaps the pre-planning gap.
	 * Absent ⇒ context assembly starts its own. See `RELEVANCE_RECALL_BUDGET_MS`.
	 */
	relevanceCandidates?: Promise<AgentMemoryCandidate[]>;
}): Promise<KernelResult | null> {
	const {
		db,
		env,
		organizationId,
		descopeUserId,
		content: inputContent,
		modelRef,
		conversationId,
		runId,
		workItemId,
		inferenceSource,
		currentUserMessageId,
		onProgress,
		sessionPolicy,
		abortSignal,
		delegationDepth,
		parentTediId,
		requesterTediId,
		workspaceContext,
		relevanceCandidates,
	} = args;
	const { text: content, images } = homeAttachmentContent(
		inputContent,
		args.attachments,
	);

	const gatewayContext = {
		executionAttempts: [] as NonNullable<
			import("./gateway-attribution").KernelGatewayContext["executionAttempts"]
		>,
		organizationId,
		runId,
		workItemId,
		sessionKey: conversationId,
		source: inferenceSource ?? "kernel:route",
	};
	const model = kernelModel(env, modelRef ? { modelRef } : undefined, {
		...gatewayContext,
		// Keep a stable purpose label for live routing attribution.
		source: "kernel:route-plan",
	});
	// The selected model is the only inference path for this turn.
	if (!model) {
		console.warn(
			"[kernel] inactive — configured routing model is unavailable",
			{
				hasGatewayAuth: Boolean(
					env.AI_GATEWAY_ACCOUNT_ID &&
					env.AI_GATEWAY_LLM_ID &&
					env.CF_AI_GATEWAY_TOKEN,
				),
				hasResourceOrBaseUrl: Boolean(
					env.AZURE_OPENAI_RESOURCE || env.AZURE_OPENAI_BASE_URL,
				),
				hasDeployment: Boolean(env.AZURE_CHAT_DEPLOYMENT),
				hasWorkersAiBinding: Boolean(env.AI),
			},
		);
		return null;
	}

	// History rides on the assembled context into planKernelRoute — which is also
	// the answer pass: an answer_in_home route's "answer" text is produced by
	// the same generateObject call, so plant-and-recall works with no second
	// model pass. Fail-soft: a history-fetch error inside assembleHomeContext
	// degrades to an empty history, never failing the turn.
	// Agent Memory supplies candidate IDs; assembleHomeContext rehydrates and
	// authorizes them from canonical D1 before prompt assembly.
	//
	// `summarizeHistory` is the compaction model seam: when the assembled prompt
	// crosses the compaction trigger, the folded prefix is summarized by a real
	// model call instead of the mechanical extractive digest. Built here because
	// this is where the kernel's model plumbing lives. `undefined` when no model
	// is configured — assembly then behaves exactly as it did before.
	const summarizeHistory = createKernelHistorySummarizer(env, gatewayContext);
	const candidateRanker = createJevContextRanker(
		db,
		env,
		gatewayContext,
		abortSignal,
		args.onExecutionAttempts,
	);
	const delegationCandidateRanker = createJevDelegationRanker(
		db,
		env,
		gatewayContext,
		abortSignal,
		args.onExecutionAttempts,
	);
	// Size the selected provider without an outage-driven provider switch.
	const laneBudget = (): number =>
		kernelServesWorkersAiLane(model)
			? maxPromptTokensForWindow(WORKERS_AI_CONTEXT_WINDOW_TOKENS)
			: DEFAULT_MAX_PROMPT_TOKENS;
	const maxPromptTokens = laneBudget();

	// ── The assembly pass ─────────────────────────────────────────────────────
	// one pass = load the durable history, assemble and measure the prompt, fold
	// if the trigger says so, then hydrate the attachment bodies the caller owns.
	// Hydration is the part assembly cannot see: `hydrateHomeHistory` inlines
	// attachment content into the replay after assembly measured it, so a pass
	// reports how much it added and the per-step check below re-measures against
	// the whole request rather than the part assembly happened to own.
	async function assemblePass(pass: {
		maxPromptTokens: number;
		forceCompaction?: boolean;
		extraPromptChars?: number;
		measuredPromptTokens?: number | null;
	}): Promise<{ context: KernelContext; hydratedChars: number }> {
		const assembled = await assembleHomeContext(db, organizationId, {
			delegationAvailable: !(
				env.TEDIX_LOCAL_DEMO_ENABLED === "true" &&
				isLocalDemoProject(env.DESCOPE_PROJECT_ID)
			),
			descopeUserId,
			conversationId,
			excludeMessageId: currentUserMessageId,
			operatorMessage: content,
			candidateRanker,
			agentMemory: env.AGENT_MEMORY,
			// The ingress recall has settled by now; reusing it costs nothing and
			// avoids a second multi-second model-backed call on a later pass.
			...(relevanceCandidates ? { relevanceCandidates } : {}),
			workspaceContext,
			maxPromptTokens: pass.maxPromptTokens,
			selectedWorkspaceDocument: args.selectedWorkspaceDocument,
			...(summarizeHistory ? { summarizeHistory } : {}),
			...(pass.forceCompaction ? { forceCompaction: true } : {}),
			...(pass.extraPromptChars
				? { extraPromptChars: pass.extraPromptChars }
				: {}),
			...(pass.measuredPromptTokens !== undefined
				? { measuredPromptTokens: pass.measuredPromptTokens }
				: {}),
		});
		const beforeHydration = historyReplayChars(assembled.history);
		assembled.history = await hydrateHomeHistory(
			assembled.history,
			args.resolveAttachments,
		);
		return {
			context: assembled,
			hydratedChars: Math.max(
				0,
				historyReplayChars(assembled.history) - beforeHydration,
			),
		};
	}

	function buildManifest(
		ctx: KernelContext,
		budgetTokens: number,
	): KernelResult["contextManifest"] {
		return {
			version: 1,
			// Report the budget this turn was actually assembled against, not the
			// selected model's default — explicit fixed models may use another lane.
			budgetTokens,
			sources: [
				{ name: "workspace", count: ctx.workspace ? 1 : 0 },
				{ name: "speaker", count: ctx.speaker ? 1 : 0 },
				{ name: "tedis", count: ctx.tedis.length },
				{ name: "apps", count: ctx.apps.length },
				{ name: "workflows", count: ctx.workflows.length },
				{ name: "work_items", count: ctx.workItems.length },
				{ name: "facts", count: ctx.facts.length },
				{ name: "rationale", count: ctx.rationale.length },
				{ name: "history", count: ctx.history.length },
			],
			historyCompaction: ctx.historyCheckpoint
				? {
						compactedMessages: ctx.historyCheckpoint.compactedMessages,
						retainedMessages: Math.max(0, ctx.history.length - 1),
						source: ctx.historyCheckpoint.source,
					}
				: null,
		};
	}

	let pass = await assemblePass({ maxPromptTokens });
	let context = pass.context;
	let contextManifest = buildManifest(context, maxPromptTokens);
	const rosterDecision = groundedRosterDecision(inputContent, context);
	const groundedRosterRoute = rosterDecision
		? guardKernelRouteDecision(inputContent, rosterDecision)
		: null;
	if (groundedRosterRoute) {
		return {
			assistantContent: groundedRosterRoute.answer ?? "",
			route: groundedRosterRoute,
			delegation: null,
			routeUsage: null,
			contextManifest,
		};
	}

	// Perceived-latency fix (#14-A): emit a cheap "thinking" milestone immediately
	// after context assembly so the CLI/WS channel gets a sub-second ack before
	// the ~3-9 s LLM call below. Pure delivery — no behavior or route change.
	// Fail-soft: the try/catch guard is the same pattern as emitProgress in
	// turn-work.ts. The stage label "thinking" matches a common ready_event
	// convention and is an operator-grade display string, not a machine contract.
	try {
		onProgress?.({ stage: "thinking", phase: "preparing_context" });
	} catch {
		// Advisory only — never let a progress sink break the turn.
	}

	// ── per-step compaction re-check ──────────────────────────────────────────
	// The trigger used to be evaluated exactly once, at turn start, against the
	// char/4 estimator over the rows assembly happened to read. Two things move
	// the prompt after that point and neither was measured: the hydrated
	// attachment bodies this function inlines into the replay, and whatever the
	// provider actually charged for the last persisted step (`message.completed`
	// → `payload.usage.inputTokens`, already on the canonical ledger). So the
	// turn discovered it was over budget only when the provider threw, and the
	// overflow retry below — designed as the backstop — became the routine path.
	//
	// Re-check here, against measured usage, before the model is prompted:
	//   - `compact`   → this pass ends without prompting. Reload and fold.
	//   - `remeasure` → the provider reported no usage for the last step, so
	//                   there is nothing to project from. Reload regardless when
	//                   hydration grew the prompt, so the turn-start estimator
	//                   measures the whole request on the next pass.
	//   - `prompt`    → measured and under the trigger. Send it.
	// An operator cancel ends the turn ahead of compaction: a turn nobody is
	// waiting for must not pay a summarizer call. The grounded-roster answer and
	// every approval/connection route already returned above, for the same
	// reason.
	if (!abortSignal?.aborted) {
		const stepPressure = assessStepPressure({
			measuredPromptTokens: context.lastStepPromptTokens ?? null,
			appendedChars: pass.hydratedChars,
			estimatedTotalChars:
				(context.promptCharsEstimate ?? 0) + pass.hydratedChars,
			inputBudgetChars: getHistoryTokenLimits(maxPromptTokens, 0)
				.inputBudgetChars,
		});
		const mustReload =
			stepPressure.action === "compact" ||
			(stepPressure.action === "remeasure" && pass.hydratedChars > 0);
		if (mustReload) {
			console.warn(
				`[kernel] context-budget: per-step re-check says ${stepPressure.action} (${stepPressure.reason}) — reloading before prompting`,
				{
					orgId: organizationId,
					conversationId,
					measuredPromptTokens: stepPressure.measuredPromptTokens,
					projectedPromptTokens: Math.ceil(
						stepPressure.projectedPromptChars / 4,
					),
					hydratedChars: pass.hydratedChars,
					budget: maxPromptTokens,
				},
			);
			pass = await assemblePass({
				maxPromptTokens,
				// A measured verdict of `compact` is an instruction, not a hint: the
				// reloaded pass folds whatever its own estimator would have said.
				...(stepPressure.action === "compact" ? { forceCompaction: true } : {}),
				// Account the bodies hydration will inline again, so the reloaded
				// pass measures the whole request.
				extraPromptChars: pass.hydratedChars,
				measuredPromptTokens: stepPressure.measuredPromptTokens,
			});
			context = pass.context;
			contextManifest = buildManifest(context, maxPromptTokens);
		}
	}

	// Whether the single-pass streamObject route actually delivered answer
	// deltas. It only emits for partials whose routeKind is answer_in_home, so a
	// decision the post-verdict guard downgraded to answer_in_home (or any
	// non-answer route) reaches the delivery block below with nothing streamed.
	let plannerStreamedAnswer = false;

	// Every request outside the bounded workspace-roster read above is routed by
	// the model. A null result means no valid route was produced; the caller
	// settles the turn as failed.
	const planArgs = {
		onExecutionAttempts: args.onExecutionAttempts,
		delegationCandidateRanker,
		images,
		content,
		operatorContent: inputContent,
		model,
		env,
		organizationId,
		gatewayContext,
		abortSignal,
		// Forward answer deltas from the single streamObject pass directly into
		// the onProgress channel — the streamed deltas are the delivered answer.
		onAnswerDelta: (delta: string) => {
			try {
				plannerStreamedAnswer = true;
				onProgress?.({
					stage: "Answering",
					phase: "generating",
					answerDelta: delta,
				});
			} catch {
				// Advisory only.
			}
		},
		// Provisional thinking line. `rationale` streams on every route, so this
		// is what the operator sees while a delegate_tedi / propose_tool_write /
		// run_workflow / ask_human plan is being decided — routes where `answer`
		// stays null and nothing at all reached the screen before. Display only:
		// it never becomes `assistantContent`, never reaches the ledger,
		// accounting, approvals or cost attribution, and the settled route
		// supersedes it.
		onRationaleDelta: (delta: string) => {
			try {
				onProgress?.({
					stage: "Planning route",
					rationaleDelta: delta,
				});
			} catch {
				// Advisory only.
			}
		},
	};

	// Reactive compaction — the backstop. The per-step re-check above now folds on
	// measured provider usage before the model is prompted, so this arm is what it
	// was designed to be: the last line for an estimator miss no measurement could
	// have caught (a first turn in a conversation, a step whose provider reported
	// no usage, a context block that grew inside this pass). On a genuine provider
	// context-overflow, fold harder and retry the turn once rather than surfacing
	// an error the operator cannot act on. Bounded to a single retry: a second
	// overflow is a real failure, not an estimator miss.
	// How much harder the reactive arm folds. Half the budget is a deliberate
	// overshoot: the estimator was already wrong once this turn, so shaving a few
	// percent would likely overflow again and burn the single retry.
	const CONTEXT_OVERFLOW_RETRY_RATIO = 0.5;
	let planned: Awaited<ReturnType<typeof planKernelRoute>>;
	try {
		planned = await planKernelRoute({ ...planArgs, context });
	} catch (error) {
		if (!isContextOverflowError(error)) throw error;
		// Refold against the configured model's current lane budget. The retry
		// keeps the same provider selection and reduces context once.
		const retryBudget = Math.max(
			1,
			Math.min(
				Math.floor(maxPromptTokens * CONTEXT_OVERFLOW_RETRY_RATIO),
				Math.floor(laneBudget() * CONTEXT_OVERFLOW_RETRY_RATIO),
			),
		);
		console.warn(
			`[kernel] context-budget: provider reported overflow at ${maxPromptTokens} tokens; refolding at ${retryBudget} and retrying once`,
			{ orgId: organizationId, conversationId },
		);
		pass = await assemblePass({
			maxPromptTokens: retryBudget,
			// The estimator was already wrong once this turn: fold, whatever it
			// says about the halved budget.
			forceCompaction: true,
			extraPromptChars: pass.hydratedChars,
		});
		context = pass.context;
		contextManifest = buildManifest(context, retryBudget);
		// A second overflow is a real failure, not an estimator miss — it
		// propagates to the caller like any other provider error.
		planned = await planKernelRoute({ ...planArgs, context });
	}

	if (!planned) return null;
	// Split the LLM call's token usage out of the route object: the route flows
	// verbatim into run metadata as `kernelRoute`, while `routeUsage` is threaded
	// into the kernel `bodyExecutionResult.usage`/`cost` by the turn body.
	const { usage: routeUsage, traceInput, ...plannedRoute } = planned;
	if (routeUsage && gatewayContext.executionAttempts.length) {
		routeUsage.attempts = [
			...gatewayContext.executionAttempts,
			...routeUsage.attempts,
		];
		routeUsage.attemptCount = routeUsage.attempts.length;
	}
	let route = plannedRoute;

	route = finalizeKernelRouteDecision(
		route,
		inputContent,
		context.tedis,
		context.delegationAvailable,
	);

	// delegate_tedi authorization evidence: when the planner names a target that
	// carries a capability card, construct the work order + the fail-closed
	// dispatch verdict and record them. The runtime body consumes the verdict for
	// supervised dispatch when the gate allows it.
	// `approvalAuthority` is the real flag derived in `assembleHomeContext` from
	// the operator's org member role (owner/admin → true). Only the bounded
	// approval flag is threaded here, not the full Speaker Authority envelope.
	let delegation: HomeDelegationEvidence | null = null;
	if (route.routeKind === "delegate_tedi" && route.targetTediId) {
		const card =
			context.tedis.find((t) => t.id === route.targetTediId)?.capability ??
			null;
		// Layered dispatch gating (precedence session → tedi → org, deny
		// short-circuits, fail-closed):
		//   - session: the optional conversation-scoped layer (no live store yet).
		//   - tedi:    the target tedi's policy pack `gatingPolicy`, already parsed
		//              onto the capability card during assembly.
		//   - org:     the org's active policy pack `gatingPolicy`, read here via
		//              the same query shape as `readOrgGovernancePolicy`.
		// All three are null/absent unless a `gatingPolicy` is configured, so a
		// deployment with none keeps the pre-existing two-layer behavior.
		const orgPolicy = await readOrgDispatchPolicyLayer(db, organizationId);
		const executionRequirement = deriveExecutionRequirement(content, route);
		const executionEnvironment =
			(env as unknown as { ENVIRONMENT?: string }).ENVIRONMENT ?? "development";
		const earnedDelegationGlobalMode =
			(
				env as unknown as {
					EARNED_DELEGATION_ENFORCEMENT?: "shadow" | "enforce";
				}
			).EARNED_DELEGATION_ENFORCEMENT === "enforce"
				? "enforce"
				: "shadow";
		const earnedDelegationEnforcement = resolveEarnedDelegationEnforcement({
			globalMode: earnedDelegationGlobalMode,
			policy: orgPolicy?.earnedDelegation,
			activityId: route.targetActivityId,
			tediId: route.targetTediId,
			environment: executionEnvironment,
		});
		const earnedDelegationActivityAllowed =
			route.targetActivityId !== null &&
			(orgPolicy?.earnedDelegation?.activityIds.includes(
				route.targetActivityId,
			) ??
				false);
		delegation = {
			workOrder: buildDelegationWorkOrder({
				route,
				card,
				userContent: content,
				executionRequirement,
				executionEnvironment,
				authorityMode: earnedDelegationEnforcement,
			}),
			decision: decideDelegationDispatch({
				route,
				card,
				executionRequirement,
				// End to end: this run's own chain depth gates whether it may
				// delegate further (a chain past MAX_DELEGATION_DEPTH is refused).
				delegationDepth,
				speaker: {
					approvalAuthority: context.speaker?.approvalAuthority ?? false,
				},
				gating: {
					session: sessionPolicy ?? null,
					tedi: card?.dispatchPolicy ?? null,
					org: orgPolicy,
				},
				operatorHeldForApproval: approvalHeldDelegationIntent(inputContent),
				earnedDelegationEnforcement,
				earnedDelegationActivityAllowed,
				executionEnvironment,
			}),
		};
		// Agent-in-the-loop: an agent-routable hold goes to the org's designated
		// approval tedi when one resolves and is independent of this work.
		if (
			delegation.decision.mode === "needs_approval" &&
			delegation.decision.approvalRoute === "agent"
		) {
			const resolution = await resolveDelegationApprover({
				db,
				env: env as unknown as { TEDI_SERVICE?: Fetcher; ENVIRONMENT?: string },
				organizationId,
				designation: orgPolicy?.delegationApprover,
				targetTediId: route.targetTediId,
				parentTediId,
				requesterTediId,
				delegationDepth,
			});
			delegation.approver = resolution.approver;
			delegation.approverUnavailableReason = resolution.reason;
		}
	}

	// The durable assistant message is the source of truth: render it first so the
	// run row always has a final answer even when streaming is unavailable or
	// fails. Delivery below never changes the route or the durable answer.
	let assistantContent = renderRouteResponse(route);
	if (route.routeKind === "delegate_tedi") {
		assistantContent = renderDelegationResponse(route, delegation);
	}

	// Progressive delivery for every route the planner did not already stream
	// (otherwise a delegate_tedi turn shows nothing until the terminal patch).
	//   - answer_in_home: the single streamObject pass already emitted the
	//     answer deltas — unless the post-verdict guard downgraded the decision
	//     after the stream, in which case nothing was emitted and the rendered
	//     text is delivered deterministically below.
	//   - every other route: the rendered acknowledgement (delegation ack,
	//     approval card text, clarifying question, workflow confirmation) is
	//     delivered as deterministic word-boundary deltas. No LLM pass — those
	//     texts are contracts rendered by code, not prose to refine.
	// Delivery only: none of this changes the route or the durable answer.
	if (onProgress && !plannerStreamedAnswer) {
		try {
			onProgress({ stage: "Answering", phase: "generating" });
		} catch {
			// Advisory only.
		}
		for (const chunk of chunkAnswerForDelivery(assistantContent)) {
			try {
				onProgress({
					stage: "Answering",
					phase: "generating",
					answerDelta: chunk,
				});
			} catch {
				// Advisory only.
			}
		}
	}
	return {
		route,
		delegation,
		routeUsage,
		assistantContent,
		contextManifest,
		traceInput,
	};
}
