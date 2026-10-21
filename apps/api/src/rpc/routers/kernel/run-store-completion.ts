import { kernelSpanContext } from "./gateway-attribution";
import type { TediRuntimeEventKind } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	homeRuntimeEventId,
	subagentOutcomeEventKind,
} from "@tedix/api-contract/utils/runtime-events";
import {
	type KernelRuntimeRun,
	updateKernelRuntimeRunForOrg,
} from "@tedix/db/queries/kernel-runtime-runs";
import { toJsonRecord } from "@tedix/db/utils/json";
import { type BaseContext } from "../../orpc";
import {
	readChildRunFinalAssistantResult,
	readChildRunFullResult,
} from "./child-run-reads";
import { delegatedStopFromSummary } from "./delegated-stop";
import { type DelegationAttemptResult } from "./delegation-work-item";
import { homeNarrationMetadata } from "./home-narration";
import { type KernelEnv, kernelModel } from "./llm";
import {
	DELEGATION_SYNTHESIS_SYSTEM_PROMPT,
	errorMessage,
	nonNullRecord,
	stringFromPayload,
} from "./runtime-shared";
import {
	homeDelegationCompletionContent,
	homeDelegationVerdictMetadata,
	HomeDelegationProofMetadata,
} from "./run-store-content";
import {
	insertKernelRuntimeEvent,
	asyncCompletionAssistantMessageId,
} from "./run-store";

/**
 * Read the caller-supplied output schema off a run row's opaque `metadata`
 * JSON column, defensively — `metadata.delegationWorkOrder.outputSchema` (see
 * `buildDelegationWorkOrder` in delegation-dispatch.ts, which is the only
 * writer of this key). Any shape mismatch (missing, wrong type, historical
 * row predating this feature) resolves to `null`, matching every other
 * defensive metadata read in this file.
 */
function delegationWorkOrderOutputSchema(
	metadata: unknown,
): Record<string, unknown> | null {
	const workOrder = nonNullRecord(nonNullRecord(metadata)?.delegationWorkOrder);
	const outputSchema = workOrder?.outputSchema;
	return outputSchema &&
		typeof outputSchema === "object" &&
		!Array.isArray(outputSchema)
		? (outputSchema as Record<string, unknown>)
		: null;
}

/**
 * Read the child run's full transcript and synthesize it via one bounded LLM
 * pass. Returns the synthesized string or null (any error → null; never throws).
 * Only called when the run is completed.
 */
async function readAndSynthesizeChildRunResult(
	context: BaseContext,
	input: {
		tediId: string;
		runId: string;
		organizationId: string;
	},
): Promise<string | null> {
	try {
		const fullResult = await readChildRunFullResult(context, input);
		if (!fullResult) return null;
		const model = kernelModel(
			context.env as unknown as KernelEnv,
			undefined,
			input.organizationId,
		);
		if (!model) return null;
		const { tracedAi } = await import("../../../lib/traced-ai");
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), 15_000);
		try {
			const synthResult = await tracedAi.generateText({
				model: model.model,
				instructions: DELEGATION_SYNTHESIS_SYSTEM_PROMPT,
				runtimeContext: kernelSpanContext({
					organizationId: input.organizationId,
					runId: input.runId,
					source: "child_run_synthesis",
				}),
				telemetry: { functionId: "kernel.child_run_synthesis" },
				messages: [{ role: "user", content: fullResult }],
				maxOutputTokens: 1200,
				abortSignal: abortController.signal,
			});
			return synthResult.text?.trim() || null;
		} finally {
			clearTimeout(timeoutId);
		}
	} catch (error) {
		console.warn("[kernelRuntime] readAndSynthesizeChildRunResult failed", {
			error: errorMessage(error),
			tediId: input.tediId,
			runId: input.runId,
		});
		return null;
	}
}

