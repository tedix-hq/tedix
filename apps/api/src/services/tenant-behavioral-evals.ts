import type {
	TenantBehavioralEvalExecutionReceipt,
	TenantBehavioralEvalRevisionSpec,
} from "@tedix/api-contract/schemas/tenant-behavioral-evals";
import type {
	RuntimeStreamEvent,
	RuntimeStreamReadOutput,
} from "@tedix/api-contract/schemas/runtime-submissions";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import type { DbClient } from "@tedix/db/client";
import { listKernelRuntimeEvents } from "@tedix/db/queries/kernel-runtime-events";
import {
	acquireTenantBehavioralEvalRunLease,
	appendTenantBehavioralEvalCaseAttempt,
	finishTenantBehavioralEvalRun,
	getTenantBehavioralEvalRevision,
	getTenantBehavioralEvalRunDetail,
	markTenantBehavioralEvalCaseAdvanceError,
	releaseTenantBehavioralEvalRunLease,
	recordTenantBehavioralEvalAdvanceError,
	reserveTenantBehavioralEvalRetry,
	updateTenantBehavioralEvalCaseRun,
	writeTenantBehavioralEvalAssertionResults,
} from "@tedix/db/queries/tenant-behavioral-evals";
import { assertKernelExecutionPolicyClaim } from "../kernel/runtime-submission-bridge";

const PAGE = 100;
const MAX_CASE_ATTEMPTS = 3;
export function tenantBehavioralEvalConversationId(
	runId: string,
	caseId: string,
	attemptNumber: number,
): string {
	const base = `eval:${runId}:${caseId}`;
	return attemptNumber === 1 ? base : `${base}:attempt-${attemptNumber}`;
}
const EFFECT_EVENT =
	/^(tool\.|approval\.|delegation\.|subagent\.|workstation\.|workflow\.|work_item\.)/;
export function tenantBehavioralEvalEventObservations(
	events: RuntimeStreamEvent[],
) {
	let terminalStatus: string | null = null,
		effectObserved = false;
	for (const event of events) {
		if (EFFECT_EVENT.test(event.kind)) effectObserved = true;
		if (["run.completed", "run.failed", "run.canceled"].includes(event.kind))
			terminalStatus = event.kind.slice(4);
	}
	return { terminalStatus, effectObserved };
}
export function tenantBehavioralEvalMetadataObservation(
	metadata: Record<string, unknown> | undefined,
) {
	const observation =
		metadata?.kernelObservation &&
		typeof metadata.kernelObservation === "object"
			? (metadata.kernelObservation as Record<string, unknown>)
			: {};
	const selected =
		observation.selectedRoute && typeof observation.selectedRoute === "object"
			? (observation.selectedRoute as Record<string, unknown>)
			: {};
	return {
		selectedRoute:
			typeof selected.routeKind === "string" ? selected.routeKind : null,
		effectsSuppressed:
			metadata?.executionPolicy === "observe_only" &&
			metadata.effectsSuppressed === true &&
			observation.outcome === "effects_suppressed"
				? true
				: null,
	};
}
export function tenantBehavioralEvalExecutionReceipt(
	metadata: Record<string, unknown> | undefined,
): TenantBehavioralEvalExecutionReceipt {
	const object = (value: unknown): Record<string, unknown> =>
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const stringOrNull = (value: unknown): string | null =>
		typeof value === "string" && value.length > 0 ? value : null;
	const countOrNull = (value: unknown): number | null =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0
			? value
			: null;
	const body = object(metadata?.bodyExecutionResult);
	const usage = object(body.usage);
	const durationMs = body.durationMs;
	return {
		schemaVersion: 1,
		source: "home_terminal_metadata",
		observedProvider: stringOrNull(usage.provider),
		observedModel: stringOrNull(usage.model),
		inputTokens: countOrNull(usage.inputTokens),
		outputTokens: countOrNull(usage.outputTokens),
		reasoningTokens: countOrNull(usage.reasoningTokens),
		harnessVersionId: stringOrNull(body.harnessVersionId),
		traceBundleId: stringOrNull(body.traceBundleId),
		routerVersion: stringOrNull(metadata?.routerVersion),
		durationMs:
			typeof durationMs === "number" &&
			Number.isFinite(durationMs) &&
			durationMs >= 0
				? durationMs
				: null,
	};
}
export function isTenantBehavioralEvalStreamDrained(input: {
	previouslyClosed: boolean;
	currentClosed: boolean;
	eventCount: number;
	storedCursor: number;
	nextOffset: number;
}): boolean {
	return (
		input.previouslyClosed &&
		input.currentClosed &&
		input.eventCount === 0 &&
		input.nextOffset === input.storedCursor
	);
}
export function mergeTenantBehavioralEvalEffectsSuppressed(input: {
	previous: boolean | null;
	effectObserved: boolean;
	terminalMetadata: boolean | null | undefined;
}): boolean | null {
	if (input.previous === false || input.effectObserved) return false;
	return input.terminalMetadata ?? input.previous;
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Evaluation service step timed out")),
					10_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer!);
	}
}
export async function ensureTenantBehavioralEvalHomeRun(input: {
	db: DbClient;
	runId: string;
	organizationId: string;
	conversationId: string;
	content: string;
	readRun(runId: string): Promise<TenantBehavioralEvalHomeRun | null>;
	enqueue(args: {
		organizationId: string;
		conversationId: string;
		content: string;
		idempotencyKey: string;
		executionPolicy: "observe_only";
	}): Promise<TenantBehavioralEvalHomeRun>;
}) {
	const existing = await bounded(input.readRun(input.runId));
	if (existing) {
		await assertTenantBehavioralEvalHomeRun(input.db, input, existing);
		return existing;
	}
	await bounded(
		input.enqueue({
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			content: input.content,
			idempotencyKey: input.runId,
			executionPolicy: "observe_only",
		}),
	);
	const created = await bounded(input.readRun(input.runId));
	if (!created) throw new Error("Evaluation Home run readback unavailable");
	await assertTenantBehavioralEvalHomeRun(input.db, input, created);
	return created;
}

