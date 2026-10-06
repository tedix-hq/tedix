/**
 * ChatTurnWorkflow — durable chat-turn orchestration for AgentTediDO.
 *
 * Status: the DURABLE turn path (not the interactive-chat default).
 *
 * The Cloudflare Agents SDK workflow guidance is explicit: chat = "Agent
 * only", Workflow = ">30s / multi-step / approval". Interactive turns run on
 * per-conversation native Pi facets inline in `do.ts`; this workflow carries the
 * turns that must survive eviction/deploy:
 *   - Home→tedi DELEGATED turns (async-inject re-routes them here — see
 *     `runWorkflow(...)` call sites in `do.ts`).
 *   - MCP `run_tedi_turn`
 *     (`durable-messages-send.ts`).
 *
 * The workflow no longer drives a bespoke per-round `runLlmRound` / `executeWorkflowTool` loop — the
 * turn executes on the conversation's OWN ConversationFacet via the native Pi
 * `chat()` loop, exactly like the inline MCP path, through one
 * durable `facet-turn` step (`agent.runFacetWorkflowTurn`). The workflow keeps
 * ONLY the durable submission/settlement contract:
 *
 *   - `mark-workflow-started` proves the instance reached user code (the
 *     Agent-side watchdog re-drives an instance whose checkpoint never lands).
 *   - `facet-turn` is IDEMPOTENT end-to-end: `runFacetWorkflowTurn` first
 *     returns the already-settled `{runId}:2` assistant row (redelivery /
 *     resume after settlement), and every write it performs is dedup-keyed
 *     (`{runId}:0` user append, `{runId}:2` assistant commit via
 *     `commitAssistantTurn`, `{runId}:{seq}` ledger events, content-hash brain
 *     bridge) — so a workflow re-drive after a mid-turn eviction re-runs the
 *     model but settles exactly once.
 *   - A transient turn error THROWS out of the step: the explicit retry policy
 *     re-drives it on a fresh isolate (deploy-collision window). Deterministic
 *     daily-budget and billing-policy refusals return typed terminal results
 *     instead, so they cannot consume retries. Agents SDK reports an unhandled
 *     workflow error through `onWorkflowError`; individual step retries do not
 *     emit runtime ledger progress. Native command observations publish their
 *     own progress after validating the original Attempt and execution identity.
 *     The Agent reconciles the error callback against native
 *     Workflow status and seals failure only after native `errored` /
 *     `terminated` settlement — a retrying turn is never mislabeled terminal
 *     or silently dropped.
 *   - A SETTLED turn durably reports completion (`step.reportComplete` inside
 *     `driveChatTurnSteps`) — the SDK only auto-reports errors, so without
 *     this `onWorkflowComplete` never fires on the DO: cron execution stamps
 *     stay `running` forever and wfctx/fan-out cleanup leaks.
 *
 * Streaming: the facet path broadcasts the final `assistant.done` frame from
 * `commitAssistantTurn`. Mid-turn deltas are not streamed on the durable path
 * (parity with the earlier tool rounds, which also only broadcast the
 * terminal frame when tools were in play); live token streaming belongs to the
 * Tedix OS SSE facet path.
 */

import { NonRetryableError } from "cloudflare:workflows";
import { getAgentByName } from "agents";
import {
	AgentWorkflow,
	type AgentWorkflowEvent,
	type AgentWorkflowStep,
} from "agents/workflows";
import { billingPolicyDeniedWorkflowResult } from "./billing-reservation-client";
import { type ChatTurnStepResult, driveChatTurnSteps } from "./chat-turn-steps";
import {
	type ChatTurnParams,
	buildFacetWorkflowTurnInput,
	buildFacetComputerExecutionsInput,
} from "./chat-turn-input";
import {
	budgetExhaustedWorkflowResult,
	isInferenceBudgetExhaustedError,
} from "./cron-budget-control";
import type { AgentTediDO } from "./do";
import { recoverDurableObjectDeploymentReset } from "./durable-object-recovery";
import { providerErrorWorkflowResult } from "./provider-error-settlement";
import { runtimeErrorWorkflowResult } from "./runtime-error-settlement";

export interface ChatTurnProgress {
	step?: string;
	round?: number;
	status?: "pending" | "running" | "complete" | "error";
	message?: string;
	[key: string]: unknown;
}

type DisposableRpcValue = {
	dispose?: () => void;
	[Symbol.dispose]?: () => void;
};

function disposeRpcValue(value: unknown): void {
	const disposable = value as DisposableRpcValue | null | undefined;
	const dispose =
		typeof disposable?.[Symbol.dispose] === "function"
			? disposable[Symbol.dispose]
			: disposable?.dispose;
	if (typeof dispose !== "function") return;
	dispose.call(disposable);
}

export class ChatTurnWorkflow extends AgentWorkflow<
	AgentTediDO,
	ChatTurnParams,
	ChatTurnProgress
