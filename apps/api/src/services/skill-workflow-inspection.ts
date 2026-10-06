import { SkillWorkflowConnectionRecoverySchema } from "@tedix/api-contract/schemas/cognitive";
import type {
	SkillRunCostSummary,
	SkillWorkflowArtifactSummary,
	SkillWorkflowReliability,
	SkillWorkflowStep,
	SkillWorkflowToolCall,
} from "@tedix/api-contract/contracts/cognitive";
import { readPinnedCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import type {
	SkillRun,
	SkillRunSummaryRow,
} from "@tedix/db/queries/skill-runs";
import type { SkillRunArtifact } from "@tedix/db/schema/cognitive";

export interface ResolvedSkillRunArtifact {
	artifact: SkillRunArtifact;
	content: string | null;
}

export interface WorkflowInspectionContentLimits {
	maxAggregateBytes: number;
	maxArtifactBytes: number;
	maxR2Reads: number;
	r2Concurrency: number;
}

export const WORKFLOW_INSPECTION_CONTENT_LIMITS: WorkflowInspectionContentLimits =
	{
		maxAggregateBytes: 8 * 1024 * 1024,
		maxArtifactBytes: 1024 * 1024,
		maxR2Reads: 128,
		r2Concurrency: 8,
	};

interface ArtifactBody {
	size: number;
	text(): Promise<string>;
}

function isOperationalWorkflowArtifact(path: string): boolean {
	return (
		path.startsWith("steps/") ||
		/^epochs\/\d+\/steps\//.test(path) ||
		/^epochs\/\d+\/manifest\.json$/.test(path) ||
		/^epochs\/\d+\/manifests\/[a-f0-9]{64}\.json$/.test(path) ||
		path === "timeline.json" ||
		path === "manifest.json"
	);
}

/**
 * Resolve inspection content without allowing a large run to fan out an
 * unbounded number of R2 reads or materialize an unbounded response. Metadata
 * remains available for skipped artifacts; callers can fetch one exact path
 * with get_skill_run_artifact when its body exceeds this aggregate view.
 */
export async function resolveSkillRunArtifactContents(input: {
	artifacts: SkillRunArtifact[];
	includeArbitraryContent: boolean;
	loadR2?: (key: string) => Promise<ArtifactBody | null>;
	limits?: Partial<WorkflowInspectionContentLimits>;
}): Promise<{
	resolved: ResolvedSkillRunArtifact[];
	warnings: string[];
}> {
	const limits = {
		...WORKFLOW_INSPECTION_CONTENT_LIMITS,
		...input.limits,
	};
	let remainingBytes = limits.maxAggregateBytes;
	let r2Reads = 0;
	let nextIndex = 0;
	let oversized = 0;
	let overBudget = 0;
	let overR2ReadLimit = 0;
	let missingR2 = 0;
	let unavailableR2 = 0;
	const resolved = Array.from<ResolvedSkillRunArtifact>({
		length: input.artifacts.length,
	});

	const reserve = (size: number): boolean => {
		if (size > limits.maxArtifactBytes) {
			oversized++;
			return false;
		}
		if (size > remainingBytes) {
			overBudget++;
			return false;
		}
		remainingBytes -= size;
		return true;
	};

	const resolveOne = async (index: number) => {
		const artifact = input.artifacts[index]!;
		const withoutContent = { artifact, content: null };
		if (
			!isOperationalWorkflowArtifact(artifact.path) &&
			!input.includeArbitraryContent
		) {
			resolved[index] = withoutContent;
			return;
		}
		if (artifact.contentInline != null) {
			const contentSize = new TextEncoder().encode(
				artifact.contentInline,
			).byteLength;
			resolved[index] = reserve(contentSize)
				? { artifact, content: artifact.contentInline }
				: withoutContent;
			return;
		}
		if (!artifact.contentR2Key) {
			resolved[index] = withoutContent;
			return;
		}
		if (!input.loadR2) {
			unavailableR2++;
			resolved[index] = withoutContent;
			return;
		}
		if (r2Reads >= limits.maxR2Reads) {
			overR2ReadLimit++;
			resolved[index] = withoutContent;
			return;
		}
		r2Reads++;
		const object = await input.loadR2(artifact.contentR2Key);
		if (!object) {
			missingR2++;
			resolved[index] = withoutContent;
			return;
		}
		if (!reserve(object.size)) {
			resolved[index] = withoutContent;
			return;
		}
		resolved[index] = { artifact, content: await object.text() };
	};

	const worker = async () => {
		while (nextIndex < input.artifacts.length) {
			const index = nextIndex++;
			await resolveOne(index);
		}
	};
	await Promise.all(
		Array.from(
			{
				length: Math.min(
					Math.max(1, limits.r2Concurrency),
					input.artifacts.length,
				),
			},
			worker,
		),
	);

	const warnings: string[] = [];
	if (oversized > 0) {
		warnings.push(
			`${oversized} artifact body/bodies exceeded the ${limits.maxArtifactBytes}-byte inspection limit and were omitted; fetch an exact path with get_skill_run_artifact.`,
		);
	}
	if (overBudget > 0) {
		warnings.push(
			`${overBudget} artifact body/bodies were omitted after the ${limits.maxAggregateBytes}-byte aggregate inspection budget was exhausted.`,
		);
	}
	if (overR2ReadLimit > 0) {
		warnings.push(
			`${overR2ReadLimit} R2 artifact body/bodies were omitted after the ${limits.maxR2Reads}-read inspection limit was reached.`,
		);
	}
	if (missingR2 > 0) {
		warnings.push(
			`${missingR2} referenced artifact body/bodies were missing in R2.`,
		);
	}
	if (unavailableR2 > 0) {
		warnings.push(
			`${unavailableR2} R2 artifact body/bodies were unavailable because SKILL_ARTIFACTS is not configured.`,
		);
	}
	return { resolved, warnings };
}

function decodedStepName(value: string): string | null {
	if (!value.startsWith("x:")) return null;
	try {
		return decodeURIComponent(value.slice(2));
	} catch {
		return null;
	}
}

function parseJson(content: string | null): unknown {
	if (content == null) return null;
	try {
		return JSON.parse(content);
	} catch {
		return content;
	}
}

function recordValue(
	value: unknown,
	keys: string[],
): string | null | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	for (const key of keys) {
		const found = record[key];
		if (typeof found === "string") return found;
	}
	for (const nestedKey of [
		"step",
		"request",
		"call",
		"tool",
		"metadata",
		"context",
	]) {
		const nested = record[nestedKey];
		const found = recordValue(nested, keys);
		if (found) return found;
	}
	return null;
}