type TenantBehavioralEvalHomeRun = {
	id: string;
	status?: string;
	organizationId: string;
	conversationId: string;
	inputMessageId?: string;
	metadata?: Record<string, unknown>;
};

export function isTenantBehavioralEvalStalledHomeRun(
	run: TenantBehavioralEvalHomeRun,
): boolean {
	const marker = run.metadata?.kernelReconciliation;
	return (
		run.status === "failed" &&
		marker !== null &&
		typeof marker === "object" &&
		!Array.isArray(marker) &&
		(marker as Record<string, unknown>).action === "mark_stalled"
	);
}
export function tenantBehavioralEvalRetryableHomeFailure(
	run: TenantBehavioralEvalHomeRun,
): "mark_stalled" | "model_unavailable" | null {
	if (run.status !== "failed") return null;
	if (isTenantBehavioralEvalStalledHomeRun(run)) return "mark_stalled";
	const body = run.metadata?.bodyExecutionResult;
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const record = body as Record<string, unknown>;
	const error = record.error;
	if (
		record.status !== "failed" ||
		!error ||
		typeof error !== "object" ||
		Array.isArray(error)
	)
		return null;
	const typed = error as Record<string, unknown>;
	return typed.kind === "model" && typed.retryable === true
		? "model_unavailable"
		: null;
}

async function assertTenantBehavioralEvalHomeRun(
	db: DbClient,
	expected: {
		runId: string;
		organizationId: string;
		conversationId: string;
		content: string;
	},
	run: TenantBehavioralEvalHomeRun,
): Promise<void> {
	const inputMessageId = `${expected.runId}:input`;
	if (
		run.id !== expected.runId ||
		run.organizationId !== expected.organizationId ||
		run.conversationId !== expected.conversationId ||
		run.inputMessageId !== inputMessageId ||
		run.metadata?.executionPolicy !== "observe_only"
	)
		throw new Error("Evaluation Home run identity is missing or conflicting");
	await assertKernelExecutionPolicyClaim(db, {
		runId: expected.runId,
		organizationId: expected.organizationId,
		conversationId: expected.conversationId,
		executionPolicy: "observe_only",
	});
	const [event] = await listKernelRuntimeEvents(db, {
		organizationId: expected.organizationId,
		conversationId: expected.conversationId,
		runId: expected.runId,
		id: homeRuntimeEventId({
			organizationId: expected.organizationId,
			kind: "message.received",
			conversationId: expected.conversationId,
			runId: expected.runId,
			messageId: inputMessageId,
		}),
		kind: "message.received",
		limit: 1,
	});
	if (
		!event ||
		event.messageId !== inputMessageId ||
		event.payload?.role !== "user" ||
		event.payload.content !== expected.content
	)
		throw new Error("Evaluation Home input evidence is missing or conflicting");
}