/**
 * Emit an INTERMEDIATE delegation-progress event when a non-terminal child
 * advance is reconciled onto the parent run row, so the Home work card reflects
 * live progress (running/streaming + the child's latest evidence preview)
 * instead of jumping straight from queued to the terminal completion message.
 *
 * Emitted as a `message.delta` runtime event (not a `message.completed`
 * assistant message), so it feeds the work-card/event timeline without
 * polluting the Home chat transcript — `isHomeMessageEvent` only surfaces
 * received/completed messages. Idempotent: the event id is keyed by the child's
 * `latestEventAt`, so repeated reconcile polls over the same child event
 * collapse to one row. Fail-soft: a progress insert never breaks reconciliation.
 */
export async function recordHomeDelegationProgressMessage(
	context: BaseContext,
	input: {
		createdAt: string;
		latestEventAt: string | null;
		latestEventKind: TediRuntimeEventKind | undefined;
		preview: string | null;
		row: KernelRuntimeRun;
		run: HomeRun;
	},
): Promise<void> {
	if (!input.row.delegatedTediId || !input.row.childRunId) return;
	// Only surface genuinely-active progress; a queued/needs-approval child with
	// no work advance yet carries no evidence worth a timeline event. The HomeRun
	// status collapses streaming→running, so "running" is the active gate.
	if (input.run.status !== "running") return;
	// The richer child sub-state (running vs streaming) lives in run metadata.
	const childRunStatus =
		stringFromPayload(nonNullRecord(input.run.metadata)?.childRunStatus) ??
		input.run.status;
	try {
		await insertKernelRuntimeEvent(context, {
			id: homeRuntimeEventId({
				organizationId: input.row.organizationId,
				kind: "message.delta",
				conversationId: input.row.conversationId,
				runId: input.row.id,
				childRunId: input.row.childRunId,
				suffix: `progress:${input.latestEventAt ?? input.createdAt}`,
			}),
			organizationId: input.row.organizationId,
			kind: "message.delta",
			conversationId: input.row.conversationId,
			runId: input.row.id,
			delegatedTediId: input.row.delegatedTediId,
			childRunId: input.row.childRunId,
			delta: input.preview ?? undefined,
			payload: {
				role: "assistant",
				channel: "home",
				content: input.preview ?? "",
				metadata: {
					asyncProgress: true,
					childRunId: input.row.childRunId,
					childRunLatestEventAt: input.latestEventAt,
					childRunLatestEventKind: input.latestEventKind ?? null,
					childRunPreview: input.preview,
					childRunStatus,
					delegatedTediId: input.row.delegatedTediId,
					homeRunId: input.row.id,
					homeSubject: true,
					progress: input.run.progress ?? null,
					source: "kernelRuntime.delegationProgress",
				},
			},
			runtimeMetadata: {
				asyncProgress: true,
				childRunId: input.row.childRunId,
				childRunLatestEventAt: input.latestEventAt,
				childRunLatestEventKind: input.latestEventKind ?? null,
				childRunStatus,
				delegatedTediId: input.row.delegatedTediId,
				source: "kernelRuntime.delegationProgress",
			},
			createdAt: input.createdAt,
		});
	} catch (error) {
		console.warn("[kernelRuntime] async progress event insert failed", {
			error: errorMessage(error),
			runId: input.row.id,
			childRunId: input.row.childRunId,
		});
	}
}

/**
 * Deterministic event id for the async-completion `message.completed` event —
 * single source of truth shared by the writer
 * ({@link recordHomeDelegationCompletionMessage}) and the read-repair gate in
 * `reconcileHomeRunRowsFromChildStatus` (which pre-checks existence so
 * steady-state reads over terminal history never re-pay the child-evidence
 * read).
 */
export function homeDelegationCompletionEventId(row: KernelRuntimeRun): string {
	return homeRuntimeEventId({
		organizationId: row.organizationId,
		kind: "message.completed",
		conversationId: row.conversationId,
		runId: row.id,
		suffix: "delegation-completion",
	});
}