function recordUnknown(value: unknown, keys: string[]): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	for (const key of keys) {
		if (record[key] !== undefined) return record[key];
	}
	for (const nestedKey of [
		"step",
		"request",
		"call",
		"tool",
		"metadata",
		"context",
	]) {
		const found = recordUnknown(record[nestedKey], keys);
		if (found !== null && found !== undefined) return found;
	}
	return null;
}

function workflowRecordStatus(data: unknown): SkillWorkflowStep["status"] {
	const raw = recordValue(data, ["status", "outcome"]);
	if (!raw) return null;
	switch (raw.toLowerCase()) {
		case "started":
		case "starting":
			return "started";
		case "success":
		case "succeeded":
		case "complete":
		case "completed":
			return "succeeded";
		case "failure":
		case "failed":
		case "errored":
			return "failed";
		case "waiting":
		case "paused":
			return "waiting";
		case "resolved":
		case "resumed":
		case "received":
			return "resolved";
		default:
			return null;
	}
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function workflowRetryable(data: unknown): boolean | null {
	const explicit = booleanValue(recordUnknown(data, ["retryable"]));
	if (explicit != null) return explicit;
	const error = recordUnknown(data, ["error"]);
	const errorName = recordValue(error, ["name"]);
	return errorName && /nonretryable/i.test(errorName) ? false : null;
}

export function summarizeSkillRunArtifact(
	artifact: SkillRunArtifact,
): SkillWorkflowArtifactSummary {
	return {
		path: artifact.path,
		mimeType: artifact.mimeType,
		sizeBytes: artifact.sizeBytes,
		outcome: artifact.outcome,
		attempt: artifact.attempt,
		storage: artifact.contentR2Key ? "r2" : "inline",
		createdAt: artifact.createdAt ?? null,
		sha256: artifact.sha256 ?? null,
	};
}

/**
 * Turn durable step artifacts into a stable, agent-readable projection. The
 * parser is deliberately path-driven: runtime record payloads can evolve while
 * the path grammar remains the durable public contract.
 */
export function parseSkillWorkflowRecords(
	resolvedArtifacts: ResolvedSkillRunArtifact[],
	options?: { includeContent?: boolean },
): { steps: SkillWorkflowStep[]; toolCalls: SkillWorkflowToolCall[] } {
	const steps: SkillWorkflowStep[] = [];
	const toolCalls: SkillWorkflowToolCall[] = [];
	const includeContent = options?.includeContent ?? true;

	for (const { artifact, content } of resolvedArtifacts) {
		const segments = artifact.path.split("/");
		let stepIndex = 0;
		let executionEpoch = 0;
		if (segments[0] === "epochs" && segments[2] === "steps") {
			executionEpoch = Number.parseInt(segments[1] ?? "", 10);
			stepIndex = 2;
		}
		if (
			segments[stepIndex] !== "steps" ||
			segments.length < stepIndex + 4 ||
			!Number.isInteger(executionEpoch) ||
			executionEpoch < 0
		) {
			continue;
		}
		const count = Number.parseInt(segments[stepIndex + 2] ?? "", 10);
		if (!Number.isInteger(count) || count < 1) continue;

		const name = decodedStepName(segments[stepIndex + 1] ?? "");
		if (name == null) continue;
		const family = segments[stepIndex + 3] ?? "";
		const leaf = segments.at(-1) ?? "";
		const parsedData = parseJson(content);
		const status = workflowRecordStatus(parsedData);
		const base = {
			path: artifact.path,
			name,
			count,
			executionEpoch,
			stepId: recordValue(parsedData, ["stepId", "id"]),
			outcome:
				status === "started" || status === "waiting"
					? ("pending" as const)
					: artifact.outcome,
			status,
			durationMs: numberValue(recordUnknown(parsedData, ["durationMs"])),
			retryable: workflowRetryable(parsedData),
			sensitiveOutput: booleanValue(
				recordUnknown(parsedData, ["sensitiveOutput"]),
			),
			outputArtifactPath: recordValue(parsedData, ["outputArtifactPath"]),
			error: recordUnknown(parsedData, ["error"]),
			...(SkillWorkflowConnectionRecoverySchema.safeParse(
				recordUnknown(parsedData, ["connectionRecovery"]),
			).success
				? {
						connectionRecovery: SkillWorkflowConnectionRecoverySchema.parse(
							recordUnknown(parsedData, ["connectionRecovery"]),
						),
					}
				: {}),
			provenance: "step_artifact" as const,
			mimeType: artifact.mimeType,
			sizeBytes: artifact.sizeBytes,
			createdAt: artifact.createdAt ?? null,
			data: includeContent ? parsedData : null,
		} as const;

		if (family === "attempts") {
			// Current runtime grammar nests call/rollback evidence under the
			// attempt: attempts/<attempt>/calls/<phase>/<ordinal>.json and
			// attempts/<attempt>/rollback.json. Older runners emitted the flatter
			// attempts/<attempt>.json shape, so retain both.
			const nestedAttempt = Number.parseInt(segments[stepIndex + 4] ?? "", 10);
			if (
				Number.isInteger(nestedAttempt) &&
				nestedAttempt >= 1 &&
				segments[stepIndex + 5] === "calls"
			) {
				const ordinal = Number.parseInt(leaf.replace(/\.json$/i, ""), 10);
				if (!Number.isInteger(ordinal) || ordinal < 1) continue;
				const idempotency = recordUnknown(parsedData, ["idempotency"]);
				const toolCall: SkillWorkflowToolCall = {
					...base,
					kind: "tool_call",
					ordinal,
					attempt: nestedAttempt,
					phase: segments[stepIndex + 6] ?? recordValue(parsedData, ["phase"]),
					namespace: recordValue(parsedData, ["namespace", "app", "server"]),
					method: recordValue(parsedData, ["method", "tool", "toolName"]),
					callId: recordValue(parsedData, ["callId", "call_id"]),
					idempotencyKey: recordValue(parsedData, [
						"idempotencyKey",
						"idempotency_key",
					]),
					idempotencyRequested: booleanValue(
						recordUnknown(idempotency, ["requested"]),
					),
					providerConfirmation: recordValue(idempotency, [
						"providerConfirmation",
					]),
				};
				steps.push(toolCall);
				toolCalls.push(toolCall);
				continue;
			}
			if (
				Number.isInteger(nestedAttempt) &&
				nestedAttempt >= 1 &&
				segments[stepIndex + 5] === "rollback.json"
			) {
				steps.push({ ...base, kind: "rollback", attempt: nestedAttempt });
				continue;
			}

			const attempt = Number.parseInt(leaf.replace(/\.json$/i, ""), 10);
			if (Number.isInteger(attempt) && attempt >= 1) {
				steps.push({ ...base, kind: "attempt", attempt });
			}
			continue;
		}

		if (family === "rollbacks") {
			const attempt = Number.parseInt(leaf.replace(/\.json$/i, ""), 10);
			if (Number.isInteger(attempt) && attempt >= 1) {
				steps.push({ ...base, kind: "rollback", attempt });
			}
			continue;
		}

		if (family === "calls") {
			const match = /^(\d+)-attempt-(\d+)\.json$/i.exec(leaf);
			if (!match) continue;
			const ordinal = Number.parseInt(match[1]!, 10);
			const attempt = Number.parseInt(match[2]!, 10);
			const idempotency = recordUnknown(parsedData, ["idempotency"]);
			const toolCall: SkillWorkflowToolCall = {
				...base,
				kind: "tool_call",
				ordinal,
				attempt,
				phase: recordValue(parsedData, ["phase"]),
				namespace: recordValue(parsedData, ["namespace", "app", "server"]),
				method: recordValue(parsedData, ["method", "tool", "toolName"]),
				callId: recordValue(parsedData, ["callId", "call_id"]),
				idempotencyKey: recordValue(parsedData, [
					"idempotencyKey",
					"idempotency_key",
				]),
				idempotencyRequested: booleanValue(
					recordUnknown(idempotency, ["requested"]),
				),
				providerConfirmation: recordValue(idempotency, [
					"providerConfirmation",
				]),
			};
			steps.push(toolCall);
			toolCalls.push(toolCall);
			continue;
		}

		const primitive = family.replace(/\.json$/i, "");
		const kind =
			primitive === "sleep"
				? "sleep"
				: primitive === "sleepUntil"
					? "sleep_until"
					: primitive === "waitForEvent"
						? "wait_for_event"
						: "other";
		steps.push({ ...base, kind, attempt: artifact.attempt });
	}

	steps.sort((a, b) => {
		const byCreated = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
		if (byCreated !== 0) return byCreated;
		return a.path.localeCompare(b.path);
	});
	toolCalls.sort((a, b) => a.path.localeCompare(b.path));
	return { steps, toolCalls };
}

/**
 * Parse a multi-run artifact set while preserving each run's structured
 * evidence boundary before concatenating the projections.
 */
export function parseSkillWorkflowRecordsByRun(
	resolvedArtifacts: ResolvedSkillRunArtifact[],
	options?: { includeContent?: boolean },
): { steps: SkillWorkflowStep[]; toolCalls: SkillWorkflowToolCall[] } {
	const byRun = new Map<string, ResolvedSkillRunArtifact[]>();
	for (const resolved of resolvedArtifacts) {
		const current = byRun.get(resolved.artifact.runId) ?? [];
		current.push(resolved);
		byRun.set(resolved.artifact.runId, current);
	}
	const parsed = [...byRun.values()].map((artifacts) =>
		parseSkillWorkflowRecords(artifacts, options),
	);
	return {
		steps: parsed.flatMap((result) => result.steps),
		toolCalls: parsed.flatMap((result) => result.toolCalls),
	};
}

/**
 * Roll one run's parsed step/call evidence into the schemaVersion-1 cost
 * summary persisted on `skill_runs.cost_summary` at the first terminal
 * observation. Only the run's current execution epoch contributes after a
 * restart. Pure over the `parseSkillWorkflowRecords` projection so the rollup
 * stays consistent with inspection and reliability views.
 */
export function computeSkillRunCostSummary(args: {
	steps: SkillWorkflowStep[];
	toolCalls: SkillWorkflowToolCall[];
	executionEpoch: number;
	startedAt: string | null;
	completedAt: string | null;
}): SkillRunCostSummary {
	const currentSteps = args.steps.filter(
		(step) => step.executionEpoch === args.executionEpoch,
	);
	const currentToolCalls = args.toolCalls.filter(
		(call) => call.executionEpoch === args.executionEpoch,
	);
	const attemptRecords = currentSteps.filter((step) => step.kind === "attempt");
	// Tool calls nest under a step attempt and rollbacks are compensation
	// evidence — neither introduces a new semantic step.
	const stepIdentities = new Set(
		currentSteps
			.filter((step) => step.kind !== "tool_call" && step.kind !== "rollback")
			.map(
				(step) => `${step.executionEpoch}\u0000${step.name}\u0000${step.count}`,
			),
	);
	const namespaceCounts = new Map<string, number>();
	for (const call of currentToolCalls) {
		const namespace = call.namespace ?? "unknown";
		namespaceCounts.set(namespace, (namespaceCounts.get(namespace) ?? 0) + 1);
	}
	const toolCallsByNamespace = Object.fromEntries(namespaceCounts);
	return {
		schemaVersion: 1,
		steps: stepIdentities.size,
		attempts: attemptRecords.length,
		retries: attemptRecords.filter((step) => (step.attempt ?? 1) > 1).length,
		toolCalls: currentToolCalls.length,
		toolCallsByNamespace,
		stepDurationMs: attemptRecords.reduce(
			(sum, step) => sum + (step.durationMs ?? 0),
			0,
		),
		wallMs: durationMs(args),
	};
}

function durationMs(run: {
	startedAt: string | null;
	completedAt: string | null;
}): number | null {
	if (!run.startedAt || !run.completedAt) return null;
	const start = Date.parse(run.startedAt);
	const end = Date.parse(run.completedAt);
	return Number.isFinite(start) && Number.isFinite(end) && end >= start
		? end - start
		: null;
}

export function aggregateSkillWorkflowReliability(args: {
	runs: Array<SkillRunSummaryRow | SkillRun>;
	steps: SkillWorkflowStep[];
	skillId?: string | null;
	tediId?: string | null;
	warnings?: string[];
}): SkillWorkflowReliability {
	const completedCount = args.runs.filter(
		(run) => run.status === "completed",
	).length;
	const failedCount = args.runs.filter((run) => run.status === "failed").length;
	const canceledCount = args.runs.filter(
		(run) => run.status === "canceled",
	).length;
	const terminalCount = completedCount + failedCount + canceledCount;
	const terminalRuns = args.runs.filter(
		(
			run,
		): run is (SkillRunSummaryRow | SkillRun) & {
			status: "completed" | "failed" | "canceled";
		} =>
			run.status === "completed" ||
			run.status === "failed" ||
			run.status === "canceled",
	);
	const expectedOutcomeRows = terminalRuns.map((run) => {
		const policy = readPinnedCapabilityManifest(
			run.capabilityManifest,
		)?.reliability;
		const selector = policy ? run.params?.[policy.parameter] : undefined;
		const expected =
			policy &&
			(typeof selector === "string" ||
				typeof selector === "number" ||
				typeof selector === "boolean")
				? (policy.expectedTerminalStatuses[String(selector)] ?? "completed")
				: "completed";
		return {
			runId: run.id,
			expected,
			actual: run.status,
			matched: expected === run.status,
		};
	});
	const matchedCount = expectedOutcomeRows.filter((row) => row.matched).length;
	const durations = args.runs
		.map(durationMs)
		.filter((value): value is number => value != null);
	const failures = new Map<
		string,
		{ name: string; count: number; failures: number }
	>();
	for (const step of args.steps) {
		if (
			step.kind !== "attempt" ||
			(step.status !== "failed" && step.outcome !== "failure")
		) {
			continue;
		}
		const key = `${step.name}\u0000${step.count}`;
		const current = failures.get(key) ?? {
			name: step.name,
			count: step.count,
			failures: 0,
		};
		current.failures += 1;
		failures.set(key, current);
	}

	return {
		scope: {
			skillId: args.skillId ?? null,
			tediId: args.tediId ?? null,
		},
		runCount: args.runs.length,
		completedCount,
		failedCount,
		canceledCount,
		activeCount: args.runs.length - terminalCount,
		successRate: terminalCount > 0 ? matchedCount / terminalCount : null,
		completionRate: terminalCount > 0 ? completedCount / terminalCount : null,
		expectedOutcomes: {
			evaluatedCount: terminalCount,
			matchedCount,
			unexpectedCount: terminalCount - matchedCount,
			expectedCompletedCount: expectedOutcomeRows.filter(
				(row) => row.expected === "completed",
			).length,
			expectedFailedCount: expectedOutcomeRows.filter(
				(row) => row.expected === "failed",
			).length,
			expectedCanceledCount: expectedOutcomeRows.filter(
				(row) => row.expected === "canceled",
			).length,
			unexpectedRuns: expectedOutcomeRows
				.filter((row) => !row.matched)
				.map(({ runId, expected, actual }) => ({ runId, expected, actual })),
		},
		averageDurationMs:
			durations.length > 0
				? durations.reduce((sum, value) => sum + value, 0) / durations.length
				: null,
		// Count durable structured attempt records directly so the
		// same step/count/attempt in another run or restart epoch is not collapsed.
		retryAttemptCount: args.steps.filter(
			(step) => step.kind === "attempt" && (step.attempt ?? 1) > 1,
		).length,
		rollbackCount: args.steps.filter((step) => step.kind === "rollback").length,
		toolCallCount: args.steps.filter((step) => step.kind === "tool_call")
			.length,
		failedSteps: [...failures.values()].sort(
			(a, b) => b.failures - a.failures || a.name.localeCompare(b.name),
		),
		warnings: args.warnings ?? [],
	};
}
