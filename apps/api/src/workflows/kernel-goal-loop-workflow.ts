import { providerDeploymentScope } from "@tedix/api-contract/schemas/provider-execution";
import { resolveProviderModelRate } from "../services/provider-model-pricing";
import type { KernelPricingEvidence } from "@tedix/api-contract/schemas/cost-provenance";
/**
 * KernelGoalLoopWorkflow
 *
 * Durable Cloudflare Workflow wrapper around the pure `runGoalLoop` driver
 * (`../rpc/routers/kernel/goal-loop.ts`), fulfilling the wrapper that file's
 * own header comment describes. Each turn survives a Workflow restart via
 * `step.do`/`step.sleep` checkpoints — the loop itself stays exactly as
 * tested in `goal-loop.test.ts`; only the ports are real here:
 *
 *   - `runTurn`: submits one Home turn via an internal
 *     service-binding kernel client (`X-Service-Binding` + `X-Tedix-Org-Id`,
 *     org-pinned with `tedis:write` to enqueue and `tedis:read` to poll), polls
 *     `readRun` to a terminal status, then reads
 *     the run's own final assistant message straight from `kernel_runtime_events`.
 *   - `checkWorkItems`: reads the canonical full-population leaf snapshot —
 *     the proof-gated `work_items` evaluator's completion oracle.
 *   - `judge`: {@link judgeGoalCondition} through governed Jev — the adversarial
 *     evaluator's separate typed judgment. Runs in its own `step.do` so a
 *     verdict is a durable checkpoint, not re-billed on Workflow restart.
 *
 * Wiring `judge` is a correctness fix, not a feature: while it was absent,
 * `runGoalLoop` fell back to the DETERMINISTIC checker for an
 * `evaluator: "adversarial"` goal, which does
 * `new RegExp(condition, "i").test(answer)` — so a natural-language condition
 * was compiled as a REGEX against the maker's own answer. That either threw
 * (unbalanced parens in ordinary prose) or, worse, silently returned `done`
 * as soon as the maker RESTATED THE GOAL in its reply — precisely the
 * maker-grades-its-own-homework failure adversarial mode exists to prevent.
 *
 * `judgeGoalCondition` fail-softs to `done:false` when Jev is unavailable or
 * uncertain. A provider failure can never declare a goal met.
 *
 * Triggered by: kernelRuntime.startGoalLoop oRPC procedure. Status is read
 * through the existing generic `workflows.getStatus` endpoint (registered
 * under the `goal_loop` WorkflowType) — no bespoke polling endpoint needed.
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createRouterClient } from "@orpc/server";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { listKernelRuntimeEvents } from "@tedix/db/queries/kernel-runtime-events";
import { getGoalLoopWorkItemSnapshot } from "@tedix/db/queries/work-items/crud";
import { type BaseContext, createContext } from "../rpc/orpc";
import {
	type GoalLoopEvaluator,
	type GoalLoopResult,
	type GoalLoopSettledTurn,
	type GoalLoopWorkItemsSnapshot,
	judgeGoalCondition,
	runGoalLoop,
} from "../rpc/routers/kernel/goal-loop";
import { type KernelEnv, kernelModel } from "../rpc/routers/kernel/llm";
import { kernelRuntimeContractRouter } from "../rpc/routers/kernel-runtime";

export interface KernelGoalLoopWorkflowParams {
	organizationId: string;
	content: string;
	condition: string;
	maxTurns?: number;
	budgetUsd?: number;
	evaluator?: GoalLoopEvaluator;
	/** Required for evaluator === "work_items" — see goal-loop.ts. */
	objectiveId?: string;
	/** Reuses an existing Home conversation when supplied; otherwise a fresh
	 * per-instance conversation id keeps the loop's automated turns out of
	 * the operator's primary Home feed. */
	conversationId?: string;
}

const TERMINAL_RUN_STATUSES = new Set([
	"completed",
	"failed",
	"canceled",
	"requires_approval",
]);
const POLL_INTERVAL_SECONDS = 10;
/** ~15 minutes per turn before the loop settles it as whatever status it last read. */
const MAX_POLL_ATTEMPTS = 90;
export const FINAL_ASSISTANT_MESSAGE_CHAR_CAP = 8_192;