export function assertTenantBehavioralEvalStreamPage(input: {
	runId: string;
	conversationId: string;
	offset: number;
	page: RuntimeStreamReadOutput;
}): void {
	if (
		input.page.stream.streamId !== `home:${input.runId}` ||
		input.page.stream.offset !== input.offset ||
		input.page.events.length > PAGE ||
		input.page.stream.nextOffset !==
			input.page.stream.offset + input.page.events.length ||
		input.page.events.some(
			(event) =>
				(event.runId !== undefined && event.runId !== input.runId) ||
				(event.conversationId !== undefined &&
					event.conversationId !== input.conversationId),
		)
	)
		throw new Error("Evaluation Home event stream is missing or conflicting");
}
export function gradeTenantBehavioralEvalCase(
	spec: TenantBehavioralEvalRevisionSpec["cases"][number],
	state: {
		selectedRoute: string | null;
		terminalStatus: string | null;
		effectsSuppressed: boolean | null;
	},
) {
	return spec.assertions.map((assertion, assertionIndex) => {
		const actual =
			assertion.type === "route_is"
				? state.selectedRoute
				: assertion.type === "terminal_status_is"
					? state.terminalStatus
					: state.effectsSuppressed;
		const expected =
			assertion.type === "no_effects" ? true : assertion.expected;
		return {
			assertionIndex,
			type: assertion.type,
			severity: assertion.severity ?? "gate",
			disposition:
				actual === null
					? ("unresolved" as const)
					: actual === expected
						? ("passed" as const)
						: ("failed" as const),
			passed: actual !== null && actual === expected,
			detail: `expected ${String(expected)}, observed ${String(actual)}`,
		};
	});
}
function caseDisposition(
	results: ReturnType<typeof gradeTenantBehavioralEvalCase>,
) {
	return results.some((result) => result.disposition === "failed")
		? ("failed" as const)
		: results.some((result) => result.disposition === "unresolved")
			? ("unresolved" as const)
			: ("passed" as const);
}
export async function advanceTenantBehavioralEvalRun(input: {
	db: DbClient;
	organizationId: string;
	runId: string;
	expectedVersion: number;
	readRun(runId: string): Promise<TenantBehavioralEvalHomeRun | null>;
	enqueue(args: {
		organizationId: string;
		conversationId: string;
		content: string;
		idempotencyKey: string;
		executionPolicy: "observe_only";
	}): Promise<TenantBehavioralEvalHomeRun>;
	readEvents(args: {
		organizationId: string;
		runId: string;
		offset: number;
		limit: number;
		waitMs: number;
	}): Promise<RuntimeStreamReadOutput>;
}) {
	const token = crypto.randomUUID();
	const leaseVersion = await acquireTenantBehavioralEvalRunLease(
		input.db,
		input.organizationId,
		input.runId,
		token,
		input.expectedVersion,
	);
	if (leaseVersion === undefined)
		throw new Error("Evaluation run version changed or is already advancing");
	let failurePhase: "dispatch" | "evidence" | "assertion" = "evidence";
	let activeCaseId: string | undefined;
	try {
		const detail = await getTenantBehavioralEvalRunDetail(
			input.db,
			input.organizationId,
			input.runId,
		);
		if (!detail) throw new Error("Evaluation run not found");
		const revision = await getTenantBehavioralEvalRevision(
			input.db,
			input.organizationId,
			detail.run.definitionId,
			detail.run.revisionId,
		);
		if (!revision) throw new Error("Pinned evaluation revision not found");
		const next = detail.caseRuns.find(
			(c) =>
				!c.drained ||
				!detail.caseAttempts.some(
					(a) => a.caseRunId === c.id && a.attemptNumber === c.attemptNumber,
				) ||
				detail.assertionResults.filter((r) => r.caseRunId === c.id).length !==
					revision.revision.spec.cases.find((s) => s.id === c.caseId)
						?.assertions.length,
		);
		if (!next) {
			const expected = revision.revision.spec.cases.reduce(
				(sum, value) => sum + value.assertions.length,
				0,
			);
			if (detail.assertionResults.length !== expected)
				throw new Error("Evaluation assertion evidence is incomplete");
			const passed =
				detail.caseRuns.every((c) => c.disposition !== "unresolved") &&
				detail.assertionResults.every((result) => {
					const caseRun = detail.caseRuns.find(
						(row) => row.id === result.caseRunId,
					);
					const caseSpec = revision.revision.spec.cases.find(
						(row) => row.id === caseRun?.caseId,
					);
					const assertion = caseSpec?.assertions[result.assertionIndex];
					return (
						assertion !== undefined &&
						((assertion.severity ?? "gate") === "soft" ||
							(result.disposition ?? (result.passed ? "passed" : "failed")) ===
								"passed")
					);
				});
			if (
				!(await finishTenantBehavioralEvalRun(
					input.db,
					input.runId,
					token,
					leaseVersion,
					passed,
				))
			)
				throw new Error("Evaluation advance lease lost");
			return (await getTenantBehavioralEvalRunDetail(
				input.db,
				input.organizationId,
				input.runId,
			))!;
		}
		const caseSpec = revision.revision.spec.cases.find(
			(c) => c.id === next.caseId,
		);
		if (!caseSpec) throw new Error("Pinned evaluation case missing");
		activeCaseId = next.id;
		const seal = async () => {
			if (
				!(await appendTenantBehavioralEvalCaseAttempt(input.db, {
					caseRunId: next.id,
					runId: input.runId,
					attemptNumber: next.attemptNumber,
					leaseToken: token,
					leaseVersion,
				}))
			)
				throw new Error("Evaluation attempt could not be sealed");
		};
		const gradeAndSeal = async (observations: {
			selectedRoute: string | null;
			terminalStatus: string | null;
			effectsSuppressed: boolean | null;
		}) => {
			failurePhase = "assertion";
			const graded = gradeTenantBehavioralEvalCase(caseSpec, observations);
			const values = graded.map((r) => ({
				id: crypto.randomUUID(),
				caseRunId: next.id,
				...r,
			}));
			if (
				!(await writeTenantBehavioralEvalAssertionResults(input.db, {
					runId: input.runId,
					token,
					leaseVersion,
					values,
				}))
			)
				throw new Error("Evaluation advance lease lost");
			if (
				!(await updateTenantBehavioralEvalCaseRun(input.db, {
					id: next.id,
					runId: input.runId,
					leaseToken: token,
					leaseVersion,
					patch: { disposition: caseDisposition(graded), error: null },
				}))
			)
				throw new Error("Evaluation advance lease lost");
			await seal();
		};
		if (next.status === "pending") {
			failurePhase = "dispatch";
			const home = await ensureTenantBehavioralEvalHomeRun({
				db: input.db,
				runId: next.homeRunId,
				organizationId: input.organizationId,
				conversationId: tenantBehavioralEvalConversationId(
					input.runId,
					next.caseId,
					next.attemptNumber,
				),
				content: caseSpec.input,
				readRun: input.readRun,
				enqueue: input.enqueue,
			});
			const meta = tenantBehavioralEvalMetadataObservation(home.metadata);
			if (
				!(await updateTenantBehavioralEvalCaseRun(input.db, {
					id: next.id,
					runId: input.runId,
					leaseToken: token,
					leaseVersion,
					patch: {
						status: "enqueued",
						disposition: null,
						error: null,
						...meta,
					},
				}))
			)
				throw new Error("Evaluation advance lease lost");
		} else if (next.drained) {
			if (next.error === "mark_stalled" || next.error === "model_unavailable") {
				await seal();
				if (next.attemptNumber < MAX_CASE_ATTEMPTS) {
					if (
						!(await reserveTenantBehavioralEvalRetry(input.db, {
							caseRunId: next.id,
							runId: input.runId,
							expectedAttemptNumber: next.attemptNumber,
							expectedHomeRunId: next.homeRunId,
							newHomeRunId: `eval-${crypto.randomUUID()}`,
							leaseToken: token,
							leaseVersion,
						}))
					)
						throw new Error("Evaluation retry reservation lost");
				} else {
					const values = caseSpec.assertions.map(
						(assertion, assertionIndex) => ({
							id: crypto.randomUUID(),
							caseRunId: next.id,
							assertionIndex,
							type: assertion.type,
							severity: assertion.severity ?? ("gate" as const),
							disposition: "unresolved" as const,
							passed: false,
							detail: "Transient Home failure after the retry limit",
						}),
					);
					if (
						!(await writeTenantBehavioralEvalAssertionResults(input.db, {
							runId: input.runId,
							token,
							leaseVersion,
							values,
						}))
					)
						throw new Error("Evaluation advance lease lost");
				}
			} else {
				await gradeAndSeal(next);
			}
		} else {
			failurePhase = "evidence";
			const conversationId = tenantBehavioralEvalConversationId(
				input.runId,
				next.caseId,
				next.attemptNumber,
			);
			const page = await bounded(
				input.readEvents({
					organizationId: input.organizationId,
					runId: next.homeRunId,
					offset: next.eventCursor,
					limit: PAGE,
					waitMs: 2_000,
				}),
			);
			assertTenantBehavioralEvalStreamPage({
				runId: next.homeRunId,
				conversationId,
				offset: next.eventCursor,
				page,
			});
			const seen = tenantBehavioralEvalEventObservations(page.events);
			let terminalMetadata = null;
			let terminalReceipt: TenantBehavioralEvalExecutionReceipt | null = null;
			let retryableFailure: "mark_stalled" | "model_unavailable" | null = null;
			if (page.stream.closed) {
				const terminal = await bounded(input.readRun(next.homeRunId));
				if (!terminal)
					throw new Error("Evaluation terminal Home run unavailable");
				await assertTenantBehavioralEvalHomeRun(
					input.db,
					{
						runId: next.homeRunId,
						organizationId: input.organizationId,
						conversationId,
						content: caseSpec.input,
					},
					terminal,
				);
				terminalMetadata = tenantBehavioralEvalMetadataObservation(
					terminal.metadata,
				);
				terminalReceipt = tenantBehavioralEvalExecutionReceipt(
					terminal.metadata,
				);
				retryableFailure = tenantBehavioralEvalRetryableHomeFailure(terminal);
			}
			const sawClosed = next.sawClosed || page.stream.closed;
			const drained = isTenantBehavioralEvalStreamDrained({
				previouslyClosed: next.sawClosed,
				currentClosed: page.stream.closed,
				eventCount: page.events.length,
				storedCursor: next.eventCursor,
				nextOffset: page.stream.nextOffset,
			});
			const merged = {
				selectedRoute: terminalMetadata?.selectedRoute ?? next.selectedRoute,
				terminalStatus: seen.terminalStatus ?? next.terminalStatus,
				effectsSuppressed: mergeTenantBehavioralEvalEffectsSuppressed({
					previous: next.effectsSuppressed,
					effectObserved: seen.effectObserved,
					terminalMetadata: terminalMetadata?.effectsSuppressed,
				}),
			};
			if (
				!(await updateTenantBehavioralEvalCaseRun(input.db, {
					id: next.id,
					runId: input.runId,
					leaseToken: token,
					leaseVersion,
					patch: {
						status: drained
							? retryableFailure
								? "failed"
								: "completed"
							: "streaming",
						eventCursor: page.stream.nextOffset,
						sawClosed,
						drained,
						disposition: drained && retryableFailure ? "unresolved" : null,
						error: drained ? retryableFailure : null,
						...(drained ? { executionReceipt: terminalReceipt } : {}),
						...merged,
					},
				}))
			)
				throw new Error("Evaluation advance lease lost");
			if (drained) {
				if (retryableFailure) await seal();
				else await gradeAndSeal(merged);
			}
		}
		return (await getTenantBehavioralEvalRunDetail(
			input.db,
			input.organizationId,
			input.runId,
		))!;
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		const category = /timed out/i.test(message)
			? "timeout"
			: /unavailable/i.test(message)
				? "unavailable"
				: /conflict|identity|lease lost/i.test(message)
					? "conflict"
					: /incomplete|missing/i.test(message)
						? "incomplete"
						: "unknown";
		const recorded = await recordTenantBehavioralEvalAdvanceError(input.db, {
			runId: input.runId,
			organizationId: input.organizationId,
			token,
			leaseVersion,
			phase: failurePhase,
			category,
			retryable: category === "timeout" || category === "unavailable",
		});
		if (recorded && activeCaseId)
			await markTenantBehavioralEvalCaseAdvanceError(input.db, {
				caseRunId: activeCaseId,
				runId: input.runId,
				leaseToken: token,
				leaseVersion,
				category,
			});
		throw error;
	} finally {
		await releaseTenantBehavioralEvalRunLease(input.db, input.runId, token);
	}
}