export async function recordHomeDelegationCompletionMessage(
	context: BaseContext,
	input: {
		createdAt: string;
		disposition?: DelegationAttemptResult | null;
		latestEventAt: string | null;
		latestEventKind: TediRuntimeEventKind | undefined;
		preview: string | null;
		row: KernelRuntimeRun;
		run: HomeRun;
	},
): Promise<void> {
	if (!input.row.delegatedTediId || !input.row.childRunId) return;
	if (typeof input.row.metadata?.kernelRequestId === "string") {
		const { getHomeKernelRequest } =
			await import("@tedix/db/queries/kernel-requests");
		const request = await getHomeKernelRequest(
			context.db,
			input.row.organizationId,
			input.row.id,
		);
		if (!request) throw new Error("Durable request ownership unavailable");
		const { readKernelRequestPolicy, reconcileHomeKernelRequest } =
			await import("../../../kernel/request-home-source");
		const policy = await readKernelRequestPolicy(
			context,
			input.row.organizationId,
		);
		if (policy) await reconcileHomeKernelRequest(context, request, policy);
	}
	const messageId = asyncCompletionAssistantMessageId(input.row.id);
	// Relay-first (harness contract): the child's final assistant message IS
	// the return value — deliver it verbatim, exactly like a subagent tool
	// result. The child's own closing message is already operator-shaped; a
	// detached LLM pass over its transcript never sees the operator's question
	// and can role-play instead of reporting. Fail-soft (retry-backed inside
	// the child reads): a still-failing read yields null → synthesis/preview.
	const finalResult = await readChildRunFinalAssistantResult(context, {
		tediId: input.row.delegatedTediId,
		runId: input.row.childRunId,
		organizationId: input.row.organizationId,
	});
	const finalMessage = finalResult.content;
	// Synthesis is the FALLBACK, not a rewrite: only when the child completed
	// WITHOUT a final assistant message (tool-only evidence), interpret the full
	// transcript via one bounded LLM pass. Fail-soft — null → the preview-based
	// content.
	const synthesized =
		!finalMessage && input.run.status === "completed"
			? await readAndSynthesizeChildRunResult(context, {
					tediId: input.row.delegatedTediId,
					runId: input.row.childRunId,
					organizationId: input.row.organizationId,
				})
			: null;
	const content = homeDelegationCompletionContent({
		preview: input.preview,
		synthesized,
		finalMessage,
		status: input.run.status,
		stop: delegatedStopFromSummary(nonNullRecord(input.run.metadata)),
	});
	// One delegation = one row. With NEITHER a relayed child answer NOR a
	// synthesis, `homeDelegationCompletionContent` returns a template over
	// (`status`, `preview`) — "The delegated tedi assignment was canceled.
	// Latest evidence: …" and its siblings. Both inputs are already rendered by
	// the delegation receipt (humanized status label + clamped preview), so the
	// turn restates the adjacent row and nothing else. Structural, not textual:
	// the moment the child returns a real closing message (or synthesis produces
	// one) this is unstamped, because that message IS the delegation's return
	// value and must render in full.
	//
	// The proof verdict is the third exception: it discloses that the Work-Item
	// proof gate rejected a completion the transcript would otherwise call
	// finished. The receipt carries no proof verdict, so a turn carrying that
	// verdict (as `metadata.delegationProof`) is not a restatement and keeps
	// rendering so the chip has a row to sit on.
	const verdictMetadata = homeDelegationVerdictMetadata({
		disposition: input.disposition,
		outputSchema: delegationWorkOrderOutputSchema(input.row.metadata),
		status: input.run.status,
		validatedContent: synthesized ?? finalMessage ?? null,
	});
	const statusOnlyNarration =
		!synthesized && !finalMessage && !verdictMetadata.delegationProof;
	try {
		const outcomeKind = subagentOutcomeEventKind(input.run.status);
		if (outcomeKind) {
			await insertKernelRuntimeEvent(context, {
				id: homeRuntimeEventId({
					organizationId: input.row.organizationId,
					kind: outcomeKind,
					conversationId: input.row.conversationId,
					runId: input.row.id,
					childRunId: input.row.childRunId,
				}),
				organizationId: input.row.organizationId,
				kind: outcomeKind,
				conversationId: input.row.conversationId,
				runId: input.row.id,
				delegatedTediId: input.row.delegatedTediId,
				childRunId: input.row.childRunId,
				payload: {
					childRunId: input.row.childRunId,
					childRunLatestEventAt: input.latestEventAt,
					childRunLatestEventKind: input.latestEventKind ?? null,
					childRunPreview: input.preview,
					childRunStatus: input.run.status,
					delegatedTediId: input.row.delegatedTediId,
					homeRunId: input.row.id,
					progress: input.run.progress ?? null,
					source: "kernelRuntime.delegationCompletion",
				},
				runtimeMetadata: {
					childRunStatus: input.run.status,
					source: "kernelRuntime.delegationCompletion",
				},
				createdAt: input.createdAt,
			});
		}
		await insertKernelRuntimeEvent(context, {
			id: homeDelegationCompletionEventId(input.row),
			organizationId: input.row.organizationId,
			kind: "message.completed",
			conversationId: input.row.conversationId,
			runId: input.row.id,
			messageId,
			delegatedTediId: input.row.delegatedTediId,
			childRunId: input.row.childRunId,
			payload: {
				role: "assistant",
				content,
				channel: "home",
				metadata: {
					asyncCompletion: true,
					childRunId: input.row.childRunId,
					childRunLatestEventAt: input.latestEventAt,
					childRunLatestEventKind: input.latestEventKind ?? null,
					childRunPreview: input.preview,
					childRunStatus: input.run.status,
					delegatedTediId: input.row.delegatedTediId,
					homeRunId: input.row.id,
					homeSubject: true,
					progress: input.run.progress ?? null,
					source: "kernelRuntime.delegationCompletion",
					...(finalResult.widgets.length > 0
						? {
								delegatedResult: {
									version: 1,
									widgets: finalResult.widgets,
								},
							}
						: {}),
					...verdictMetadata,
					...(statusOnlyNarration
						? homeNarrationMetadata("delegation_status_only")
						: {}),
				},
			},
			runtimeMetadata: {
				asyncCompletion: true,
				childRunId: input.row.childRunId,
				childRunLatestEventAt: input.latestEventAt,
				childRunLatestEventKind: input.latestEventKind ?? null,
				childRunStatus: input.run.status,
				delegatedTediId: input.row.delegatedTediId,
				source: "kernelRuntime.delegationCompletion",
			},
			createdAt: input.createdAt,
		});
	} catch (error) {
		console.warn("[kernelRuntime] async completion message insert failed", {
			error: errorMessage(error),
			runId: input.row.id,
			childRunId: input.row.childRunId,
		});
	}
	if (verdictMetadata.delegationProof) {
		await stampHomeRunDelegationProof(context, {
			row: input.row,
			run: input.run,
			delegationProof: verdictMetadata.delegationProof,
			updatedAt: input.createdAt,
		});
	}
}