export function internalKernelContext(
	env: CloudflareEnv,
	organizationId: string,
): BaseContext {
	const headers = new Headers();
	headers.set("X-Service-Binding", "true");
	headers.set("X-Tedix-Org-Id", organizationId);
	const base = createContext(
		new Request("https://api/internal/kernel-goal-loop", { headers }),
		env,
	);
	return {
		...base,
		organizationId,
		headers,
		authType: "service-binding",
		tediScopes: ["tedis:write", "tedis:read"],
	};
}

function kernelRuntimeClient(env: CloudflareEnv, organizationId: string) {
	return createRouterClient(kernelRuntimeContractRouter, {
		context: internalKernelContext(env, organizationId),
	});
}

/**
 * Pure pick: the first (DESC-ordered) row that is an assistant message with
 * non-empty content, capped and trimmed. Split out from the DB read below so
 * the picking/truncation logic is unit-testable without a live D1 binding.
 */
export function pickFinalAssistantMessageContent(
	rows: Array<{ payload: unknown }>,
): string | null {
	for (const row of rows) {
		const payload = row.payload as Record<string, unknown> | null;
		if (payload?.role !== undefined && payload.role !== "assistant") continue;
		const content =
			typeof payload?.content === "string" ? payload.content.trim() : "";
		if (!content) continue;
		return content.length > FINAL_ASSISTANT_MESSAGE_CHAR_CAP
			? content.slice(0, FINAL_ASSISTANT_MESSAGE_CHAR_CAP)
			: content;
	}
	return null;
}

/**
 * Read ONLY the run's own final assistant message (the latest
 * `message.completed` content) straight from `kernel_runtime_events` — the
 * Home-run-scoped analog of `readChildRunFinalAssistantMessage` (which reads
 * a DELEGATED child tedi's own event stream instead). Fail-soft: null on error,
 * same discipline as its child-run counterpart.
 */
async function readHomeRunFinalAssistantMessage(
	db: DbClient,
	input: { organizationId: string; runId: string },
): Promise<string | null> {
	try {
		const rows = await listKernelRuntimeEvents(db, {
			organizationId: input.organizationId,
			runId: input.runId,
			kind: "message.completed",
			order: "desc",
			limit: 20,
		});
		return pickFinalAssistantMessageContent(rows);
	} catch {
		return null;
	}
}

