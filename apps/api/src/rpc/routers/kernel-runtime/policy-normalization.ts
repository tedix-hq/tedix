import { firstNonSkillReferenceLine } from "@tedix/api-contract/utils/skill-reference";
import { resolveHomeAttachments } from "./attachment-storage";
import { requireOrgId } from "../../org-scope";
import { homeAttachmentContent } from "../kernel/attachment-content";
import {
	type BaseContext,
	ErrorCodes,
	createError,
	withAuth,
} from "../../orpc";
import {
	type EnqueueHomeMessageInput,
	type HomeChildRunEvidence,
	type HomeMessage,
	type HomePlan,
	HomePlanSchema,
	type HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import {
	HOME_PLAN_ASSIGNMENT_SCOPE_INSTRUCTIONS,
	type HomePlanningTarget,
	PLAN_DECOMPOSITION_TIMEOUT_MS,
	buildHomePlanAssignment,
	detectsHomePlanningRequest,
	previewPlanContent,
	selectedHomePlanTargets,
	tediPlanningLabel,
} from "../kernel/plan-dispatch";
import type { KernelDO } from "../../../kernel/kernel-do";
import { type KernelEnv, kernelModel } from "../kernel/llm";
import {
	type KernelGovernancePolicy,
	parseKernelGovernancePolicy,
} from "@tedix/api-contract/utils/approval-policy";
import type { KernelRouteUsage } from "../kernel/route-planner";
import type {
	KernelRuntimeEvent,
	TediArtifactRow,
	TediRuntimeEventRow,
} from "@tedix/db/queries/kernel-runtime-events";
import {
	type KernelRuntimeRun,
	getKernelRuntimeRun,
	listKernelRuntimeRunMetadata,
} from "@tedix/db/queries/kernel-runtime-runs";
import {
	type PlanDependencyEdge,
	planTediAssignments,
} from "../kernel/plan-planner";
import type {
	TediArtifact,
	TediMessageRole,
	TediRuntimeEvent,
	TediRuntimeRef,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	buildInternalServiceBindingContext,
	childRunStatusKey,
	delegationSessionKey,
	errorMessage,
	isTerminalHomeRunStatus,
	nonNullRecord,
	numberFromPayload,
	shouldFailSoftHomeRunSetRead,
	stringFromPayload,
	withTimeout,
} from "../kernel/runtime-shared";
import {
	childRunPreviewFromEvents,
	latestActivityLabelFromEvents,
} from "../kernel/child-run-reads";
import { cognitiveRuntimeContractRouter } from "../cognitive-runtime";
import { createRouterClient, implement } from "@orpc/server";
import {
	getActivePolicyPackDefinition,
	listOrganizationTedis,
} from "@tedix/db/queries/kernel-runtime-support";
import { healthForIsolateTedi } from "../cognitive-runtime/events-policy";
import { kernelRuntimeContract } from "@tedix/api-contract/contracts/kernel-runtime";
import {
	normalizeRuntime,
	registerCanceledParentChildStopper,
} from "../kernel/run-store";
import { planKernelWriteProposal } from "../kernel/write-proposal";
import { runKernel } from "../kernel";
import { setKernelWriteExecutorForTest } from "../kernel/write-approval-settlement";
import { transcribeAudioAttachment } from "@tedix/voice/stt";

export const kernelRuntimeOs = implement(
	kernelRuntimeContract,
).$context<BaseContext>();

export const authed = kernelRuntimeOs.use(withAuth);

// Bounded-recovery ceiling: at most this many operator-gated retry dispatches per
// blocked delegation Work Item (the governed-loop max-turn cap). The Nth+1
// retry is a hard terminal reject.
export const MAX_DELEGATION_RETRIES = 3;

export type KernelDelegateRunnerInput = {
	context: BaseContext;
	childRunId: string;
	content: string;
	delegateToTediId: string;
	attachments?: EnqueueHomeMessageInput["attachments"];
	metadata: Record<string, unknown>;
};

export type KernelDelegateRunnerOutput = {
	childRunId: string;
	childConversationId?: string;
	error?: string;
	/** Machine-readable failure reason when status=failed. `runtime_unavailable`
	 * means preflight determined the runtime is unreachable — dispatch was never
	 * attempted and the same target should not be re-enqueued. */
	reason?: "dispatch_failed" | "runtime_unavailable";
	status: "queued" | "failed";
};

export type KernelDelegateRunner = (
	input: KernelDelegateRunnerInput,
) => Promise<KernelDelegateRunnerOutput>;

// delegationSessionKey moved to ./kernel/runtime-shared.ts so the unblock
// watcher's injected enqueue (run-store.ts) shares the exact session-scoping
// contract. Imported above.

/**
 * Operator verbs that exist as real commands elsewhere and must never be
 * interpreted as a Home objective. Each maps to the surface that runs it.
 */

export // delegationSessionKey moved to ./kernel/runtime-shared.ts so the unblock
// watcher's injected enqueue (run-store.ts) shares the exact session-scoping
// contract. Imported above.

/**
 * Operator verbs that exist as real commands elsewhere and must never be
 * interpreted as a Home objective. Each maps to the surface that runs it.
 */
const OPERATOR_SLASH_COMMANDS: Record<string, string> = {
	retry: "tedix retry <workItemId>",
	cancel: "tedix cancel <homeRunId>",
	approve: "tedix approve <homeRunId>",
	reject: "tedix reject <homeRunId>",
	steer: 'tedix steer <homeRunId> "<guidance>"',
	status: "tedix status",
};

/**
 * Detect a leading operator slash command in message content.
 *
 * Only the leading line is considered, and only a bare `/<verb>` token: prose
 * that merely opens with a path (`/Users/...`), a number (`/2026 targets`) or
 * an unknown verb is left alone so ordinary messages are never hijacked.
 *
 * Leading `/skill <slug>` reference lines are stepped over rather than read as
 * the leading token. The OS composer's skill picker writes its references above
 * the operator's own prose, so reading literally the first line would see a
 * reference, classify it as "not a command", and let a real `/retry <id>` on
 * the next line through unrefused — the exact hole this guard exists to close.
 * `firstNonSkillReferenceLine` is shared with the composer so both ends agree
 * on what a reference line is.
 */
export function detectOperatorSlashCommand(
	content: string,
): string | undefined {
	const firstLine = firstNonSkillReferenceLine(content);
	if (!firstLine.startsWith("/")) return undefined;
	const token = firstLine.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? "";
	if (!/^[a-z][a-z0-9-]*$/.test(token)) return undefined;
	return token in OPERATOR_SLASH_COMMANDS ? token : undefined;
}

/** Refusal text naming the surface that actually runs the command. */

/** Refusal text naming the surface that actually runs the command. */
export function operatorSlashCommandRefusal(command: string): string {
	const runWith = OPERATOR_SLASH_COMMANDS[command];
	return `"/${command}" is an operator command, not a message. It was NOT sent to Home, because routing it as a message would create a new work item from the command text instead of running it. Run \`${runWith}\` instead, or remove the leading "/" if you really meant to send this as a message.`;
}

const defaultKernelDelegateRunner: KernelDelegateRunner = async ({
	context,
	childRunId,
	content,
	delegateToTediId,
	attachments,
	metadata,
}) => {
	const organizationId = requireOrgId(context);
	// Approval/retry dispatches may happen in a later request. Recover the
	// original handles from the parent rather than silently losing its files.
	const homeRunId = stringFromPayload(metadata.homeRunId);
	if (attachments === undefined && homeRunId) {
		const parent = await getKernelRuntimeRun(context.db, {
			id: homeRunId,
			organizationId,
		});
		attachments = readPayloadAttachments(
			nonNullRecord(nonNullRecord(parent?.metadata)?.redriveInput),
		);
	}
	const resolvedAttachments = await resolveHomeAttachments(
		context.env.TEDI_R2_BUCKET,
		organizationId,
		attachments,
	);
	const attachmentContent = homeAttachmentContent(content, resolvedAttachments);
	const client = createRouterClient(cognitiveRuntimeContractRouter, {
		context,
	});
	const result = await client.enqueueMessage({
		tediId: delegateToTediId,
		content: attachmentContent.text,
		conversationId: delegationSessionKey(childRunId),
		idempotencyKey: childRunId,
		attachments: resolvedAttachments?.filter(
			(attachment) => attachment.type !== "file",
		),
		// Home supervises every delegation via run-set reconciliation (terminal
		// events), never the inline reply — so dispatch async. For an isolate
		// target this makes the body accept + queue the turn, lifting the inject
		// HTTP-timeout cap that false-failed a cold child's first turn. The
		// async flag keeps every delegated turn on the
		// same supervised path.
		// Delegation-depth propagation: each delegate hop increments the
		// chain depth carried on run metadata, so a child that itself delegates
		// inherits parent+1. `decideDelegationDispatch` refuses a dispatch once
		// this reaches MAX_DELEGATION_DEPTH (decisions/agentic-kernel-architecture.md).
		metadata: {
			...metadata,
			dispatchMode: "async",
			delegationDepth:
				(typeof (
					metadata as
						| {
								delegationDepth?: unknown;
						  }
						| undefined
				)?.delegationDepth === "number"
					? (
							metadata as {
								delegationDepth: number;
							}
						).delegationDepth
					: 0) + 1,
		},
	});
	return {
		childRunId: result.runId ?? childRunId,
		childConversationId: result.conversationId,
		error: result.error,
		reason: result.reason,
		status: result.status,
	};
};

export let kernelDelegateRunner = defaultKernelDelegateRunner;

/** Uniform outcome shape for a forwarded child control action (steer/stop). */

export /** Uniform outcome shape for a forwarded child control action (steer/stop). */
type KernelChildControlResult = {
	/** True when the kernel actually issued the forward to the child runtime. */
	attempted: boolean;
	/** `skipped` when there was no live child to forward to. */
	outcome: "succeeded" | "failed" | "skipped";
	error?: string;
	/** Runtime-assigned run id for a steer inject (the new child turn). */
	childInjectRunId?: string;
};

export const childControlSkipped: KernelChildControlResult = {
	attempted: false,
	outcome: "skipped",
};

export type KernelChildSteerForwarder = (input: {
	context: BaseContext;
	organizationId: string;
	delegatedTediId: string;
	childRunId: string;
	childConversationId: string | null;
	workItemId?: string;
	instruction: string;
	homeRunId: string;
	steeredAt: string;
}) => Promise<KernelChildControlResult>;

/**
 * Forward an operator steering instruction to a running delegated child via the
 * SAME async isolate-inject path the dispatcher uses
 * (`cognitiveRuntime.enqueueMessage` → `injectAgentMessage`, async). The
 * instruction lands as a new turn in the child's existing session so the live
 * worker consumes it inline; Home keeps supervising via reconciliation. Never
 * throws — a child-side failure is captured as `outcome: "failed"` so the
 * parent steer stays intact (fail-safe).
 */

export /**
 * Forward an operator steering instruction to a running delegated child via the
 * SAME async isolate-inject path the dispatcher uses
 * (`cognitiveRuntime.enqueueMessage` → `injectAgentMessage`, async). The
 * instruction lands as a new turn in the child's existing session so the live
 * worker consumes it inline; Home keeps supervising via reconciliation. Never
 * throws — a child-side failure is captured as `outcome: "failed"` so the
 * parent steer stays intact (fail-safe).
 */
const defaultKernelChildSteerForwarder: KernelChildSteerForwarder = async (
	input,
) => {
	const internalContext = buildInternalServiceBindingContext(
		input.context,
		input.organizationId,
	);
	const client = createRouterClient(cognitiveRuntimeContractRouter, {
		context: internalContext,
	});
	try {
		const result = await client.enqueueMessage({
			tediId: input.delegatedTediId,
			conversationId: input.childConversationId ?? undefined,
			content: input.instruction,
			idempotencyKey: `${input.homeRunId}:steer:${Date.parse(input.steeredAt)}:${input.delegatedTediId}`,
			metadata: {
				source: "kernelRuntime.steerForward",
				steering: true,
				homeRunId: input.homeRunId,
				childRunId: input.childRunId,
				...(input.workItemId ? { workItemId: input.workItemId } : {}),
				// Home supervises via reconciliation, never the inline reply — async
				// inject so a cold child's first steer turn is not capped by the
				// inject HTTP timeout (matches the dispatch path).
				dispatchMode: "async",
			},
		});
		return {
			attempted: true,
			outcome: result.status === "failed" ? "failed" : "succeeded",
			error: result.error,
			childInjectRunId: result.runId,
		};
	} catch (error) {
		return {
			attempted: true,
			outcome: "failed",
			error: errorMessage(error),
		};
	}
};

export let kernelChildSteerForwarder = defaultKernelChildSteerForwarder;

export type KernelChildStopper = (input: {
	context: BaseContext;
	organizationId: string;
	delegatedTediId: string;
	childRunId: string;
	childConversationId: string | null;
	reason?: string;
}) => Promise<KernelChildControlResult>;

/**
 * Cascade a parent-run cancel to its delegated child via the canonical
 * child-stop RPC (`cognitiveRuntime.stopRun` → `stopRuntimeRun`, the same path
 * Tedix OS uses to stop a tedi run). Never throws — a child-side failure (already
 * terminal, runtime reconnecting, not found) is captured as `outcome: "failed"`
 * so the parent cancel stays intact (fail-safe).
 */

export /**
 * Cascade a parent-run cancel to its delegated child via the canonical
 * child-stop RPC (`cognitiveRuntime.stopRun` → `stopRuntimeRun`, the same path
 * Tedix OS uses to stop a tedi run). Never throws — a child-side failure (already
 * terminal, runtime reconnecting, not found) is captured as `outcome: "failed"`
 * so the parent cancel stays intact (fail-safe).
 */
const defaultKernelChildStopper: KernelChildStopper = async (input) => {
	const internalContext = buildInternalServiceBindingContext(
		input.context,
		input.organizationId,
	);
	const client = createRouterClient(cognitiveRuntimeContractRouter, {
		context: internalContext,
	});
	try {
		await client.stopRun({
			tediId: input.delegatedTediId,
			runId: input.childRunId,
			conversationId: input.childConversationId ?? undefined,
			reason: input.reason ?? "Parent Home run canceled by operator",
		});
		return {
			attempted: true,
			outcome: "succeeded",
		};
	} catch (error) {
		return {
			attempted: true,
			outcome: "failed",
			error: errorMessage(error),
		};
	}
};

export let kernelChildStopper = defaultKernelChildStopper;

export type KernelDoTurnCanceler = (input: {
	context: BaseContext;
	organizationId: string;
	runId: string;
}) => Promise<boolean>;

/**
 * Best-effort DO-side abort of an in-flight kernel turn's LLM pass
 * (docs/engineering/cognition/kernel-execution-model.md "Operator cancel"). Called from
 * `cancelKernelRunCore` AFTER the run row is durably marked `canceled` — this
 * only stops the wasted token burn; the actual cancel SETTLE is owned by the
 * existing `turn-work.ts` pre-materialize cancel gate, which reads the
 * already-`canceled` run row regardless of whether this RPC ever reaches the
 * DO or finds a live controller there (`KernelDOv4.cancelTurn`). Resolves the
 * same binding + DO id the enqueue path uses (`kernel.idFromName(organizationId)`)
 * so it targets the SAME org-scoped DO instance the turn is running on.
 *
 * Never throws: a missing binding, an `idFromName`/`get` throw, or a DO RPC
 * failure all resolve to `false` — `cancelKernelRunCore` must never fail the
 * cancel over this (the run is already durably canceled by the time this runs).
 */

export /**
 * Best-effort DO-side abort of an in-flight kernel turn's LLM pass
 * (docs/engineering/cognition/kernel-execution-model.md "Operator cancel"). Called from
 * `cancelKernelRunCore` AFTER the run row is durably marked `canceled` — this
 * only stops the wasted token burn; the actual cancel SETTLE is owned by the
 * existing `turn-work.ts` pre-materialize cancel gate, which reads the
 * already-`canceled` run row regardless of whether this RPC ever reaches the
 * DO or finds a live controller there (`KernelDOv4.cancelTurn`). Resolves the
 * same binding + DO id the enqueue path uses (`kernel.idFromName(organizationId)`)
 * so it targets the SAME org-scoped DO instance the turn is running on.
 *
 * Never throws: a missing binding, an `idFromName`/`get` throw, or a DO RPC
 * failure all resolve to `false` — `cancelKernelRunCore` must never fail the
 * cancel over this (the run is already durably canceled by the time this runs).
 */
const defaultKernelDoTurnCanceler: KernelDoTurnCanceler = async (input) => {
	try {
		const kernel = (
			input.context.env as {
				KERNEL?: DurableObjectNamespace<KernelDO>;
			}
		).KERNEL;
		if (!kernel) return false;
		const stub = kernel.get(kernel.idFromName(input.organizationId));
		return await stub.cancelTurn(input.runId);
	} catch (error) {
		console.warn(
			"[kernelRuntime] DO cancelTurn best-effort call failed (cancel is already durable)",
			errorMessage(error),
		);
		return false;
	}
};

export let kernelDoTurnCanceler = defaultKernelDoTurnCanceler;

// Post-cancel child reconcile seam (run-store must not import this module):
// the run-set reconcile stops a delegated child that slipped through the
// cancel race using the SAME canonical child-stop RPC as cancelKernelRunCore.
// Reads the CURRENT `kernelChildStopper` at call time so the
// `setChildStopperForTest` hook applies to the reconcile path too.

// Post-cancel child reconcile seam (run-store must not import this module):
// the run-set reconcile stops a delegated child that slipped through the
// cancel race using the SAME canonical child-stop RPC as cancelKernelRunCore.
// Reads the CURRENT `kernelChildStopper` at call time so the
// `setChildStopperForTest` hook applies to the reconcile path too.
registerCanceledParentChildStopper((context, input) =>
	kernelChildStopper({
		context,
		...input,
	}),
);

// Kernel — bounded LLM-backed typed route planner. Indirected
// through `activeKernel` so tests can stub it via the test hook below; the
// real `runKernel` is fail-soft (returns null when Azure is unconfigured or
// planning fails), so the handler always falls back to the heuristic responder.
export let activeKernel: typeof runKernel = runKernel;

// Approved-write layer (v1) — both legs are indirected for tests: the
// proposal planner makes live MCP `tools/list` + Azure calls and the executor
// makes the live `tools/call`, so kernel-runtime tests stub them the same way
// they stub the kernel. The real implementations are fail-soft. The executor
// latch lives in ./kernel/write-approval-settlement next to its only caller.
export let activeKernelWriteProposalPlanner: typeof planKernelWriteProposal =
	planKernelWriteProposal;

// Voice-note STT for the kernel path — indirected like the kernel/planner so
// tests stub it without real Azure/Workers-AI calls. The real implementation
// is `@tedix/voice/stt` (Gateway BYOK gpt-transcribe primary, Whisper fallback).
export let activeTranscribeAudio: typeof transcribeAudioAttachment =
	transcribeAudioAttachment;

/**
 * Hybrid soft-deadline response contract: `enqueueMessage` awaits the KernelDO turn up to this
 * deadline. Fast turns answer in-band exactly like before; slower turns return
 * an ack carrying the real run id (`task.id = homeRunId` for the MCP tasks
 * extension) while the DO keeps running the turn in its own execution context.
 * The budget covers the WHOLE handler, including admission and persistence
 * before the DO call. Starting a fresh 12s timer only after that work consumed
 * the common 15s caller budget and produced false outcome-unknown failures.
 *
 * 25s: a typical LLM-routed turn takes 13-23s, and a 10s deadline sent nearly
 * all of them down the queued-ack path, costing clients a poll cycle or more
 * before they could read an answer that was already there. Every caller that
 * waits on this route gives it more room: the MCP gateway floors
 * `kernelRuntime/enqueueMessage` at 60s (apps/mcp handler.ts), Tedix OS chat
 * clients use `OS_CHAT_MUTATION_TIMEOUT_MS` / `CAPN_CHAT_MUTATION_TIMEOUT_MS`
 * (45s), and the CLI waits its full poll timeout. Workers and Durable Object
 * calls have no wall-clock cap on an awaited fetch. Raise this only together
 * with those client timeouts.
 */
const KERNEL_TURN_SOFT_DEADLINE_MS = 25_000;

export let kernelTurnSoftDeadlineMs: number = KERNEL_TURN_SOFT_DEADLINE_MS;

/** Remaining in-band wait after charging all work already spent by the route. */
export function remainingKernelTurnBudgetMs(
	startedAtMs: number,
	nowMs: number,
	budgetMs: number = kernelTurnSoftDeadlineMs,
): number {
	return Math.max(0, budgetMs - Math.max(0, nowMs - startedAtMs));
}

/** @internal */
export const kernelRuntimeTestHooks = {
	setDelegateRunnerForTest(runner: KernelDelegateRunner | null) {
		kernelDelegateRunner = runner ?? defaultKernelDelegateRunner;
	},
	setChildSteerForwarderForTest(forwarder: KernelChildSteerForwarder | null) {
		kernelChildSteerForwarder = forwarder ?? defaultKernelChildSteerForwarder;
	},
	setChildStopperForTest(stopper: KernelChildStopper | null) {
		kernelChildStopper = stopper ?? defaultKernelChildStopper;
	},
	setDoTurnCancelerForTest(canceler: KernelDoTurnCanceler | null) {
		kernelDoTurnCanceler = canceler ?? defaultKernelDoTurnCanceler;
	},
	setKernelForTest(fn: typeof runKernel | null) {
		activeKernel = fn ?? runKernel;
	},
	setKernelWriteProposalPlannerForTest(
		fn: typeof planKernelWriteProposal | null,
	) {
		activeKernelWriteProposalPlanner = fn ?? planKernelWriteProposal;
	},
	setKernelWriteExecutorForTest,
	setKernelTurnSoftDeadlineForTest(ms: number | null) {
		kernelTurnSoftDeadlineMs = ms ?? KERNEL_TURN_SOFT_DEADLINE_MS;
	},
	setTranscribeForTest(fn: typeof transcribeAudioAttachment | null) {
		activeTranscribeAudio = fn ?? transcribeAudioAttachment;
	},
	/**
	 * Pure projection of child-run event rows → the `childRunPreview` string the
	 * Tedix OS delegation receipt renders: the canonical `Raw result: …` envelope for a
	 * structured child result, or the prose fallback. Exposed so the producer's
	 * accept gate can be unit-tested against the SAME envelope the Tedix OS consumer
	 * unwraps without standing up the full enqueue/dispatch path.
	 */
	childRunPreviewFromEventsForTest: childRunPreviewFromEvents,
	latestActivityLabelFromEventsForTest: latestActivityLabelFromEvents,
};

/**
 * Read the governance policy for an org from its first active policy pack.
 * Fail-soft: returns null when no policy pack is configured or the read fails;
 * the kernel always falls back to safe defaults when the policy is absent.
 */

export /**
 * Read the governance policy for an org from its first active policy pack.
 * Fail-soft: returns null when no policy pack is configured or the read fails;
 * the kernel always falls back to safe defaults when the policy is absent.
 */
async function readOrgGovernancePolicy(
	context: BaseContext,
	organizationId: string,
): Promise<KernelGovernancePolicy | null> {
	try {
		const definition = await getActivePolicyPackDefinition(
			context.db,
			organizationId,
		);
		if (!definition) return null;
		return parseKernelGovernancePolicy(definition.governancePolicy ?? null);
	} catch {
		return null;
	}
}

/**
 * Read the conversation-scoped write pre-authorization allowlist (session
 * pre-auth) for a Home conversation. Source-of-truth is a JSON bag on the
 * conversation's most-recent kernel run metadata (`sessionWriteAllowlist`: an
 * array of `"app:tool"`/`"app:*"` entries) — no new schema, set by an operator
 * action on the conversation. Fail-soft: any read/parse issue yields `[]`, which
 * keeps the gate fail-closed (no session grants ⇒ writes stay human-gated unless
 * policy trusts them). Returns `null` when there is nothing to thread.
 */

export /**
 * Read the conversation-scoped write pre-authorization allowlist (session
 * pre-auth) for a Home conversation. Source-of-truth is a JSON bag on the
 * conversation's most-recent kernel run metadata (`sessionWriteAllowlist`: an
 * array of `"app:tool"`/`"app:*"` entries) — no new schema, set by an operator
 * action on the conversation. Fail-soft: any read/parse issue yields `[]`, which
 * keeps the gate fail-closed (no session grants ⇒ writes stay human-gated unless
 * policy trusts them). Returns `null` when there is nothing to thread.
 */
async function readSessionWriteAllowlist(
	context: BaseContext,
	input: {
		organizationId: string;
		conversationId: string;
	},
): Promise<string[] | null> {
	try {
		// Scan recent conversation runs (not just the single latest — the current
		// turn's run is inserted persist-first and carries no grant) for the most
		// recent run that pins a `sessionWriteAllowlist`. Most runs lack it, so the
		// scan finds the operator's grant rather than shadowing it.
		const rows = await listKernelRuntimeRunMetadata(context.db, {
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			limit: 20,
		});
		for (const row of rows) {
			const raw = (row.metadata as Record<string, unknown> | null)
				?.sessionWriteAllowlist;
			if (!Array.isArray(raw)) continue;
			const allowlist = raw
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter((value) => value.length > 0)
				.slice(0, 50);
			if (allowlist.length > 0) return allowlist;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Whether the EXPLICIT (operator-picked) delegation requested an embodied
 * execution surface — shell, files, repo, a long-running process, or browser
 * automation. The kernel-planned `delegate_tedi` route derives this from the
 * route's `effortClass === "embodied"` (see `routeNeedsEmbodiedSurface` in
 * delegation-dispatch.ts); the explicit `delegateToTediId` path has NO route and
 * therefore NO effort budget, so the need half of the (needs × capability)
 * work-order decision has to be threaded in by the caller. Absent / non-true ⇒
 * NATIVE: a purely cognitive ask ("report git HEAD", a remote-MCP read, an
 * analysis) on an embodied tedi must stay on the Agent-runtime isolate Think
 * loop and NEVER cold-spawn a workstation. Reserve workstations for embodied
 * work by requiring an explicit truthy signal.
 *
 * Recognized signals on `input.metadata` (any one true ⇒ embodied):
 *  - `needsEmbodiedSurface: true`
 *  - `requireWorkstation: true`
 *  - `effortClass: "embodied"` (mirrors the kernel route vocabulary verbatim)
 */

/**
 * Whether the EXPLICIT (operator-picked) delegation requested an embodied
 * execution surface — shell, files, repo, a long-running process, or browser
 * automation. The kernel-planned `delegate_tedi` route derives this from the
 * route's `effortClass === "embodied"` (see `routeNeedsEmbodiedSurface` in
 * delegation-dispatch.ts); the explicit `delegateToTediId` path has NO route and
 * therefore NO effort budget, so the need half of the (needs × capability)
 * work-order decision has to be threaded in by the caller. Absent / non-true ⇒
 * NATIVE: a purely cognitive ask ("report git HEAD", a remote-MCP read, an
 * analysis) on an embodied tedi must stay on the Agent-runtime isolate Think
 * loop and NEVER cold-spawn a workstation. Reserve workstations for embodied
 * work by requiring an explicit truthy signal.
 *
 * Recognized signals on `input.metadata` (any one true ⇒ embodied):
 *  - `needsEmbodiedSurface: true`
 *  - `requireWorkstation: true`
 *  - `effortClass: "embodied"` (mirrors the kernel route vocabulary verbatim)
 */
export function explicitDelegationNeedsEmbodiedSurface(
	metadata: unknown,
): boolean {
	const record = nonNullRecord(metadata);
	if (!record) return false;
	if (record.needsEmbodiedSurface === true) return true;
	if (record.requireWorkstation === true) return true;
	if (record.effortClass === "embodied") return true;
	return false;
}

export function normalizeAttachmentContent(input: {
	content: string;
	mimeType: string;
	type: string;
}): string {
	if (input.type !== "audio") return input.content;
	if (
		input.content.startsWith("data:") ||
		input.content.startsWith("blob:") ||
		input.content.startsWith("http://") ||
		input.content.startsWith("https://")
	) {
		return input.content;
	}
	return `data:${input.mimeType};base64,${input.content}`;
}

export function normalizeMessageAttachments<
	T extends
		| Array<{
				content: string;
				mimeType: string;
				type: string;
		  }>
		| undefined,
>(attachments: T): T {
	if (!attachments) return attachments;
	return attachments.map((attachment) => ({
		...attachment,
		content: normalizeAttachmentContent(attachment),
	})) as T;
}

export type KernelCorrectionSignal = {
	action: "kernel.route_corrected";
	correctedAt: string;
	correctionSignal: string;
	operatorNote: string | null;
	priorRouteKind: string | null;
	priorRouterVersion: string | null;
	priorRunFound: boolean;
	priorRunId: string;
	priorRunStatus: string | null;
	source: "kernelRuntime.enqueueMessage";
};

export function correctionRunIdFromMetadata(
	metadata: Record<string, unknown>,
): string | null {
	return (
		stringFromPayload(metadata.correctionOf) ??
		stringFromPayload(nonNullRecord(metadata.correction)?.runId) ??
		null
	);
}

export async function buildKernelCorrectionSignal(
	context: BaseContext,
	input: {
		createdAt: string;
		metadata: Record<string, unknown>;
		organizationId: string;
	},
): Promise<KernelCorrectionSignal | null> {
	const priorRunId = correctionRunIdFromMetadata(input.metadata);
	if (!priorRunId) return null;
	const baseSignal: KernelCorrectionSignal = {
		action: "kernel.route_corrected" as const,
		correctedAt: input.createdAt,
		correctionSignal:
			stringFromPayload(input.metadata.correctionSignal) ??
			"explicit_caller_metadata",
		operatorNote:
			stringFromPayload(input.metadata.operatorNote) ??
			stringFromPayload(input.metadata.correctionNote) ??
			null,
		priorRouteKind: null,
		priorRouterVersion: null,
		priorRunFound: false,
		priorRunId,
		priorRunStatus: null,
		source: "kernelRuntime.enqueueMessage" as const,
	};
	try {
		const priorRun = await getKernelRuntimeRun(context.db, {
			id: priorRunId,
			organizationId: input.organizationId,
		});
		if (!priorRun) return baseSignal;
		const priorMetadata = nonNullRecord(priorRun.metadata) ?? {};
		const priorRoute = nonNullRecord(priorMetadata.kernelRoute) ?? {};
		return {
			...baseSignal,
			priorRouteKind: stringFromPayload(priorRoute.routeKind) ?? null,
			priorRouterVersion:
				stringFromPayload(priorMetadata.routerVersion) ??
				stringFromPayload(priorRoute.routerVersion) ??
				null,
			priorRunFound: true,
			priorRunStatus: priorRun.status,
		};
	} catch (error) {
		if (shouldFailSoftHomeRunSetRead(error)) {
			console.warn("[kernelRuntime] correction prior-run read failed", {
				error: errorMessage(error),
				priorRunId,
			});
			return baseSignal;
		}
		throw error;
	}
}

export async function readHomePlanningTargets(
	context: BaseContext,
	organizationId: string,
): Promise<HomePlanningTarget[]> {
	try {
		const rows = (await listOrganizationTedis(
			context.db,
			organizationId,
			50,
		)) as HomePlanningTarget[];
		const skippedTedis: Array<{
			id: string;
			health: string;
		}> = [];
		const reachable = rows.filter((target) => {
			const health = healthForIsolateTedi(target);
			if (health === "unreachable" || health === "stopped") {
				skippedTedis.push({
					id: target.id,
					health,
				});
				return false;
			}
			return true;
		});
		if (skippedTedis.length > 0) {
			console.warn(
				"[kernelRuntime] roster preflight: skipped unreachable/stopped isolate tedis",
				{
					skippedTedis,
				},
			);
		}
		return reachable;
	} catch (error) {
		console.warn(
			"[kernelRuntime] planning target read failed",
			errorMessage(error),
		);
		return [];
	}
}

export async function maybeBuildHomePlan(input: {
	content: string;
	context: BaseContext;
	createdAt: string;
	objectiveId?: string;
	organizationId: string;
	runId: string;
}): Promise<{
	plan: HomePlan;
	usage: KernelRouteUsage | null;
} | null> {
	if (!detectsHomePlanningRequest(input.content)) return null;
	const targets = selectedHomePlanTargets({
		content: input.content,
		targets: await readHomePlanningTargets(input.context, input.organizationId),
	});
	if (targets.length < 2) return null;
	// KERNEL_MAX_PLAN_OWNERS: configurable owner cap for the plan path (default 16).
	// Fail-soft: bad value → default.
	const maxPlanOwners = (() => {
		const raw = (
			input.context.env as unknown as {
				KERNEL_MAX_PLAN_OWNERS?: string;
			}
		).KERNEL_MAX_PLAN_OWNERS;
		if (raw !== undefined && raw !== "") {
			const n = Number.parseInt(raw, 10);
			if (Number.isFinite(n) && n >= 1) return n;
		}
		return 16;
	})();
	const planTargets = targets.slice(0, maxPlanOwners);
	// Plan v1: decompose the request into a SPECIFIC per-owner objective via the
	// router LLM (roster-grounded — keyed by owner id, re-validated inside
	// planTediAssignments). Bounded + fail-soft: a timeout / generation failure /
	// missing model leaves `objectives` null and every owner falls back to the v0
	// template, so the plan path never regresses.
	let objectives: Map<string, string> | null = null;
	let planUsage: KernelRouteUsage | null = null;
	// Inferred cross-owner blocking edges (blocker → dependent), roster-validated
	// and cycle-pruned by the planner. Empty on fail-soft; wired into the plan
	// literal below so approval can materialize them as work_item_relations.
	let dependencies: PlanDependencyEdge[] = [];
	try {
		const planResult = await withTimeout(
			planTediAssignments({
				content: input.content,
				targets: planTargets.map((target) => ({
					id: target.id,
					label: tediPlanningLabel(target),
					slug: target.slug ?? null,
				})),
				model: kernelModel(
					input.context.env as unknown as KernelEnv,
					undefined,
					input.organizationId,
				),
				maxOwners: maxPlanOwners,
			}),
			PLAN_DECOMPOSITION_TIMEOUT_MS,
			"kernelRuntime.planDecomposition",
		);
		objectives = planResult.objectives;
		planUsage = planResult.usage;
		dependencies = planResult.dependencies;
	} catch (error) {
		console.warn(
			"[kernelRuntime] plan decomposition bounded-out; using v0 template",
			errorMessage(error),
		);
		objectives = null;
		planUsage = null;
		dependencies = [];
	}
	const assignments = planTargets.map((target, index) =>
		buildHomePlanAssignment({
			content: input.content,
			index,
			runId: input.runId,
			target,
			objective: objectives?.get(target.id) ?? null,
		}),
	);
	const plan: HomePlan = {
		id: `${input.runId}:plan`,
		status: "proposed",
		summary: `Drafted ${assignments.length} Agent-runtime assignments for operator approval.`,
		// v1 when the LLM decomposed ≥1 owner objective; v0 when every owner fell
		// back to the template (no model / timeout / failure) — an observability
		// signal for which plan path produced the assignments.
		source:
			objectives && objectives.size > 0
				? "kernelRuntime.plan.v1"
				: "kernelRuntime.plan.v0",
		createdAt: input.createdAt,
		objectiveId: input.objectiveId ?? null,
		assignments,
		// Inferred cross-owner dependency edges (blocker → dependent). The planner
		// keys them by owner id (== assignment.ownerTediId), so the map to the
		// back-compat snapshot shape is a direct rename, no resolution. Persisted in
		// the run snapshot so approval can materialize them into work_item_relations.
		dependencies: dependencies.map((edge) => ({
			fromOwnerTediId: edge.fromOwner,
			toOwnerTediId: edge.toOwner,
			reason: edge.reason,
		})),
		attentionRoutes: assignments.map((assignment) => ({
			id: `${assignment.id}:attention-route`,
			ownerTediId: assignment.ownerTediId,
			ownerLabel: assignment.ownerLabel,
			routeKind: assignment.routeKind,
			confidence: assignment.confidence,
			risk: assignment.risk,
			novelty: "known",
			rationale:
				"Operator explicitly named this Agent-runtime tedi in a multi-owner Home request.",
			policy: "home.attention-route.v0",
			outcome: "proposed",
		})),
	};
	return {
		plan,
		usage: planUsage,
	};
}

export function kernelPlanAssistantContent(plan: HomePlan): string {
	const rows = plan.assignments
		.map(
			(assignment, index) =>
				`${index + 1}. ${assignment.ownerLabel}: ${assignment.objective}`,
		)
		.join("\n");
	const homeRunId = plan.id.endsWith(":plan")
		? plan.id.slice(0, -":plan".length)
		: plan.id;
	return `I drafted a Home plan with ${plan.assignments.length} proposed assignments. Review them before dispatch:\n${rows}\n\nApprove all: tedix approve ${homeRunId} (interactive: /approve ${homeRunId})\nReject all: tedix reject ${homeRunId} (interactive: /reject ${homeRunId})`;
}

export function readKernelPlanFromRun(row: KernelRuntimeRun): HomePlan {
	const metadata = nonNullRecord(row.metadata);
	const parsed = HomePlanSchema.safeParse(metadata?.homePlan);
	if (!parsed.success) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Home run does not contain an approvable Home plan",
		);
	}
	return parsed.data;
}

export function kernelPlanWorkItemTitle(
	assignment: HomePlan["assignments"][number],
) {
	const prefix = assignment.ownerLabel.trim() || "Tedi";
	const objective = previewPlanContent(assignment.objective);
	return `${prefix}: ${objective}`;
}

export function kernelPlanWorkItemDescription(input: {
	assignment: HomePlan["assignments"][number];
	homeRunId: string;
	plan: HomePlan;
	sourceRequest?: string | null;
}) {
	const evidence = input.assignment.expectedEvidence
		.map((item) => `- ${item}`)
		.join("\n");
	const sourceRequest = input.sourceRequest ?? "";
	return [
		input.assignment.objective,
		"",
		HOME_PLAN_ASSIGNMENT_SCOPE_INSTRUCTIONS,
		...(sourceRequest
			? ["", "Original Home request (supporting context only):", sourceRequest]
			: []),
		"",
		"Expected evidence:",
		evidence || "- Result summary tied back to the Home request.",
		"",
		`Home plan: ${input.plan.id}`,
		`Home run: ${input.homeRunId}`,
	].join("\n");
}

export function readPayloadText(
	payload: Record<string, unknown> | undefined,
): string {
	return (
		stringFromPayload(payload?.content) ??
		stringFromPayload(payload?.text) ??
		stringFromPayload(nonNullRecord(payload?.message)?.content) ??
		""
	);
}

export function readPayloadAttachments(
	payload: Record<string, unknown> | undefined,
): HomeMessage["attachments"] {
	if (!Array.isArray(payload?.attachments)) return undefined;
	const attachments: NonNullable<HomeMessage["attachments"]> =
		payload.attachments.flatMap((attachment) => {
			const record = nonNullRecord(attachment);
			const content = stringFromPayload(record?.content);
			const durationMs = numberFromPayload(record?.durationMs);
			const fileName = stringFromPayload(record?.fileName);
			const mimeType = stringFromPayload(record?.mimeType);
			const size = numberFromPayload(record?.size);
			const type = stringFromPayload(record?.type);
			if (
				!content ||
				!fileName ||
				!mimeType ||
				(type !== "audio" && type !== "file" && type !== "image")
			) {
				return [];
			}
			return [
				{
					content: normalizeAttachmentContent({
						content,
						mimeType,
						type,
					}),
					...(durationMs && durationMs > 0
						? {
								durationMs,
							}
						: {}),
					fileName,
					mimeType,
					...(size !== undefined && size >= 0
						? {
								size,
							}
						: {}),
					type,
				},
			];
		});
	return attachments.length > 0 ? attachments : undefined;
}

export function readPayloadRole(
	payload: Record<string, unknown> | undefined,
	kind: string,
): TediMessageRole {
	const role = stringFromPayload(payload?.role);
	if (
		role === "system" ||
		role === "user" ||
		role === "assistant" ||
		role === "tool" ||
		role === "runtime"
	) {
		return role;
	}
	return kind === "message.received" ? "user" : "assistant";
}

export function normalizeChildRuntime(row: {
	runtimeBackend: string;
	runtimeExternalId?: string | null;
	runtimeExternalUrl?: string | null;
	runtimeMetadata?: Record<string, unknown> | null;
}): TediRuntimeRef {
	return {
		backend: row.runtimeBackend as TediRuntimeRef["backend"],
		externalId: row.runtimeExternalId ?? undefined,
		externalUrl: row.runtimeExternalUrl ?? undefined,
		metadata: nonNullRecord(row.runtimeMetadata),
	};
}

export function normalizeChildRuntimeEvent(
	row: TediRuntimeEventRow,
): TediRuntimeEvent {
	return {
		id: row.id,
		tediId: row.tediId,
		kind: row.kind,
		conversationId: row.conversationId ?? undefined,
		runId: row.runId ?? undefined,
		messageId: row.messageId ?? undefined,
		toolCallId: row.toolCallId ?? undefined,
		approvalRequestId: row.approvalRequestId ?? undefined,
		artifactId: row.artifactId ?? undefined,
		sequence: row.sequence ?? undefined,
		delta: row.delta ?? undefined,
		payload: nonNullRecord(row.payload),
		runtime: normalizeChildRuntime(row),
		createdAt: row.createdAt,
	};
}

export function normalizeChildArtifact(row: TediArtifactRow): TediArtifact {
	const privateRuntime = row.accessClassification === "runtime_private";
	return {
		id: row.id,
		tediId: row.tediId,
		conversationId: row.conversationId ?? undefined,
		runId: row.runId ?? undefined,
		messageId: row.messageId ?? undefined,
		kind: row.kind,
		name: row.name,
		mimeType: row.mimeType ?? null,
		uri: privateRuntime ? undefined : (row.uri ?? undefined),
		sizeBytes: row.sizeBytes ?? null,
		metadata: privateRuntime ? undefined : nonNullRecord(row.metadata),
		accessClassification: row.accessClassification,
		createdAt: row.createdAt,
	};
}

export function normalizeHomeMessage(
	row: KernelRuntimeEvent,
	completedRuns: Map<string, string>,
	childRunStatuses: Map<string, Record<string, unknown>> = new Map(),
	homeRunsById: Map<string, HomeRun> = new Map(),
): HomeMessage {
	const payload = nonNullRecord(row.payload);
	const homeRun = row.runId ? homeRunsById.get(row.runId) : undefined;
	const childRunStatus =
		row.delegatedTediId && row.childRunId
			? childRunStatuses.get(
					childRunStatusKey(row.delegatedTediId, row.childRunId),
				)
			: undefined;
	const metadataPayload = nonNullRecord(payload?.metadata);
	const homeRunMetadata = nonNullRecord(homeRun?.metadata);
	// When a run backs this message, defer to the run's classified terminal state
	// (itself produced via classifyHomeRunState in normalizeHomeRunRecord) so the
	// message surface can never disagree with the run surface on completed/pending.
	const runIsTerminal = homeRun
		? isTerminalHomeRunStatus(homeRun.status)
		: false;
	// ONE TURN, ONE STATUS. `homeRunMetadata` is the run surface's already
	// classified child-evidence block (`childRunStatus`/`childRunPreview`/
	// `childRunLatestEvent*`), and its producer deliberately refuses to read live
	// child evidence for a TERMINAL parent (`readChildRunStatusesForRunRows`
	// skips terminal rows) — a run the operator canceled stays canceled even if
	// the child it dispatched runs on and finishes afterwards.
	//
	// `childRunStatus` here is a SECOND, independent live read of that same child
	// (`readChildRunStatuses`) that has no such guard. Spreading it last used to
	// clobber the parent's terminal state, so a canceled turn rendered a
	// "Completed" delegation receipt directly above its own "The delegated tedi
	// assignment was canceled." completion prose (observed live). Apply the live
	// overlay only while the parent run is still non-terminal; once the parent is
	// terminal its persisted classification is authoritative for both surfaces.
	const liveChildRunStatus = runIsTerminal ? undefined : childRunStatus;
	const enrichedPayload = liveChildRunStatus
		? {
				...payload,
				metadata: {
					...metadataPayload,
					...homeRunMetadata,
					...liveChildRunStatus,
					progress: homeRun?.progress ?? homeRunMetadata?.progress,
				},
			}
		: homeRun
			? {
					...payload,
					metadata: {
						...metadataPayload,
						...homeRunMetadata,
						progress: homeRun.progress,
					},
				}
			: payload;
	const role = readPayloadRole(payload, row.kind);
	const completedAt = row.runId ? completedRuns.get(row.runId) : undefined;
	return {
		id: row.messageId ?? row.id,
		organizationId: row.organizationId,
		conversationId: row.conversationId,
		runId: row.runId ?? undefined,
		delegatedTediId: row.delegatedTediId ?? undefined,
		childRunId: row.childRunId ?? undefined,
		role,
		status:
			row.kind === "message.completed" || completedAt || runIsTerminal
				? "completed"
				: "pending",
		content: row.delta ?? readPayloadText(enrichedPayload),
		attachments: readPayloadAttachments(enrichedPayload),
		runtime: normalizeRuntime(row),
		createdAt: row.createdAt,
		startedAt: row.createdAt,
		completedAt:
			row.kind === "message.completed"
				? row.createdAt
				: (homeRun?.completedAt ?? completedAt),
		metadata: enrichedPayload,
	};
}

export function childRunControlForStatus(
	status: HomeChildRunEvidence["status"],
): HomeChildRunEvidence["control"] {
	switch (status) {
		case "partial":
		case "completed":
		case "failed":
		case "canceled":
			return {
				canStop: false,
				reason:
					"The delegated runtime owner has already published a terminal run event.",
				state: "terminal",
			};
		case "running":
		case "streaming":
		case "queued":
		case "requires_approval":
			return {
				canStop: true,
				reason:
					"The delegated runtime owner has not published a terminal event yet.",
				state: "stoppable",
			};
		default:
			return {
				canStop: false,
				reason:
					"The delegated runtime owner has not published control state yet.",
				state: "unknown",
			};
	}
}

/**
 * Materialize a Home plan's inferred cross-owner dependency edges into canonical
 * `work_item_relations` rows at approval time — the moment the plan's owners first
 * have Work Items. Each plan edge is BLOCKER → DEPENDENT (`fromOwnerTediId`
 * finishes before `toOwnerTediId` starts); we map it 1:1 (no flip) to a
 * `relationType:"blocks"` row with `fromWorkItemId` = the blocker's Work Item and
 * `toWorkItemId` = the dependent's — the EXACT direction the dispatch-time gate
 * (`queryWorkItemBlockers`) reads. `ownerToWorkItemId` is built by the approval
 * pre-pass (owner tedi id → just-created Work Item id); an edge whose endpoint was
 * not approved this turn (partial approval) or that is a self-edge is skipped.
 *
 * `addWorkItemRelation` is idempotent (onConflictDoUpdate on the unique
 * from/to/type index), so a re-approval never duplicates a relation. Fail-soft:
 * a per-edge or outer failure NEVER throws — it must not break the approval /
 * dispatch path (mirrors surfaceUnblockedDependents).
 */