/**
 * Mirror the proof chip onto the parent Home run row's metadata
 * (`metadata.delegationProof`) so the delegation receipt / run card can render
 * it without scanning the transcript. Idempotent: skipped when the row already
 * carries an identical chip. Fail-soft.
 */
async function stampHomeRunDelegationProof(
	context: BaseContext,
	input: {
		row: KernelRuntimeRun;
		run: HomeRun;
		delegationProof: HomeDelegationProofMetadata;
		updatedAt: string;
	},
): Promise<void> {
	const current =
		nonNullRecord(input.run.metadata) ??
		nonNullRecord(input.row.metadata) ??
		{};
	const existing = nonNullRecord(current.delegationProof);
	if (
		existing &&
		existing.verdict === input.delegationProof.verdict &&
		existing.reason === input.delegationProof.reason
	) {
		return;
	}
	try {
		await updateKernelRuntimeRunForOrg(context.db, {
			id: input.row.id,
			organizationId: input.row.organizationId,
			patch: {
				updatedAt: input.updatedAt,
				metadata: toJsonRecord({
					...current,
					delegationProof: input.delegationProof,
				}),
			},
		});
	} catch (error) {
		console.warn("[kernelRuntime] delegation proof stamp failed", {
			error: errorMessage(error),
			runId: input.row.id,
		});
	}
}
