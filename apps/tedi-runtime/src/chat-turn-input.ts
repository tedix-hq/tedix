import type { WorkflowImageRef } from "./workflow-image-handoff";
import type { TurnModelSelection } from "@tedix/api-contract/schemas/automation-events";
import type { DelegationAuthorityEnvelope } from "@tedix/api-contract/schemas/kernel-runtime";
import type { RepositoryMode } from "./runtime-tool-guidance";
import type { ExecutionSurface } from "@tedix/api-contract/schemas/execution-evidence";
import type { DelegationAuthorityMode } from "./delegation-authority";
import type { TrustedInstructionOrigin } from "./inference-guardrails";
import type { FacetWorkflowTurnInput } from "./delegated-work-lease";

/**
 * Caller-supplied payload for a single chat turn. The turn context (system
 * prompt, tools, history) is rebuilt server-side inside the facet-turn step
 * from DO state — we only pass the new user message + turn metadata across the
 * workflow boundary.
 */
export interface ChatTurnParams {
	/** Durable Object name of the originating Agent. Persisted so each retry can
	 * reacquire a fresh RPC stub after a Worker/DO code update. */
	agentName?: string;
	/** Session key (e.g. `agent:main:main` or `email:{threadId}`). */
	sessionKey: string;
	/** The user message being processed this turn. */
	userText: string;
	/** Private R2 descriptors; bytes materialize only in the model inference step. */
	imageRefs?: WorkflowImageRef[];
	/** Epoch ms the user message arrived — used ONLY for `createdAt` timestamps. */
	userTs: number;
	/** Conversation id (matches the ledger conversation key). */
	conversationId: string;
	/**
	 * STABLE per-turn run id, `${tediId}:${surface}:${turnKey}` where `turnKey`
	 * is derived by the caller from `clientRequestId` (the inbound client id) via
	 * `buildRunId` — never a wall-clock. The `{runId}:{seq}` event-id dedup keys
	 * on this, so the caller MUST build it from `clientRequestId`, not `userTs`.
	 */
	runId: string;
	/** Cross-layer MCP trace propagated into every mirrored runtime event. */
	traceId?: string;
	/** Disable adaptive after-turn learning for read-only validation/cleanup turns. */
	learningMode?: "normal" | "disabled";
	/** Work Item supervising this delegated turn, when dispatched by Home. */
	workItemId?: string;
	/** Parent Home run that owns this delegated turn, when present. */
	homeRunId?: string;
	/** Enforced execution surface selected by the Kernel work order. */
	executionSurface?: ExecutionSurface;
	/** Presentation selected from the existing code-proof/capability metadata; no authority. */
	repositoryMode?: RepositoryMode;
	/** Server-derived delegated activity/tool ceiling. */
	authorityEnvelope?: DelegationAuthorityEnvelope;
	/** Enforce fails closed if the envelope is lost; shadow preserves rollout. */
	authorityMode?: DelegationAuthorityMode;
	/**
	 * Internal trust provenance for a turn the runtime itself authored — an
	 * authenticated persisted scheduler record, or a detached command's
	 * completion. Never set this from an inbound user message.
	 */
	trustedInstructionOrigin?: TrustedInstructionOrigin;
	/**
	 * This turn's model in place of the tedi's chat policy (`turnModelForInject`:
	 * reply-draft turns only). Memory, persona and tools are unchanged.
	 */
	turnModel?: TurnModelSelection;
	/**
	 * Original client request id from the inbound `chat.send` frame / MCP send.
	 * It is the turnKey source for `runId`, and is also echoed on broadcast
	 * deltas so clients can correlate. Required for a stable runId.
	 */
	clientRequestId: string;
}

/** One payload projection for inference, native observation, and continuation. */
export function buildFacetWorkflowTurnInput(
	params: ChatTurnParams & Pick<FacetWorkflowTurnInput, "operatorConsent">,
	computerContinuation?: number,
): FacetWorkflowTurnInput {
	return { ...params, computerContinuation };
}

export function buildFacetComputerExecutionsInput(
	params: ChatTurnParams & Pick<FacetWorkflowTurnInput, "operatorConsent">,
	computerContinuation: number,
	executionIds: string[],
): FacetWorkflowTurnInput & { executionIds: string[] } {
	return {
		...buildFacetWorkflowTurnInput(params, computerContinuation),
		executionIds: [...executionIds],
	};
}