export class KernelGoalLoopWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	KernelGoalLoopWorkflowParams
> {
	async run(
		event: WorkflowEvent<KernelGoalLoopWorkflowParams>,
		step: WorkflowStep,
	): Promise<GoalLoopResult> {
		const { organizationId } = event.payload;
		const conversationId =
			event.payload.conversationId ??
			(await step.do("resolve-conversation-id", async () =>
				crypto.randomUUID(),
			));
		const db = createDbClient(this.env.DB);
		let turnCounter = 0;

		const runTurn = async (content: string): Promise<GoalLoopSettledTurn> => {
			turnCounter += 1;
			const turn = turnCounter;
			const selected = kernelModel(
				this.env,
				undefined,
				organizationId,
			)?.pricingIdentity;
			const rate = selected
				? await resolveProviderModelRate(this.env, {
						provider: selected.provider,
						modelId: selected.requestModel,
						deploymentScope: providerDeploymentScope(selected),
						occurredAt: new Date().toISOString(),
					})
				: null;
			if (rate?.status !== "resolved")
				return {
					runId: null,
					status: "pricing_unavailable",
					routeKind: null,
					costUsd: null,
					pricing: null,
					answer: "Model pricing is unavailable; no turn was submitted.",
				};

			const submitted = await step.do(
				`goal-turn-${turn}-submit`,
				{ retries: { limit: 2, delay: "5 seconds" }, timeout: "1 minute" },
				async () => {
					const client = kernelRuntimeClient(this.env, organizationId);
					const result = await client.enqueueMessage({
						organizationId,
						conversationId,
						content,
						idempotencyKey: `${event.instanceId}-turn-${turn}`,
						metadata: {
							source: "goal_loop",
							goalLoopInstanceId: event.instanceId,
							goalLoopTurn: turn,
							...(event.payload.objectiveId
								? { objectiveId: event.payload.objectiveId }
								: {}),
						},
					});
					return { runId: result.run.id, status: result.run.status };
				},
			);

			let runStatus: string = submitted.status;
			let attempt = 0;
			while (
				!TERMINAL_RUN_STATUSES.has(runStatus) &&
				attempt < MAX_POLL_ATTEMPTS
			) {
				attempt += 1;
				await step.sleep(
					`goal-turn-${turn}-poll-wait-${attempt}`,
					POLL_INTERVAL_SECONDS,
				);
				runStatus = await step.do(
					`goal-turn-${turn}-poll-${attempt}`,
					{ retries: { limit: 3, delay: "5 seconds" }, timeout: "30 seconds" },
					async () => {
						const client = kernelRuntimeClient(this.env, organizationId);
						const { run } = await client.readRun({
							organizationId,
							runId: submitted.runId,
						});
						return run.status;
					},
				);
			}

			// Poll budget exhausted with the run still non-terminal: cancel the
			// kernel run instead of abandoning it — an orphaned run keeps executing
			// (and billing) with no consumer for its result. Fail-soft: cancelRun
			// errors when the run went terminal between the last poll and this step
			// (the good case) — either way the settle step below reads the true
			// final status.
			if (!TERMINAL_RUN_STATUSES.has(runStatus)) {
				await step.do(
					`goal-turn-${turn}-cancel`,
					{ retries: { limit: 2, delay: "5 seconds" }, timeout: "30 seconds" },
					async () => {
						const client = kernelRuntimeClient(this.env, organizationId);
						try {
							await client.cancelRun({
								organizationId,
								runId: submitted.runId,
								reason: `goal_loop turn ${turn} poll budget exhausted (${MAX_POLL_ATTEMPTS} attempts, last status: ${runStatus})`,
							});
							return { canceled: true };
						} catch {
							return { canceled: false };
						}
					},
				);
			}

			return step.do(
				`goal-turn-${turn}-settle`,
				{ retries: { limit: 2, delay: "2 seconds" }, timeout: "30 seconds" },
				async () => {
					const client = kernelRuntimeClient(this.env, organizationId);
					const { run } = await client.readRun({
						organizationId,
						runId: submitted.runId,
					});
					const answer = await readHomeRunFinalAssistantMessage(db, {
						organizationId,
						runId: submitted.runId,
					});
					const kernelRoute = run.metadata?.kernelRoute as
						| { routeKind?: string }
						| null
						| undefined;
					return {
						runId: submitted.runId,
						status: run.status,
						routeKind: kernelRoute?.routeKind ?? null,
						costUsd:
							run.usage?.pricing &&
							["complete", "no_usage"].includes(
								run.usage.pricing.costCompleteness,
							)
								? run.usage.costUsd
								: null,
						pricing: run.usage?.pricing ?? null,
						answer: answer ?? "",
					};
				},
			);
		};

		// The adversarial checker. Runs in its own durable step so a verdict is
		// checkpointed (a Workflow restart never re-bills the judge pass), and is
		// keyed on the turn it judged so the two evaluators can never collide.
		const judge = async (args: {
			condition: string;
			answer: string;
		}): Promise<{
			done: boolean;
			runId: string | null;
			costUsd: number | null;
			pricing: KernelPricingEvidence | null;
		}> => {
			return step.do(
				`goal-turn-${turnCounter}-judge`,
				{ retries: { limit: 2, delay: "5 seconds" }, timeout: "2 minutes" },
				async () =>
					judgeGoalCondition({
						condition: args.condition,
						answer: args.answer,
						db,
						env: this.env,
						context: { organizationId, sessionKey: conversationId },
					}),
			);
		};

		const checkWorkItems = async (
			objectiveId: string,
		): Promise<GoalLoopWorkItemsSnapshot> => {
			return step.do(
				`goal-check-work-items-${turnCounter}`,
				{ retries: { limit: 2, delay: "2 seconds" }, timeout: "15 seconds" },
				async () =>
					getGoalLoopWorkItemSnapshot(db, {
						orgId: organizationId,
						objectiveId,
					}),
			);
		};

		return runGoalLoop(
			{
				content: event.payload.content,
				condition: event.payload.condition,
				maxTurns: event.payload.maxTurns,
				budgetUsd: event.payload.budgetUsd,
				evaluator: event.payload.evaluator,
				objectiveId: event.payload.objectiveId,
			},
			{
				runTurn,
				judge,
				checkWorkItems: event.payload.objectiveId ? checkWorkItems : undefined,
			},
		);
	}
}
