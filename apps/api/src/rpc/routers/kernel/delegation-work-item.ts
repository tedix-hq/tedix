/**
 * Kernel — delegation Work Item lifecycle. Creates/claims/heartbeats/disposes
 * the Work Item mirroring a delegated child run, detects stale dispatch rows,
 * extracts delegation proof refs, and surfaces unblocked dependents. This module
 * must NOT import kernel-runtime.ts (the router imports this module; a value
 * import back would create a cycle).
 */

import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { ExecutionRequirement } from "@tedix/api-contract/schemas/execution-evidence";
import type {
	HomePlan,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import {
	getKernelRuntimeRun,
	type KernelRuntimeRun,
	updateKernelRuntimeRunForOrg,
} from "@tedix/db/queries/kernel-runtime-runs";
import {
	listWorkItemAttempts,
	settleWorkItemAttempt,
	startWorkItemAttempt,
} from "@tedix/db/queries/work-items/attempts";
import {
	addWorkItemCommentIfAbsent,
	listWorkItemComments,
} from "@tedix/db/queries/work-items/comments";
import {
	acceptWorkItem,
	cancelWorkItem,
	completeWorkItem,
	createWorkItem,
	getWorkItemById,
	getWorkItemBySourceIntentId,
	listWorkItems,
} from "@tedix/db/queries/work-items/crud";
import { workItemPurposeFor } from "@tedix/db/queries/work-items/purpose";
import {
	findWorkItemsBlockedBy,
	queryWorkItemBlockers,
} from "@tedix/db/queries/work-items/relations";
import { toJsonRecord } from "@tedix/db/utils/json";
import { type BaseContext, createError, ErrorCodes } from "../../orpc";
import {
	type ChildRunLiveness,
	readChildRunResultAndLiveness,
} from "./child-run-reads";
import {
	type DelegatedStopClassification,
	type DeclaredDelegationOutcome,
	delegationVerifyCommand,
	VERIFICATION_MISSING_STOP_REASON,
	verificationRequirementLines,
} from "./delegated-stop";
import { HOME_DELEGATION_REVIEW_SOURCE } from "./delegation-approver";
import { homePlanAssignmentDispatchContent } from "./plan-dispatch";
import {
	delegatedChildSteerRunId,
	errorMessage,
	isTerminalBlockerStatus,
	isTerminalHomeRunStatus,
	nonNullRecord,
	numberFromPayload,
	stringFromPayload,
} from "./runtime-shared";
import {
	admitWorkAttempt,
	WORK_ATTEMPT_ADMISSION_TTL_MS,
} from "../work-items/attempt-admission";

/**
 * Budget for the dispatch handoff itself — the apps/api → child-DO accept-and-
 * queue leg, not the child's turn. Sized to the async inject cap (12s, see
 * packages/provisioning `injectAgentMessage`) plus the <=3s `starting` probe
 * and bounded service-binding/DO cold-start overhead. A 15s budget left no
 * transport margin and false-failed a live dispatch after the child had
 * already claimed its Work Item.
 * This is a request-lifetime clock and must NOT be reused as a staleness window.
 */
export const KERNEL_DELEGATE_ENQUEUE_BUDGET_MS = 20_000;

/**
 * How long a dispatched isolate run may go without publishing its first ledger
 * event before the observer treats it as stranded.
 *
 * Ordering invariant: this MUST sit outside the child's own start watchdog
 * (`apps/tedi-runtime/src/workflow-start-watchdog.ts`, 60s), otherwise the
 * parent seals a child that the child is still repairing. The old 45s value
 * inverted that ordering, and — because it was the same constant as the
 * dispatch budget — measured the child's first row against a clock that starts
 * when the operator's request arrives.
 */
export const KERNEL_DELEGATE_FIRST_EVENT_TIMEOUT_MS = 90_000;

// Workstation-dispatched runs get a wider no-events window than isolate ones:
// a workstation wake/restore routinely
// exceeds the isolate budget before the first ledger event lands.
export const KERNEL_WORKSTATION_DISPATCH_TIMEOUT_MS = 180_000;

export function isWorkstationDispatchedRunRow(row: KernelRuntimeRun): boolean {
	return (
		nonNullRecord(row.runtimeMetadata)?.dispatch === "workstation-dispatched"
	);
}

export function isStaleDelegationDispatchRow(row: KernelRuntimeRun): boolean {
	if (row.status !== "queued" && row.status !== "running") return false;
	if (!row.delegatedTediId || !row.childRunId) return false;
	const referenceAt = row.startedAt ?? row.updatedAt ?? row.createdAt;
	const referenceMs = Date.parse(referenceAt);
	if (!Number.isFinite(referenceMs)) return false;
	const timeoutMs = isWorkstationDispatchedRunRow(row)
		? KERNEL_WORKSTATION_DISPATCH_TIMEOUT_MS
		: KERNEL_DELEGATE_FIRST_EVENT_TIMEOUT_MS;
	return Date.now() - referenceMs >= timeoutMs;
}

// ── Work-Item auto-tracking for kernel DIRECT delegations ──────────────────
//
// The kernel_runtime_runs row is the live run record; the Work Item is the
// DURABLE, provider-neutral work asset that survives the run. For a direct
// (non-plan) delegation the plan-path createWorkItem in approvePlanAssignments
// never fires, so without this the direct delegation leaves no durable WorkSpec.
// Create the specification and its fenced attempt at dispatch; the reconcile
// loop is the authoritative attempt-settlement and evidence adapter.

/**
 * Dispatch content for a kernel DIRECT delegation (the non-plan analogue of
 * `homePlanAssignmentDispatchContent`). Home owns the linked Work Item below
 * the model; the child executes the request and returns evidence only.
 */
export function directDelegationDispatchContent(input: {
	content: string;
	delegateToTediId: string;
	homeRunId: string;
	workItemId: string;
	/** Exact verify command the child must run and quote before it reports. */
	verifyCommand?: string | null;
}): string {
	const verifyCommand = input.verifyCommand?.trim() || null;
	return [
		"Home delegated this request directly to you.",
		"",
		`Request: ${input.content.trim()}`,
		`Work Item: ${input.workItemId}`,
		`Home run: ${input.homeRunId}`,
		"",
		"Home owns the linked Work Item lifecycle below the model. You may read",
		"Work projects and items through assigned MCP apps when the request names",
		"the relevant workspace or project and your scopes allow it. Do NOT create,",
		"start, comment, heartbeat, update, or close Work tracking state. Home writes",
		"durable progress from runtime events,",
		"extracts proof from this child run, and performs the only terminal settlement.",
		"Execute the actual request immediately and end with a clear outcome:",
		"- Respect the original request's mutation limits exactly. If the request",
		"  is read-only or says no production mutations, do not call write tools.",
		"- succeeded — the requested work is complete. Include available result refs;",
		"  a local commit or artifact alone does not mean the request was fulfilled.",
		"- failed — state what failed and what remains undone.",
		"- needs_follow_up — name the owner and the next concrete action.",
		"- Start the final response with exactly `Outcome: succeeded`, `Outcome: failed`,",
		"  or `Outcome: needs_follow_up` so Home can reconcile the attempt outcome.",
		...(verifyCommand
			? ["", ...verificationRequirementLines(verifyCommand), ""]
			: []),
		"Return concise evidence to Home tied back to this request when complete;",
		"the platform will attach it to the Work Item after the run settles.",
	].join("\n");
}

export function requiredProofKindForExecution(
	requirement: ExecutionRequirement,
): DelegationRequiredProofKind {
	if (requirement.surface !== "native") return "terminal_execution";
	return requirement.requiredCapabilities.includes("repository_edit")
		? "code"
		: null;
}

/**
 * Reuse an operator-selected canonical Work Item or eagerly create one and
 * start its fenced attempt
 * for a kernel DIRECT delegation. New items are keyed to the child run id so a
 * double dispatch upserts a single row. Returns the Work Item id (for run-row
 * linkage). Admission and attempt start are mandatory: any failure propagates
 * before a caller can dispatch execution.
 */
export async function createDelegationWorkItem(
	context: BaseContext,
	input: {
		assigneeTediId: string;
		childRunId: string;
		content: string;
		/**
		 * Optional short imperative title. Absent ⇒ derived from `content` by
		 * {@link delegationWorkItemTitle}; the raw prompt is never used as-is.
		 */
		title?: string;
		conversationId: string;
		createdAt: string;
		executionRequirement: ExecutionRequirement;
		homeRunId: string;
		objectiveId?: string;
		organizationId: string;
		workItemId?: string;
	},
): Promise<string> {
	const agentSession = `kernel:${input.childRunId}`;
	const existing = input.workItemId
		? await getWorkItemById(context.db, input.workItemId)
		: await getWorkItemBySourceIntentId(context.db, {
				orgId: input.organizationId,
				sourceIntentId: input.childRunId,
			});
	if (existing) {
		if (
			existing.orgId !== input.organizationId ||
			(existing.accountableOwnerType === "tedi" &&
				existing.accountableOwnerId !== input.assigneeTediId)
		) {
			throw createError(
				ErrorCodes.CONFLICT,
				`Work Item ${existing.id} is unavailable for this delegation`,
			);
		}
		// A held Home delegation item an agent approver admitted is Home's own
		// wrapper, not an operator-selected canonical item: it settles and
		// cancels with the delegation like a freshly minted one.
		const homeDelegationReview =
			nonNullRecord(existing.metadata)?.source ===
				HOME_DELEGATION_REVIEW_SOURCE &&
			nonNullRecord(existing.metadata)?.homeRunId === input.homeRunId;
		const admission = await admitWorkAttempt(context.db, {
			workItem: existing,
			executor: { type: "tedi", id: input.assigneeTediId },
			leaseTtlMs: WORK_ATTEMPT_ADMISSION_TTL_MS,
			now: input.createdAt,
		});
		await startWorkItemAttempt(context.db, {
			workItemId: existing.id,
			orgId: input.organizationId,
			admissionId: admission.id,
			executor: { type: "tedi", id: input.assigneeTediId },
			runId: input.childRunId,
			startedAt: input.createdAt,
			expiresAt: admission.expiresAt,
			metadata: {
				agentSession,
				source: "kernelRuntime.directDelegation",
				homeRunId: input.homeRunId,
				childRunId: input.childRunId,
				canonicalWorkItemReuse: !homeDelegationReview,
			},
		});
		return existing.id;
	}
	if (input.workItemId) {
		throw createError(
			ErrorCodes.CONFLICT,
			`Work Item ${input.workItemId} is unavailable for this delegation`,
		);
	}
	const workItem = await createWorkItem(context.db, {
		id: crypto.randomUUID(),
		orgId: input.organizationId,
		title: delegationWorkItemTitle(input.content, input.title),
		description: input.content.trim() || undefined,
		workKind: "operations",
		priority: "medium",
		accountableOwnerType: "tedi",
		accountableOwnerId: input.assigneeTediId,
		stewardType: "system",
		stewardId: "home",
		...workItemPurposeFor({
			objectiveId: input.objectiveId,
			workClass: "maintenance",
			now: new Date(input.createdAt),
		}),
		sourceSessionKey: input.conversationId,
		sourceIntentId: input.childRunId,
		provenance: {
			source: "kernelRuntime.directDelegation",
			homeRunId: input.homeRunId,
			childRunId: input.childRunId,
		},
		metadata: {
			agentSession,
			delegatedTediId: input.assigneeTediId,
			homeRunId: input.homeRunId,
			childRunId: input.childRunId,
			source: "kernelRuntime.directDelegation",
			purposeContext: input.objectiveId
				? "objective"
				: "transitional_home_exception",
			executionRequirement: input.executionRequirement,
			requiredProofKind: requiredProofKindForExecution(
				input.executionRequirement,
			),
		},
		createdAt: input.createdAt,
	});
	const acceptedWorkItem = await acceptWorkItem(context.db, {
		orgId: input.organizationId,
		workItemId: workItem.id,
		acceptanceContract: {
			version: 1,
			doneLooksLike:
				"The delegated tedi completed the requested work and settled its Attempt with the result.",
		},
		actor: { type: "system", id: "home" },
		acceptedAt: input.createdAt,
	});
	const admission = await admitWorkAttempt(context.db, {
		workItem: acceptedWorkItem,
		executor: { type: "tedi", id: input.assigneeTediId },
		leaseTtlMs: WORK_ATTEMPT_ADMISSION_TTL_MS,
		now: input.createdAt,
	});
	await startWorkItemAttempt(context.db, {
		workItemId: workItem.id,
		orgId: input.organizationId,
		admissionId: admission.id,
		executor: { type: "tedi", id: input.assigneeTediId },
		runId: input.childRunId,
		startedAt: input.createdAt,
		expiresAt: admission.expiresAt,
		metadata: {
			agentSession,
			source: "kernelRuntime.directDelegation",
			homeRunId: input.homeRunId,
			childRunId: input.childRunId,
		},
	});
	return workItem.id;
}

/** Hard cap for a derived Work Item title (first clause, no trailing punctuation). */
export const DELEGATION_WORK_ITEM_TITLE_MAX = 60;

/**
 * Derive a short imperative Work Item title from an operator prompt. A raw
 * prompt is never used as a title: it is often a paragraph, carries
 * formatting instructions ("as a markdown table…"), and reads as noise on the
 * board. Rules, in order:
 *  1. An explicit `title` wins (trimmed, capped).
 *  2. Otherwise the FIRST CLAUSE of the prompt — up to the first sentence
 *     terminator, semicolon, colon, em dash, or newline — with leading
 *     courtesy ("please", "can you", "could you", "por favor", "puedes")
 *     stripped and the first letter capitalized.
 *  3. Capped at {@link DELEGATION_WORK_ITEM_TITLE_MAX} chars on a word
 *     boundary, with any trailing punctuation removed.
 *  4. Empty input ⇒ "Home delegation".
 */
export function delegationWorkItemTitle(
	content: string,
	explicitTitle?: string,
): string {
	const explicit = explicitTitle?.trim().replace(/\s+/g, " ");
	if (explicit) return capTitle(explicit);
	// A context reference carries its own colons, so clause-splitting below would
	// stop inside the token and title the item `[[tedix-context`. Four items on
	// the board were created that way, with the real instruction left in the body
	// and the widget hiding them from customers rather than the title being
	// right. Drop the references before deriving anything from the text.
	const flat = content
		.replace(/\[\[[^\]]*\]\]/g, " ")
		.replace(/\[\[[^\n]*/g, " ")
		.trim()
		.replace(/\s+/g, " ");
	if (!flat) return "Home delegation";
	const clause = flat.split(/[.!?;:\n]|\s[—–-]\s/)[0]?.trim() ?? flat;
	const stripped = clause
		.replace(
			/^(?:(?:hi|hello|hey|hola)[,!\s]+)?(?:please|por favor)[,\s]+/i,
			"",
		)
		.replace(
			/^(?:can|could|would|will)\s+you\s+(?:please\s+)?|^(?:puedes|podr[ií]as|me\s+puedes)\s+/i,
			"",
		)
		.trim();
	const base = stripped || clause || flat;
	return capTitle(base.charAt(0).toUpperCase() + base.slice(1));
}

function capTitle(value: string): string {
	let out = value;
	if (out.length > DELEGATION_WORK_ITEM_TITLE_MAX) {
		out = out.slice(0, DELEGATION_WORK_ITEM_TITLE_MAX);
		const lastSpace = out.lastIndexOf(" ");
		if (lastSpace > DELEGATION_WORK_ITEM_TITLE_MAX / 2)
			out = out.slice(0, lastSpace);
	}
	out = out.replace(/[\s.,;:!?…\-—–]+$/u, "").trim();
	return out || "Home delegation";
}

/**
 * Resolve the Work Item id tracking a direct-delegation run row: the linkage
 * stamped on the run metadata (fast path), else a fallback lookup by
 * sourceIntentId=childRunId. Fail-soft: any error → null.
 */
export async function resolveDelegationWorkItemId(
	context: BaseContext,
	row: KernelRuntimeRun,
): Promise<string | null> {
	const stamped =
		stringFromPayload(nonNullRecord(row.metadata)?.workItemId) ??
		stringFromPayload(nonNullRecord(row.runtimeMetadata)?.workItemId);
	if (stamped) return stamped;
	if (!row.childRunId) return null;
	try {
		const match = (
			await listWorkItems(context.db, {
				orgId: row.organizationId,
				limit: 500,
			})
		).find((item) => item.sourceIntentId === row.childRunId);
		return match?.id ?? null;
	} catch (error) {
		console.warn("[kernelRuntime] resolveDelegationWorkItemId failed", {
			runId: row.id,
			childRunId: row.childRunId,
			error: errorMessage(error),
		});
		return null;
	}
}

/**
 * Keep delegation tracking calm: at most one heartbeat comment per minute,
 * regardless of how many step/tool/delta events the child emits. Exact runtime
 * events remain in the child trace; the Work Item thread only needs a liveness
 * pulse plus structured metadata.
 */
/**
 * Deterministic id for a delegation's terminal disposition comment.
 *
 * The id must be stable for one ATTEMPT (so a racing second reconcile of the
 * same attempt writes no duplicate row) yet distinct ACROSS attempts. Keying it
 * on status alone made a genuine second failure indistinguishable from a
 * duplicate write, so `onConflictDoNothing` silently dropped it while the
 * attempt failure reason and retry count changed underneath.
 *
 * Attempt 0 keeps the historical id so existing rows still match.
 */
/**
 * Map a delegation failure string to the operator-facing reason and the recovery
 * ladder for it. Kept pure so the discrimination is testable without a db.
 *
 * The three cases are genuinely different systems to go look at:
 * `dispatch_never_landed` means the inject never reached the runtime and the
 * child never heard about the work at all; `dispatch_timeout` means the child
 * accepted and then published nothing; anything else is an in-loop failure the
 * child itself reported.
 */
export function classifyDelegationFailureRecovery(
	delegationError: string | null | undefined,
): {
	failureReason:
		| "dispatch_never_landed"
		| "dispatch_timeout"
		| "delegation_failed";
	recoveryHints: Array<
		| "redispatch_same_work_order"
		| "require_durable_proof_ref"
		| "reroute_to_home"
		| "verify_dispatch_ledger"
		| "verify_runtime_liveness"
	>;
} {
	if (delegationError?.startsWith("dispatch_never_landed:")) {
		return {
			failureReason: "dispatch_never_landed",
			recoveryHints: ["redispatch_same_work_order", "verify_dispatch_ledger"],
		};
	}
	if (delegationError?.startsWith("dispatch_timeout:")) {
		return {
			failureReason: "dispatch_timeout",
			recoveryHints: ["redispatch_same_work_order", "verify_runtime_liveness"],
		};
	}
	return {
		failureReason: "delegation_failed",
		recoveryHints: ["redispatch_same_work_order", "reroute_to_home"],
	};
}

export function delegationTerminalCommentId(
	workItemId: string,
	childRunStatus: string,
	retryCount = 0,
): string {
	const base = `${workItemId}:terminal:${childRunStatus}`;
	return retryCount > 0 ? `${base}:${retryCount}` : base;
}

export function delegationWorkItemHeartbeatCommentId(
	workItemId: string,
	referenceAt: string,
): string {
	const referenceMs = Date.parse(referenceAt);
	const bucket = Number.isFinite(referenceMs)
		? new Date(Math.floor(referenceMs / 60_000) * 60_000).toISOString()
		: referenceAt;
	return `${workItemId}:heartbeat:${bucket}`;
}

export function delegationWorkItemHeartbeatBody(input: {
	progress: { current: number; label: string } | null;
}): string {
	const label = input.progress?.label.trim();
	return label
		? `Delegated tedi progress: ${label}.`
		: "Delegated tedi is making progress.";
}

export async function recordDelegationWorkItemHeartbeat(
	context: BaseContext,
	input: {
		childRunId: string;
		createdAt: string;
		delegatedTediId: string;
		latestEventAt: string | null;
		latestEventKind: string | null;
		organizationId: string;
		progress: { current: number; label: string } | null;
		workItemId: string;
	},
): Promise<void> {
	const body = delegationWorkItemHeartbeatBody(input);
	const commentId = delegationWorkItemHeartbeatCommentId(
		input.workItemId,
		input.latestEventAt ?? input.createdAt,
	);
	try {
		await addWorkItemCommentIfAbsent(context.db, {
			id: commentId,
			workItemId: input.workItemId,
			orgId: input.organizationId,
			authorType: "tedi",
			authorId: input.delegatedTediId,
			body,
			metadata: {
				childRunId: input.childRunId,
				childRunLatestEventKind: input.latestEventKind,
				childRunLatestEventAt: input.latestEventAt,
				progress: input.progress,
			},
			createdAt: input.createdAt,
		});
	} catch (error) {
		console.warn("[kernelRuntime] work-item heartbeat insert failed", {
			workItemId: input.workItemId,
			childRunId: input.childRunId,
			error: errorMessage(error),
		});
	}
	// Reporting never renews execution authority. The active runtime owns
	// the exact Attempt heartbeat, including quiet periods without events.
}

/** References and execution telemetry are descriptive; they do not authorize or prove task completion. */
export interface DelegationProofRefs {
	hasProof: boolean;
	evidenceState: "verified" | "missing" | "unknown";
	terminalExecutionSucceeded: boolean;
	repoCommitSha: string | null;
	prRef: string | null;
	artifactRefs: string[];
	rationaleRef: string | null;
	transcript: string | null;
}

export interface DelegationSteeringProofRefs {
	childRunId: string;
	hasProof: boolean;
	latestEventAt: string | null;
	latestEventKind: string | null;
	status: string | null;
	terminalAt: string | null;
	transcript: string | null;
}

export type DelegationRequiredProofKind = "code" | "terminal_execution" | null;

const DELEGATION_PROOF_TRANSCRIPT_PREVIEW_CHARS = 1600;

export function delegationProofTranscriptPreview(
	transcript: string | null,
): string | null {
	if (!transcript) return null;
	return transcript.length > DELEGATION_PROOF_TRANSCRIPT_PREVIEW_CHARS
		? transcript.slice(0, DELEGATION_PROOF_TRANSCRIPT_PREVIEW_CHARS)
		: transcript;
}

/** Extract result references and execution telemetry for inspection, not a completion gate. */
export function extractDelegationProofRefs(input: {
	metadata: Record<string, unknown> | undefined;
	transcript: string | null;
	liveness?: ChildRunLiveness | null;
	stopReason?: string | null;
}): DelegationProofRefs {
	const meta = input.metadata ?? {};
	const transcript = input.transcript?.trim() || null;
	const transcriptRepoCommit = transcript?.match(
		/\brepo_commit\s*[:=]?\s*([0-9a-f]{40})\b/i,
	)?.[1];
	const transcriptPrRef = transcript?.match(
		/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i,
	)?.[0];
	const repoCommitSha =
		stringFromPayload(meta.repoCommitSha) ??
		stringFromPayload(meta.commitSha) ??
		stringFromPayload(meta.commit_sha) ??
		transcriptRepoCommit ??
		null;
	const prRef =
		stringFromPayload(meta.prRef) ??
		stringFromPayload(meta.prUrl) ??
		stringFromPayload(meta.pullRequestUrl) ??
		transcriptPrRef ??
		null;
	const rationaleRef = stringFromPayload(meta.rationaleRef) ?? null;
	const artifactRefs: string[] = [];
	// Match the liveness reader's first-path-segment rule. Every run emits its
	// own turn_summary; that bookkeeping cannot prove the run executed its task.
	const proofTranscript =
		transcript
			?.replace(/\[artifact:([^\]]+)\]/g, (marker, label: string) =>
				label.trim().split("/", 1)[0] === "turn_summary" ? "" : marker,
			)
			?.trim() || null;
	if (transcript) {
		const artifactMatches = transcript.matchAll(/\[artifact:([^\]]+)\]/g);
		for (const m of artifactMatches) {
			const name = m[1]?.trim();
			if (name && name.split("/", 1)[0] !== "turn_summary")
				artifactRefs.push(name);
		}
	}
	// Discovery stall: the run CALLED tools but produced NO execution evidence
	// (only discovery/meta calls). Its transcript — even a "Completed N actions"
	// stub — is not proof of task completion. Answer-only runs (toolCallCount 0)
	// and fail-soft reads (liveness null) are NOT stalls. Nor is a run with an
	// UNCLASSIFIED tool call (a `step.completed` tally the `tool.started` events
	// didn't cover — a ledger blind spot). That is UNKNOWN evidence: accepting the
	// transcript would turn missing observability into an automatic success.
	const unknownEvidence =
		input.liveness != null &&
		input.liveness.toolCallCount > 0 &&
		!input.liveness.hasExecutionEvidence &&
		input.liveness.hasUnclassifiedToolCall;
	const discoveryStall =
		input.liveness != null &&
		input.liveness.toolCallCount > 0 &&
		!input.liveness.hasExecutionEvidence &&
		!input.liveness.hasUnclassifiedToolCall;
	const reportsNonCompletion =
		Boolean(input.stopReason) ||
		(transcript !== null &&
			/(?:^|\n)\s*(?:\*{0,2}Partial result\b|Outcome:\s*needs_follow_up\b|\[Turn stopped early:|\[partial-result\])/im.test(
				transcript,
			)) ||
		// A terminal refusal is an explicit non-completion report even when
		// liveness could not be read. Match status lines, not incidental mentions
		// of a blocked request in an otherwise successful explanatory answer.
		(transcript !== null &&
			/(?:^|\n)(?:[\s#*>`🔴⛔❌]|⚠\uFE0F?)*(?:(?:Status|Outcome):\s*[*`]*\s*)?(?:Blocked\b|(?:403\s+)?Forbidden\b|Execution\s+(?:blocked|denied)\b)/imu.test(
				transcript,
			));
	// Empty-assistant guard: a transcript that is only whitespace, or that the
	// child produced as an empty assistant message, is NOT proof. Explicit
	// runtime early-stop markers (budget/step ceilings) are partial output, not
	// completion proof, even when earlier tool calls left an inspectable trace.
	const transcriptIsProof =
		proofTranscript !== null &&
		proofTranscript.toLowerCase() !== "empty_assistant_message" &&
		!discoveryStall &&
		!unknownEvidence &&
		!reportsNonCompletion;
	const hasHardProof =
		repoCommitSha !== null ||
		prRef !== null ||
		rationaleRef !== null ||
		artifactRefs.length > 0;
	const hasProof = !reportsNonCompletion && (hasHardProof || transcriptIsProof);
	return {
		hasProof,
		evidenceState: hasProof
			? "verified"
			: unknownEvidence
				? "unknown"
				: "missing",
		terminalExecutionSucceeded:
			input.liveness?.hasTerminalExecutionEvidence === true,
		repoCommitSha,
		prRef,
		artifactRefs,
		rationaleRef,
		transcript,
	};
}

async function readDelegatedChildSteeringProof(
	context: BaseContext,
	input: {
		delegatedTediId: string;
		metadata: Record<string, unknown>;
		organizationId: string;
		row: KernelRuntimeRun;
	},
): Promise<DelegationSteeringProofRefs | null> {
	const steerResult = nonNullRecord(input.metadata.delegatedChildSteerResult);
	const steerRunId =
		stringFromPayload(steerResult?.childRunId) ??
		delegatedChildSteerRunId(input.row);
	if (!steerRunId) return null;
	const fallbackTranscript = stringFromPayload(steerResult?.preview);
	let transcript = fallbackTranscript ?? null;
	let liveness: ChildRunLiveness | null = null;
	try {
		const result = await readChildRunResultAndLiveness(context, {
			tediId: input.delegatedTediId,
			runId: steerRunId,
			organizationId: input.organizationId,
		});
		transcript = result.transcript ?? fallbackTranscript ?? null;
		liveness = result.liveness;
	} catch (error) {
		console.warn("[kernelRuntime] read delegated steering proof failed", {
			childRunId: steerRunId,
			error: errorMessage(error),
		});
	}
	const proof = extractDelegationProofRefs({
		metadata: steerResult ?? {},
		transcript,
		liveness,
	});
	return {
		childRunId: steerRunId,
		hasProof: proof.hasProof,
		latestEventAt: stringFromPayload(steerResult?.latestEventAt) ?? null,
		latestEventKind: stringFromPayload(steerResult?.latestEventKind) ?? null,
		status: stringFromPayload(steerResult?.status) ?? null,
		terminalAt: stringFromPayload(steerResult?.terminalAt) ?? null,
		transcript: proof.transcript,
	};
}

/**
 * The disposition a terminal delegation mapped its Work Item to — returned so
 * the operator-facing completion message can disclose the proof verdict
 * instead of silently disagreeing with the Work-Item ledger. Deterministic
 * over (childRunStatus, proof); returned even when the underlying writes were
 * already applied by an earlier reconcile (idempotent re-derivation).
 */
export type DelegationAttemptResult = {
	outcome: "succeeded" | "failed" | "cancelled";
	workItemDisposition: "accepted" | "completed" | "cancelled";
	failureReason:
		| "completed_without_proof"
		| "unverified_execution_evidence"
		| "delegation_failed"
		| "dispatch_timeout"
		| "dispatch_never_landed"
		| "partial_result"
		| "stopped_without_output"
		| "delegation_cancelled"
		| null;
	retryable: boolean;
	hasProof: boolean;
	evidenceState: DelegationProofRefs["evidenceState"];
};

export function delegationCompletionProofBody(input: {
	childRunId: string;
	proof: DelegationProofRefs;
}): string {
	const refs: string[] = [];
	if (input.proof.repoCommitSha) {
		refs.push(`repo_commit ${input.proof.repoCommitSha}`);
	}
	if (input.proof.prRef) refs.push(`PR ${input.proof.prRef}`);
	if (input.proof.rationaleRef) {
		refs.push(`rationale ${input.proof.rationaleRef}`);
	}
	for (const ref of input.proof.artifactRefs) refs.push(`artifact ${ref}`);
	if (refs.length === 0) refs.push(`child_run ${input.childRunId}`);
	return `Delegated tedi reported completion. Result references: ${refs.join("; ")}. Exact output remains in the child-run trace.`;
}

/** Settle the exact tedi Attempt from the task/runtime outcome, then complete Home wrappers.
 * Result references remain telemetry; neither proof qualification nor evidence persistence is a prerequisite.
 */
export async function disposeDelegationWorkItem(
	context: BaseContext,
	input: {
		childRunId: string;
		childRunStatus: TediRunStatus;
		createdAt: string;
		delegatedTediId: string;
		delegationError: string | null;
		/** Runtime stop classification: `partial` (output before the stop) or `failed` (marker only). */
		childStop?: DelegatedStopClassification | null;
		/** Decoded only from the latest final assistant, never synthesized evidence. */
		declaredOutcome?: DeclaredDelegationOutcome | null;
		organizationId: string;
		proof: DelegationProofRefs;
		steeringProof?: DelegationSteeringProofRefs | null;
		workItemId: string;
	},
): Promise<DelegationAttemptResult | null> {
	let outcome: "succeeded" | "failed" | "cancelled";
	let workItemDisposition: "accepted" | "completed" | "cancelled" = "accepted";
	let body: string;
	let releaseReason: string;
	// Record task/runtime failures independently from result references. Failed
	// Attempts leave accepted Work Items available for another attempt.
	let failureReason:
		| "completed_without_proof"
		| "unverified_execution_evidence"
		| "delegation_failed"
		| "dispatch_timeout"
		| "dispatch_never_landed"
		| "partial_result"
		| "stopped_without_output"
		| "delegation_cancelled"
		| undefined;
	let retryable = false;
	let recoveryHints: Array<
		| "redispatch_same_work_order"
		| "require_durable_proof_ref"
		| "reroute_to_home"
		| "verify_dispatch_ledger"
		| "verify_runtime_liveness"
	> = [];
	let canonicalWorkItemReuse = false;
	let homeCreatedDelegationWrapper = false;
	let requiredProofKind: DelegationRequiredProofKind = null;
	try {
		const existingItem = await getWorkItemById(context.db, input.workItemId);
		const existingMetadata = nonNullRecord(existingItem?.metadata);
		homeCreatedDelegationWrapper = Boolean(
			existingItem &&
			((existingMetadata?.source === "kernelRuntime.directDelegation" &&
				existingMetadata.childRunId === input.childRunId) ||
				existingMetadata?.source === HOME_DELEGATION_REVIEW_SOURCE),
		);
		canonicalWorkItemReuse = existingMetadata?.canonicalWorkItemReuse === true;
		requiredProofKind =
			existingMetadata?.requiredProofKind === "code" ||
			existingMetadata?.requiredProofKind === "terminal_execution"
				? existingMetadata.requiredProofKind
				: null;
	} catch (error) {
		console.warn(
			"[kernelRuntime] delegated Work Item reuse lookup failed (fail-soft)",
			{
				workItemId: input.workItemId,
				childRunId: input.childRunId,
				error: errorMessage(error),
			},
		);
	}
	const proofMetadata = {
		childRunId: input.childRunId,
		childRunStatus: input.childRunStatus,
		declaredOutcome: input.declaredOutcome ?? null,
		childStopReason: input.childStop?.stopReason ?? null,
		childStopOutcome: input.childStop?.outcome ?? null,
		childStopDetail: input.childStop?.detail ?? null,
		repoCommitSha: input.proof.repoCommitSha,
		prRef: input.proof.prRef,
		rationaleRef: input.proof.rationaleRef,
		artifactRefs: input.proof.artifactRefs,
		terminalExecutionSucceeded: input.proof.terminalExecutionSucceeded,
		hasProof: input.proof.hasProof,
		evidenceState: input.proof.evidenceState,
		requiredProofKind,
		transcriptPreview: delegationProofTranscriptPreview(input.proof.transcript),
		...(input.steeringProof
			? {
					steeringProof: {
						childRunId: input.steeringProof.childRunId,
						childRunStatus: input.steeringProof.status,
						childRunLatestEventAt: input.steeringProof.latestEventAt,
						childRunLatestEventKind: input.steeringProof.latestEventKind,
						childRunTerminalAt: input.steeringProof.terminalAt,
						hasProof: input.steeringProof.hasProof,
						transcriptPreview: delegationProofTranscriptPreview(
							input.steeringProof.transcript,
						),
					},
				}
			: {}),
		source: "kernelRuntime.directDelegation",
	};

	const verificationMissing =
		input.childStop?.stopReason === VERIFICATION_MISSING_STOP_REASON;
	switch (input.childRunStatus) {
		case "completed":
			if (
				input.declaredOutcome === "failed" ||
				input.declaredOutcome === "needs_follow_up" ||
				(input.childStop && !verificationMissing)
			) {
				outcome = "failed";
				releaseReason = "delegation_reported_non_completion";
				failureReason =
					input.declaredOutcome === "needs_follow_up" ||
					input.childStop?.outcome === "partial"
						? "partial_result"
						: input.childStop && !input.childStop.output
							? "stopped_without_output"
							: "delegation_failed";
				retryable = true;
				recoveryHints = ["redispatch_same_work_order"];
				const reason =
					input.declaredOutcome === "failed" ||
					input.declaredOutcome === "needs_follow_up"
						? `Outcome: ${input.declaredOutcome}`
						: input.childStop?.detail;
				body = `Delegated tedi reported ${reason}. The Work Item remains incomplete. ${delegationProofTranscriptPreview(input.proof.transcript) ?? "See the child-run trace for the reported reason."}`;
			} else if (verificationMissing) {
				// The work order carried a verify command and the child's final
				// report has no `Verification output:` section: a success claim that
				// was never re-run against the operator's reproduction, so it can
				// leave the live failure in place. Partial, not done — whatever
				// proof refs the transcript holds.
				outcome = "failed";
				releaseReason = "delegation_verification_missing";
				failureReason = "partial_result";
				retryable = true;
				recoveryHints = [
					"redispatch_same_work_order",
					"require_durable_proof_ref",
				];
				body = `Delegated tedi reported success, but ${input.childStop?.detail ?? "verification output missing"}. Home treats the result as partial: the verify command was not run, or its output was not quoted under \`Verification output:\`. Recovery: re-run the exact verify command in the child's environment, quote its output, then retry completion.`;
			} else {
				outcome = "succeeded";
				releaseReason = "delegation_completed";
				body = delegationCompletionProofBody({
					childRunId: input.childRunId,
					proof: input.proof,
				});
			}
			break;
		case "failed": {
			outcome = "failed";
			const stop = input.childStop ?? null;
			releaseReason =
				stop?.outcome === "partial"
					? "delegation_partial_result"
					: stop && !stop.output
						? "delegation_stopped_without_output"
						: "delegation_failed";
			// The stale-net dispatch path routes its no-events timeout through
			// here with a `dispatch_timeout:`-prefixed error — discriminate it so
			// recovery re-checks runtime liveness rather than assuming an in-loop
			// failure.
			if (stop?.outcome === "partial") {
				failureReason = "partial_result";
				recoveryHints = [
					"redispatch_same_work_order",
					"require_durable_proof_ref",
				];
			} else if (stop?.output) {
				failureReason = "delegation_failed";
				recoveryHints = ["redispatch_same_work_order"];
			} else if (stop) {
				failureReason = "stopped_without_output";
				recoveryHints = ["redispatch_same_work_order"];
			} else {
				({ failureReason, recoveryHints } = classifyDelegationFailureRecovery(
					input.delegationError,
				));
			}
			retryable = true;
			body =
				stop?.outcome === "partial"
					? `Delegated tedi returned a partial result (${stop.stopReason}; ${stop.detail}). The Work Item remains incomplete. Recovery: continue or re-dispatch the same work order, then attach fresh terminal proof.`
					: stop?.output
						? `Delegated tedi reported failure (${stop.stopReason}; ${stop.detail}). ${delegationProofTranscriptPreview(stop.output)}`
						: stop
							? `Delegated tedi produced no output (${stop.stopReason}; ${stop.detail}). Nothing was delivered, so there is no partial result to continue from. Recovery: re-dispatch the same work order with a tighter scope or a larger budget, then attach terminal proof.`
							: failureReason === "dispatch_never_landed"
								? `Delegation was never dispatched: ${input.delegationError ?? "unknown error"}. The target tedi never received this work order, so this is not a failure of ${input.delegatedTediId}. Recovery: re-dispatch the same work order.`
								: `Delegated tedi failed: ${input.delegationError ?? "unknown error"}. Recovery: Home to re-route or ${input.delegatedTediId} to retry with a corrected approach.`;
			break;
		}
		case "canceled":
			outcome = "cancelled";
			workItemDisposition = canonicalWorkItemReuse ? "accepted" : "cancelled";
			releaseReason = canonicalWorkItemReuse
				? "delegation_cancelled_canonical_reuse"
				: "delegation_cancelled";
			failureReason = canonicalWorkItemReuse
				? undefined
				: "delegation_cancelled";
			retryable = canonicalWorkItemReuse;
			recoveryHints = canonicalWorkItemReuse
				? ["redispatch_same_work_order"]
				: [];
			body = input.steeringProof?.hasProof
				? `Delegated tedi assignment was cancelled. Latest steering evidence: ${
						delegationProofTranscriptPreview(input.steeringProof.transcript) ??
						"see steering proof metadata"
					}`
				: canonicalWorkItemReuse
					? "Delegated tedi assignment was cancelled; the canonical Work Item was returned to accepted for another claim."
					: "Delegated tedi assignment was cancelled.";
			break;
		default:
			return null;
	}
	const result: DelegationAttemptResult = {
		outcome,
		workItemDisposition,
		failureReason: failureReason ?? null,
		retryable,
		hasProof: input.proof.hasProof,
		evidenceState: input.proof.evidenceState,
	};
	const canonicalProofRef =
		input.proof.repoCommitSha ??
		input.proof.prRef ??
		input.proof.artifactRefs[0] ??
		input.proof.rationaleRef ??
		`child-run:${input.childRunId}`;
	let retryCount = 0;
	try {
		const attempts = (
			await listWorkItemAttempts(context.db, {
				orgId: input.organizationId,
				workItemId: input.workItemId,
				limit: 100,
			})
		).data;
		const attempt = attempts.find(
			(candidate) =>
				candidate.runId === input.childRunId &&
				candidate.executorType === "tedi" &&
				candidate.executorId === input.delegatedTediId &&
				["running", "waiting", "retrying"].includes(candidate.runtimeState),
		);
		const settledSucceededAttempt = attempts.find(
			(candidate) =>
				candidate.runId === input.childRunId &&
				candidate.executorType === "tedi" &&
				candidate.executorId === input.delegatedTediId &&
				candidate.runtimeState === "finished" &&
				candidate.outcome === "succeeded",
		);
		const delegationAttempt = attempt ?? settledSucceededAttempt;
		canonicalWorkItemReuse ||=
			nonNullRecord(delegationAttempt?.metadata)?.canonicalWorkItemReuse ===
			true;
		if (input.childRunStatus === "canceled" && canonicalWorkItemReuse) {
			workItemDisposition = "accepted";
			releaseReason = "delegation_cancelled_canonical_reuse";
			failureReason = undefined;
			retryable = true;
			recoveryHints = ["redispatch_same_work_order"];
			body =
				"Delegated tedi assignment was cancelled; the canonical Work Item was returned to accepted for another claim.";
			result.workItemDisposition = "accepted";
			result.failureReason = null;
			result.retryable = true;
		}
		retryCount =
			numberFromPayload(
				nonNullRecord(delegationAttempt?.metadata)?.retryCount,
			) ?? 0;
		// Completion cannot be inferred from evidence belonging to another executor or run.
		if (outcome === "succeeded" && !delegationAttempt) {
			throw new Error(
				"Delegation settlement requires the exact active or previously succeeded attempt fence",
			);
		}

		if (attempt) {
			try {
				await settleWorkItemAttempt(context.db, {
					orgId: input.organizationId,
					workItemId: input.workItemId,
					attemptId: attempt.id,
					executor: { type: "tedi", id: input.delegatedTediId },
					outcome,
					summary: body,
					metadata: toJsonRecord({
						...proofMetadata,
						proof: canonicalProofRef,
						failureReason,
						retryable,
						recoveryHints,
						retryCount,
						releaseReason,
					}),
					settledAt: input.createdAt,
				});
			} catch (error) {
				const latestAttempt = (
					await listWorkItemAttempts(context.db, {
						orgId: input.organizationId,
						workItemId: input.workItemId,
						limit: 100,
					})
				).data.find(
					(candidate) =>
						candidate.id === attempt.id &&
						candidate.executorType === "tedi" &&
						candidate.executorId === input.delegatedTediId,
				);
				const settledAsRequired =
					outcome === "succeeded"
						? latestAttempt?.runtimeState === "finished" &&
							latestAttempt.outcome === "succeeded"
						: latestAttempt?.outcome === outcome;
				if (!settledAsRequired) {
					throw error;
				}
			}
		}
		if (outcome === "succeeded" && homeCreatedDelegationWrapper) {
			// Settled means done: result references remain in Attempt metadata,
			// and evidence storage does not stand between settlement and completion
			// (docs/decisions/minimal-gates-over-pre-proof.md).
			const current = await getWorkItemById(context.db, input.workItemId);
			if (current?.disposition === "accepted") {
				try {
					await completeWorkItem(context.db, {
						orgId: input.organizationId,
						workItemId: input.workItemId,
						actor: { type: "system", id: "home" },
						completedAt: input.createdAt,
					});
				} catch (error) {
					const latest = await getWorkItemById(context.db, input.workItemId);
					if (latest?.disposition !== "completed") throw error;
				}
				workItemDisposition = "completed";
				result.workItemDisposition = "completed";
			} else if (current?.disposition === "completed") {
				workItemDisposition = "completed";
				result.workItemDisposition = "completed";
			} else {
				throw new Error(
					"Home delegation settled but the Work Item is not completable",
				);
			}
		}
		if (outcome === "cancelled" && !canonicalWorkItemReuse) {
			const current = await getWorkItemById(context.db, input.workItemId);
			if (current?.disposition !== "cancelled") {
				await cancelWorkItem(context.db, {
					orgId: input.organizationId,
					workItemId: input.workItemId,
					actor: { type: "tedi", id: input.delegatedTediId },
					reason: releaseReason,
					cancelledAt: input.createdAt,
				});
			}
		}
	} catch (error) {
		if (outcome === "succeeded") throw error;
		console.warn("[kernelRuntime] disposeDelegationWorkItem failed", {
			workItemId: input.workItemId,
			childRunId: input.childRunId,
			error: errorMessage(error),
		});
	}
	try {
		await addWorkItemCommentIfAbsent(context.db, {
			id: delegationTerminalCommentId(
				input.workItemId,
				input.childRunStatus,
				retryCount,
			),
			workItemId: input.workItemId,
			orgId: input.organizationId,
			authorType: "tedi",
			authorId: input.delegatedTediId,
			body,
			metadata: toJsonRecord({
				...proofMetadata,
				failureReason,
				retryable,
				recoveryHints,
				retryCount,
			}),
			createdAt: input.createdAt,
		});
	} catch (error) {
		console.warn("[kernelRuntime] delegation terminal comment failed", {
			workItemId: input.workItemId,
			childRunId: input.childRunId,
			error: errorMessage(error),
		});
	}
	// Successful Home wrappers return only after fenced settlement and canonical
	// completion have converged; failures are not inferred from missing references.
	return result;
}

/**
 * Release a canceled direct delegation immediately, before child terminal
 * telemetry necessarily arrives. Reused canonical work returns to `accepted`;
 * the run-scoped wrapper is terminal `cancelled`. The exact active attempt is
 * the fence, and attempt settlement closes execution authority atomically.
 */
export async function releaseCanceledDelegationWorkItem(
	context: BaseContext,
	input: {
		createdAt: string;
		row: KernelRuntimeRun;
	},
): Promise<void> {
	if (!input.row.childRunId || !input.row.delegatedTediId) return;
	const workItemId = await resolveDelegationWorkItemId(context, input.row);
	if (!workItemId) return;
	try {
		const item = await getWorkItemById(context.db, workItemId);
		if (!item || item.orgId !== input.row.organizationId) return;
		const attempt = (
			await listWorkItemAttempts(context.db, {
				orgId: input.row.organizationId,
				workItemId,
			})
		).data.find(
			(candidate) =>
				candidate.runId === input.row.childRunId &&
				["running", "waiting", "retrying"].includes(candidate.runtimeState),
		);
		if (!attempt) return;
		await settleWorkItemAttempt(context.db, {
			orgId: input.row.organizationId,
			workItemId,
			attemptId: attempt.id,
			executor: { type: "tedi", id: input.row.delegatedTediId },
			outcome: "cancelled",
			summary: "Home cancelled delegation",
			settledAt: input.createdAt,
		});
	} catch (error) {
		console.warn(
			"[kernelRuntime] canceled delegation Work Item release failed (fail-soft)",
			{
				workItemId,
				childRunId: input.row.childRunId,
				error: errorMessage(error),
			},
		);
	}
}

/**
 * Narrow child-enqueue port for the unblock watcher's auto-dispatch. Injected by
 * the caller (run-store wires the cognitive-runtime enqueue client) because this
 * module must stay import-cycle-free of kernel-runtime.ts and
 * cognitive-runtime.ts. The enqueue MUST be idempotency-keyed on
 * `childClientRequestId` so a double-fired reconcile never double-spawns.
 */
export type KernelChildEnqueue = (input: {
	childClientRequestId: string;
	content: string;
	delegateToTediId: string;
	metadata: Record<string, unknown>;
}) => Promise<{
	childRunId: string | null;
	childConversationId?: string | null;
	error?: string | null;
	status?: string | null;
}>;

export type UnblockedAutoDispatchOutcome =
	| { dispatched: true; assignmentId: string; childRunId: string | null }
	| {
			dispatched: false;
			reason:
				| "no-deferral"
				| "not-eligible"
				| "already-latched"
				| "dispatch-error";
			error?: string;
	  };

/**
 * Auto-dispatch a Home-plan assignment whose dispatch was DEFERRED by the
 * cross-tedi blocker gate (created + operator-approved with dispatch requested,
 * but no child run minted because a sibling blocker was non-terminal) now that
 * its blockers are all terminal. The operator gate is preserved: approval
 * already happened at plan-approval time; only the dispatch was parked — this
 * is the missing executor of that parked dispatch, closing the cross-assignment
 * deadlock (live repro: Home run 234803c5, a "waiting for CFO" assignment that
 * outlived its completed blocker forever).
 *
 * Idempotency, layered:
 *   1. a deterministic `{dependentId}:autodispatch` comment latch (D1 single-
 *      statement insert; the reconcile that loses the insert skips),
 *   2. eligibility re-check on the plan row (status "approved", no childRunId),
 *   3. the enqueue's own `{homeRunId}:plan:unblocked:{assignmentId}` idempotency
 *      key, deduplicated by the cognitive runtime.
 * Fail-soft: never throws; a failed dispatch leaves the latch consumed and the
 * error surfaced on the dependency_unblocked comment so the operator can still
 * re-approve manually (the pre-existing fallback path).
 */
export async function autoDispatchDeferredAssignment(
	context: BaseContext,
	input: {
		blockerWorkItemId: string;
		createdAt: string;
		dependentWorkItemId: string;
		enqueue: KernelChildEnqueue;
		organizationId: string;
	},
): Promise<UnblockedAutoDispatchOutcome> {
	try {
		const deferral = (
			await listWorkItemComments(context.db, input.dependentWorkItemId)
		).find(
			(comment) =>
				nonNullRecord(comment.metadata)?.source ===
				"kernelRuntime.approvePlanAssignments",
		);
		const deferralMeta = nonNullRecord(deferral?.metadata);
		const assignmentId = stringFromPayload(deferralMeta?.assignmentId);
		const homeRunId = stringFromPayload(deferralMeta?.homeRunId);
		if (!assignmentId || !homeRunId)
			return { dispatched: false, reason: "no-deferral" };

		const run = await getKernelRuntimeRun(context.db, {
			id: homeRunId,
			organizationId: input.organizationId,
		});
		const runMetadata = nonNullRecord(run?.metadata);
		const plan = nonNullRecord(runMetadata?.homePlan) as HomePlan | null;
		const assignment = plan?.assignments?.find((a) => a.id === assignmentId);
		if (
			!run ||
			!plan ||
			!assignment ||
			assignment.status !== "approved" ||
			assignment.childRunId
		) {
			return { dispatched: false, reason: "not-eligible" };
		}

		// Single-statement latch: exactly one reconcile wins the dispatch.
		const latch = await addWorkItemCommentIfAbsent(context.db, {
			id: `${input.dependentWorkItemId}:autodispatch`,
			workItemId: input.dependentWorkItemId,
			orgId: input.organizationId,
			authorType: "system",
			authorId: "home",
			body: `Auto-dispatching deferred assignment ${assignmentId} (approved at plan approval; dispatch was parked on a sibling blocker).`,
			metadata: {
				assignmentId,
				clearedByWorkItemId: input.blockerWorkItemId,
				homeRunId,
				source: "kernelRuntime.autoDispatchDeferredAssignment",
			},
			createdAt: input.createdAt,
		});
		if (!latch.inserted) {
			return { dispatched: false, reason: "already-latched" };
		}

		// Inject the blocker's terminal output so the dependent actually receives
		// the sibling result its objective references (the deadlock's root cause:
		// assignments fire into isolated contexts with no data channel).
		let blockerNote = `Blocker Work Item ${input.blockerWorkItemId} is terminal; see its Work Item comments for the full result.`;
		try {
			const blocker = await getWorkItemById(
				context.db,
				input.blockerWorkItemId,
			);
			const blockerMeta = nonNullRecord(blocker?.metadata);
			const preview = stringFromPayload(blockerMeta?.childRunPreview);
			if (blocker) {
				blockerNote = [
					`Completed dependency: "${blocker.title}" (Work Item ${blocker.id}, disposition ${blocker.disposition}).`,
					...(preview ? ["Its latest result evidence:", preview] : []),
				].join("\n");
			}
		} catch {
			// Fail-soft: dispatch proceeds with the pointer-only note.
		}
		const sourceRequest = stringFromPayload(
			nonNullRecord(runMetadata?.redriveInput)?.content,
		);
		const content = [
			homePlanAssignmentDispatchContent({
				assignment,
				homeRunId,
				plan,
				sourceRequest,
				workItemId: input.dependentWorkItemId,
			}),
			"",
			"Dependency output (this assignment was dispatched after its blocker finished):",
			blockerNote,
		].join("\n");

		const childClientRequestId = `${homeRunId}:plan:unblocked:${assignmentId}`;
		const result = await input.enqueue({
			childClientRequestId,
			content,
			delegateToTediId: assignment.ownerTediId,
			metadata: {
				homeConversationId: run.conversationId,
				homePlanAssignmentId: assignmentId,
				homePlanId: plan.id,
				homeRunId,
				source: "kernelRuntime.autoDispatchDeferredAssignment",
				workItemId: input.dependentWorkItemId,
			},
		});
		if (result.error && !result.childRunId) {
			return {
				dispatched: false,
				reason: "dispatch-error",
				error: result.error,
			};
		}

		// Reflect the dispatch on the plan's assignment entry so reconciliation
		// tracks the child and the operator card leaves "waiting for ...".
		// Fail-soft: the child run is already the canonical record; a lost
		// metadata update is repaired by the next reconcile's child lookup.
		try {
			const nextPlan: HomePlan = {
				...plan,
				assignments: plan.assignments.map((a) =>
					a.id === assignmentId
						? {
								...a,
								childConversationId: result.childConversationId ?? null,
								childRunId: result.childRunId,
								dispatchedAt: input.createdAt,
								error: null,
								status: "queued",
							}
						: a,
				),
			};
			await updateKernelRuntimeRunForOrg(context.db, {
				id: homeRunId,
				organizationId: input.organizationId,
				patch: {
					metadata: { ...runMetadata, homePlan: nextPlan },
					updatedAt: input.createdAt,
				},
			});
		} catch (error) {
			console.warn(
				"[kernelRuntime] autoDispatchDeferredAssignment plan-metadata update failed (fail-soft)",
				{ assignmentId, homeRunId, error: errorMessage(error) },
			);
		}
		return { dispatched: true, assignmentId, childRunId: result.childRunId };
	} catch (error) {
		return {
			dispatched: false,
			reason: "dispatch-error",
			error: errorMessage(error),
		};
	}
}

/**
 * UNBLOCK WATCHER: after a Work Item reaches a terminal disposition, handle its
 * dependents (the items it `blocks`) that are NOW fully unblocked — i.e. ALL of
 * the dependent's blockers are terminal (done/cancelled per the dispatch gate).
 *
 * When the caller injects a `KernelChildEnqueue` AND the dependent is a
 * plan assignment whose dispatch was deferred by the cross-tedi blocker gate
 * (operator-approved with dispatch requested — no NEW authority is exercised),
 * the parked dispatch is executed via {@link autoDispatchDeferredAssignment}.
 * Everything else stays SURFACE ONLY: a `dependency_unblocked` comment naming
 * the now-ready item; re-dispatch of anything not pre-approved remains
 * operator-gated. Fail-soft (never throws) and idempotent via deterministic
 * comment ids so repeated reconcile polls collapse to one row.
 */
export async function surfaceUnblockedDependents(
	context: BaseContext,
	input: {
		blockerWorkItemId: string;
		organizationId: string;
		createdAt: string;
	},
	deps?: { enqueue?: KernelChildEnqueue },
): Promise<void> {
	try {
		const dependents = await findWorkItemsBlockedBy(
			context.db,
			input.blockerWorkItemId,
		);
		for (const dependent of dependents) {
			// Skip dependents that are themselves already terminal — nothing to start.
			if (isTerminalBlockerStatus(dependent.disposition)) continue;
			let allBlockersTerminal = true;
			try {
				const blockers = await queryWorkItemBlockers(context.db, dependent.id);
				allBlockersTerminal = blockers.every((b) =>
					isTerminalBlockerStatus(b.disposition),
				);
			} catch (error) {
				console.warn(
					"[kernelRuntime] surfaceUnblockedDependents blocker recheck failed",
					{ dependentId: dependent.id, error: errorMessage(error) },
				);
				// Could not confirm all blockers are terminal — do not surface yet.
				continue;
			}
			if (!allBlockersTerminal) continue;
			let outcome: UnblockedAutoDispatchOutcome | null = null;
			if (deps?.enqueue) {
				outcome = await autoDispatchDeferredAssignment(context, {
					blockerWorkItemId: input.blockerWorkItemId,
					createdAt: input.createdAt,
					dependentWorkItemId: dependent.id,
					enqueue: deps.enqueue,
					organizationId: input.organizationId,
				});
				if (
					outcome.dispatched === false &&
					outcome.reason === "already-latched"
				) {
					// A prior reconcile already owns this dispatch; its comment stands.
					continue;
				}
			}
			const body = outcome?.dispatched
				? `Dependency cleared: "${dependent.title}" was auto-dispatched (child run ${outcome.childRunId ?? "pending"}) — its approval predates the deferral; no re-approval needed.`
				: `Dependency cleared: "${dependent.title}" is now unblocked (all blockers are done or cancelled) and is dispatchable. Re-approve it to dispatch.${outcome && "error" in outcome && outcome.error ? ` (Auto-dispatch failed: ${outcome.error})` : ""}`;
			try {
				await addWorkItemCommentIfAbsent(context.db, {
					id: `${dependent.id}:unblocked:${input.blockerWorkItemId}`,
					workItemId: dependent.id,
					orgId: input.organizationId,
					authorType: "system",
					authorId: "home",
					body,
					metadata: {
						dependentWorkItemId: dependent.id,
						clearedByWorkItemId: input.blockerWorkItemId,
						source: "kernelRuntime.surfaceUnblockedDependents",
						...(outcome?.dispatched
							? {
									autoDispatched: true,
									autoDispatchedChildRunId: outcome.childRunId,
								}
							: {}),
					},
					createdAt: input.createdAt,
				});
			} catch (error) {
				console.warn(
					"[kernelRuntime] surfaceUnblockedDependents comment insert failed",
					{ dependentId: dependent.id, error: errorMessage(error) },
				);
			}
		}
	} catch (error) {
		console.warn(
			"[kernelRuntime] surfaceUnblockedDependents failed (fail-soft)",
			{
				blockerWorkItemId: input.blockerWorkItemId,
				error: errorMessage(error),
			},
		);
	}
}

export async function disposeTerminalDirectDelegationWorkItem(
	context: BaseContext,
	input: {
		createdAt: string;
		metadata: Record<string, unknown>;
		preview: string | null;
		row: KernelRuntimeRun;
		run: HomeRun;
	},
	deps?: { enqueue?: KernelChildEnqueue },
): Promise<DelegationAttemptResult | null> {
	if (!input.row.delegatedTediId || !input.row.childRunId) return null;
	if (!isTerminalHomeRunStatus(input.run.status)) return null;
	const terminalWorkItemId = await resolveDelegationWorkItemId(
		context,
		input.row,
	);
	if (!terminalWorkItemId) return null;
	const result =
		input.run.status !== "canceled"
			? await readChildRunResultAndLiveness(context, {
					tediId: input.row.delegatedTediId,
					runId: input.row.childRunId,
					organizationId: input.row.organizationId,
					includeMappedWorkstationRun: isWorkstationDispatchedRunRow(input.row),
					verifyCommand: delegationVerifyCommand(input.metadata),
				})
			: {
					transcript: null,
					liveness: null,
					stopReason: null,
					stop: null,
					declaredOutcome: null,
					readAvailable: true,
				};
	// An unavailable task result is not an ordinary answer without a declaration.
	// Retry reconciliation rather than manufacturing success from runtime termination.
	if (input.run.status === "completed" && result.readAvailable === false) {
		throw new Error(
			"Delegated task outcome is unavailable; retry the authoritative child result read",
		);
	}

	const proof = extractDelegationProofRefs({
		metadata: input.metadata,
		transcript: result.transcript,
		liveness: result.liveness,
		stopReason: result.stopReason,
	});
	const steeringProof = await readDelegatedChildSteeringProof(context, {
		delegatedTediId: input.row.delegatedTediId,
		metadata: input.metadata,
		organizationId: input.row.organizationId,
		row: input.row,
	});
	const failure = nonNullRecord(input.metadata.delegationFailure);
	const delegationError =
		stringFromPayload(failure?.error) ??
		stringFromPayload(failure?.reason) ??
		input.preview ??
		null;
	const disposition = await disposeDelegationWorkItem(context, {
		childRunId: input.row.childRunId,
		childRunStatus: input.run.status,
		childStop: result.stop,
		declaredOutcome: result.declaredOutcome,
		createdAt: input.createdAt,
		delegatedTediId: input.row.delegatedTediId,
		delegationError,
		organizationId: input.row.organizationId,
		proof,
		steeringProof,
		workItemId: terminalWorkItemId,
	});
	await surfaceUnblockedDependents(
		context,
		{
			blockerWorkItemId: terminalWorkItemId,
			organizationId: input.row.organizationId,
			createdAt: input.createdAt,
		},
		deps,
	);
	return disposition;
}