> {
	private async withFreshAgent<T>(
		params: ChatTurnParams,
		operation: (agent: DurableObjectStub<AgentTediDO>) => Promise<T>,
	): Promise<T> {
		const agentName = params.agentName?.trim();
		if (!agentName) return operation(this.agent);
		const agent = await getAgentByName<CloudflareEnv, AgentTediDO>(
			this.env.TEDI_AGENT,
			agentName,
		);
		try {
			return await operation(agent);
		} finally {
			disposeRpcValue(agent);
		}
	}

	private async withRecoverableFreshAgent<T>(
		params: ChatTurnParams,
		operation: (agent: DurableObjectStub<AgentTediDO>) => Promise<T>,
	): Promise<T> {
		return recoverDurableObjectDeploymentReset(() =>
			this.withFreshAgent(params, operation),
		);
	}

	/**
	 * Step sequence, retry budgets, and the terminal completion report live in
	 * `driveChatTurnSteps` (`chat-turn-steps.ts`) — the durable completion
	 * report is what invokes `onWorkflowComplete` on the DO (the SDK only
	 * auto-reports errors), which seals cron execution stamps and cleans up the
	 * wfctx dispatch record. This class only binds the steps to the DO stub.
	 */
	async run(
		event: AgentWorkflowEvent<ChatTurnParams>,
		step: AgentWorkflowStep,
	): Promise<ChatTurnStepResult> {
		const params = { ...event.payload, workflowInstanceId: event.instanceId };
		return driveChatTurnSteps(step, {
			// First durable callback: proves the Workflow instance progressed beyond
			// admission/queueing and reached user code. The Agent-side watchdog
			// restarts the same instance id only when this checkpoint never lands.
			markStarted: async () => {
				await this.withRecoverableFreshAgent(params, (agent) =>
					agent.markChatWorkflowStarted(event.instanceId, params.runId),
				);
			},
			// The whole turn — context assembly, the facet `chat()` loop (tools
			// served parent-side via the per-runId proxy registry), and settlement
			// (`commitAssistantTurn`: keyed assistant append, awaited ledger mirror,
			// memory effects, final broadcast) — runs as ONE durable step on the DO.
			// Idempotent per the header contract; the step memoizes the result so a
			// post-settlement resume never re-runs the model.
			runFacetTurn: async (computerContinuation) => {
				let raw: unknown;
				try {
					raw = await this.withRecoverableFreshAgent(params, (agent) =>
						agent.runFacetWorkflowTurn(
							buildFacetWorkflowTurnInput(params, computerContinuation),
						),
					);
				} catch (error) {
					if (
						error instanceof Error &&
						error.message.startsWith("computer_continuation_failed:")
					)
						throw new NonRetryableError(error.message);
					const runtimeTerminal = runtimeErrorWorkflowResult(error);
					if (runtimeTerminal) return JSON.stringify(runtimeTerminal);
					// Daily-budget admission is deterministic for the current UTC
					// window. Return a typed terminal result so Workflow does not burn
					// its five transient-error retries on the same rejected request.
					if (isInferenceBudgetExhaustedError(error)) {
						return JSON.stringify(budgetExhaustedWorkflowResult(error));
					}
					const billingDenied = billingPolicyDeniedWorkflowResult(error);
					if (billingDenied) return JSON.stringify(billingDenied);
					// Third member of the same family: a DEFINITELY non-retryable
					// provider fault (rejected key, unknown deployment, context
					// overflow, exhausted quota) is deterministic for this payload.
					// Seal it now instead of burning five 15s retries re-running the
					// model to learn the same thing. Anything the classifier does not
					// positively recognize stays retryable and falls through.
					const providerTerminal = providerErrorWorkflowResult(error);
					if (providerTerminal) {
						console.error(
							"[chat-turn-workflow] provider fault sealed terminal",
							{
								runId: params.runId,
								conversationId: params.conversationId,
								family: providerTerminal.providerErrorFamily,
							},
						);
						return JSON.stringify(providerTerminal);
					}
					throw error;
				}
				try {
					return JSON.stringify(raw);
				} finally {
					disposeRpcValue(raw);
				}
			},
			readComputerExecutions: async (computerContinuation, executionIds) => {
				const raw = await this.withRecoverableFreshAgent(params, (agent) =>
					agent.readFacetComputerExecutions(
						buildFacetComputerExecutionsInput(
							params,
							computerContinuation,
							executionIds,
						),
					),
				).catch((error: unknown) => {
					if (
						error instanceof Error &&
						error.message.startsWith("computer_continuation_failed:")
					)
						throw new NonRetryableError(error.message);
					const terminal = runtimeErrorWorkflowResult(error);
					if (terminal?.error.startsWith("delegated_work_authority_lost: "))
						throw new NonRetryableError(terminal.error);
					throw error;
				});
				try {
					return {
						ready: raw.ready,
						retryAfterSeconds: raw.retryAfterSeconds,
					};
				} finally {
					disposeRpcValue(raw);
				}
			},
		});
	}
}
