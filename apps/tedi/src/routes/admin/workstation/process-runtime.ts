import type { Context } from "hono";
import type { AppEnv, TediConfig } from "../../../types";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { createWorkstationOutboundHandlerParams } from "../../../runtime/workstation-egress";
import {
	WorkstationSessionKindSchema,
	WorkstationOperationLockSchema,
	type WorkstationSessionKind,
	type WorkstationSeatRole,
	type WorkstationOperationLock,
} from "@tedix/api-contract/schemas/workstation";
import {
	type WorkstationExecResult,
	type WorkstationLaunchResult,
	type WorkstationExecutionStatus,
	withWorkstationObservationDeadline,
	workstationExecutionStatus,
} from "../../../workstation/computer-body";
import {
	commandMayPush,
	pushPublicationProof,
} from "../../../workstation/push-publication";
import { getWorkstationLeaseBundle } from "../../../workstation/persistence";
import { createDbClient } from "@tedix/db/client";
import { canAccessInactiveWorkstation } from "../../../workstation/inactive-lease-access";
import {
	type WorkstationSessionSelection,
	type WorkstationOperationLockSelection,
	type WorkstationProcessContext,
	stringBodyValue,
	WORKSTATION_RUN_HEADER,
	WORKSTATION_CONVERSATION_HEADER,
	ACTIVE_WORKSTATION_PROFILE_ID,
	shellSingleQuote,
	packageManagerCacheDir,
	jobPaths,
	type WorkstationExecOptions,
	type ToolProbe,
	type WorkstationRequestPhases,
	type WorkstationJobStatus,
	workstationRequestPhases,
	clampBytes,
	DEFAULT_PROCESS_TAIL_BYTES,
	MAX_PROCESS_TAIL_BYTES,
	activeWorkstationIdentity,
	type WorkstationProcessEventType,
	type WorkstationOperationLockSource,
	type WorkstationProcessEvidence,
} from "./shared";
import {
	workstationOperationLockedInvocation,
	workstationSessionLockedInvocation,
} from "./locks";

export function processContextFromBody(
	c: Context<AppEnv>,
	body: Record<string, unknown> | null,
	session: WorkstationSessionSelection,
	operationLock: WorkstationOperationLockSelection | null,
	admission: {
		checkoutSha: string | null;
		containerPlacementId: string | null;
	} | null = null,
): WorkstationProcessContext {
	const kernelRunId = stringBodyValue(body, "kernelRunId");
	const headerRunId = c.req.header(WORKSTATION_RUN_HEADER);
	const headerConversationId = c.req.header(WORKSTATION_CONVERSATION_HEADER);
	// These headers exist only on the runtime's internal service-binding hop.
	// A public body, status read, or mismatched run can never assign provenance.
	const trustedConversationId =
		isServiceBinding(c.req.raw.headers) &&
		c.req.header("X-Tedix-Tedi-Id") === c.get("tediConfig").id &&
		kernelRunId &&
		headerRunId === kernelRunId &&
		headerConversationId &&
		headerConversationId.trim() === headerConversationId &&
		headerConversationId.length <= 512
			? headerConversationId
			: null;
	return {
		admittedAt: admission ? new Date().toISOString() : null,
		admittedCheckoutSha: admission?.checkoutSha ?? null,
		admittedContainerPlacementId: admission?.containerPlacementId ?? null,
		conversationId: trustedConversationId,
		kernelRunId,
		leadParticipantId: session.leadParticipantId,
		leaseId: session.leaseId,
		operationLock: operationLock?.kind ?? null,
		operationLockSource: operationLock?.source ?? null,
		participantId: session.participantId,
		participantTediId: session.participantTediId,
		sessionId: session.sessionId,
		sessionKind: session.sessionKind,
		traceBundleId: stringBodyValue(body, "traceBundleId"),
		traceId: traceIdFromRequest(c) ?? stringBodyValue(body, "traceId"),
		workItemId: stringBodyValue(body, "workItemId"),
		workstationId: session.workstationId,
	};
}

export async function applyRequestScopedWorkstationEgressContext(
	c: Context<AppEnv>,
	body: Record<string, unknown> | null,
	session: WorkstationSessionSelection,
): Promise<void> {
	const tediConfig = c.get("tediConfig");
	try {
		await c.get("sandbox").setOutboundPolicy(
			createWorkstationOutboundHandlerParams(tediConfig, {
				attemptId:
					stringBodyValue(body, "attemptId") ??
					session.leaseBundle?.workstationLease.attemptId,
				kernelRunId: stringBodyValue(body, "kernelRunId"),
				leaseId: session.leaseId,
				organizationId: tediConfig.organizationId,
				profileId: ACTIVE_WORKSTATION_PROFILE_ID,
				tediId: session.participantTediId,
				traceBundleId: stringBodyValue(body, "traceBundleId"),
				traceId: traceIdFromRequest(c) ?? stringBodyValue(body, "traceId"),
				workItemId:
					stringBodyValue(body, "workItemId") ??
					session.leaseBundle?.workstationLease.workItemId,
				workstationId: session.workstationId,
			}),
		);
	} catch (error) {
		console.warn(
			"[workstation] request-scoped egress context update failed",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export function parseWorkstationProcessContext(
	value: string,
): WorkstationProcessContext | null {
	if (!value.trim()) return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		const sessionKind = WorkstationSessionKindSchema.safeParse(
			stringBodyValue(parsed, "sessionKind"),
		);
		const operationLock = WorkstationOperationLockSchema.safeParse(
			stringBodyValue(parsed, "operationLock"),
		);
		const operationLockSource = stringBodyValue(parsed, "operationLockSource");
		return {
			admittedAt: stringBodyValue(parsed, "admittedAt"),
			admittedCheckoutSha: stringBodyValue(parsed, "admittedCheckoutSha"),
			admittedContainerPlacementId: stringBodyValue(
				parsed,
				"admittedContainerPlacementId",
			),
			conversationId: stringBodyValue(parsed, "conversationId"),
			kernelRunId: stringBodyValue(parsed, "kernelRunId"),
			leadParticipantId: stringBodyValue(parsed, "leadParticipantId"),
			leaseId: stringBodyValue(parsed, "leaseId"),
			operationLock: operationLock.success ? operationLock.data : null,
			operationLockSource:
				operationLockSource === "detected" || operationLockSource === "explicit"
					? operationLockSource
					: null,
			participantId: stringBodyValue(parsed, "participantId"),
			participantTediId: stringBodyValue(parsed, "participantTediId"),
			sessionId: stringBodyValue(parsed, "sessionId"),
			sessionKind: sessionKind.success ? sessionKind.data : null,
			traceBundleId: stringBodyValue(parsed, "traceBundleId"),
			traceId: stringBodyValue(parsed, "traceId"),
			workItemId: stringBodyValue(parsed, "workItemId"),
			workstationId: stringBodyValue(parsed, "workstationId"),
		};
	} catch {
		return null;
	}
}

/** Metadata from the already governed dispatch, never a new authority grant. */
export function withWorkstationCommitProvenance(
	command: string,
	context: { workItemId: string | null; kernelRunId: string | null },
): string {
	// Clear both variables on unbound commands: the launching shell may belong to another run.
	return [
		`export BUN_INSTALL_CACHE_DIR=${shellSingleQuote(packageManagerCacheDir("bun"))}`,
		`export TEDIX_COMMIT_WORK_ITEM=${shellSingleQuote(context.workItemId ?? "")}`,
		`export TEDIX_COMMIT_AGENT_SESSION=${shellSingleQuote(context.workItemId && context.kernelRunId ? `kernel:${context.kernelRunId}` : "")}`,
		command,
	].join("\n");
}

export function buildJobCommand(
	processId: string,
	command: string,
	cwd: string,
	context: WorkstationProcessContext,
	timeoutMs: number | null,
	lockSession = true,
	executionCommand = command,
) {
	const paths = jobPaths(processId);
	const attributed = withWorkstationCommitProvenance(executionCommand, context);
	const invocation = `bash -lc ${shellSingleQuote(attributed)}`;
	const operation = context.operationLock
		? `(\n${workstationOperationLockedInvocation(context.operationLock, invocation)}\n)`
		: invocation;
	const session =
		lockSession && context.sessionId
			? `(\n${workstationSessionLockedInvocation(context.sessionId, operation)}\n)`
			: operation;
	// Native supervision owns the root exit and descendant drain. The only files
	// retained here spool full artifacts beyond the SDK's bounded replay window.
	const checkoutGuard = context.admittedCheckoutSha
		? `test "$(git rev-parse HEAD)" = ${shellSingleQuote(context.admittedCheckoutSha)} || { echo 'checkout changed after admission' >&2; exit 75; }; `
		: "";
	const commandBody = `cd -- ${shellSingleQuote(cwd)} && ${checkoutGuard}${session}`;
	const script = [
		`mkdir -p ${shellSingleQuote(paths.logDir)}`,
		`exec > >(tee ${shellSingleQuote(paths.stdoutPath)}) 2> >(tee ${shellSingleQuote(paths.stderrPath)} >&2)`,
		`exec bash -lc ${shellSingleQuote(commandBody)}`,
	].join("\n");
	return {
		paths,
		metadata: { command, cwd, context, timeoutMs },
		wrappedCommand: script,
	};
}

export async function parseJsonBody(c: Context<AppEnv>) {
	try {
		return (await c.req.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Probe one workstation tool.
 *
 * The returned object is persisted into `metadata.tools` and validated against
 * a JSON-value schema, which has no `undefined`. An explicit
 * `version: undefined` property therefore fails validation at
 * `metadata.tools -> <tool> -> version`, the wake route 500s, and the
 * provisioning fiber throws on its first poll, permanently freezing the lease.
 * So omit the
 * key entirely rather than setting it to `undefined`.
 */
export async function probeTool(
	exec: (
		command: string,
		options?: WorkstationExecOptions,
	) => Promise<WorkstationExecResult>,
	command: string,
): Promise<ToolProbe> {
	try {
		const result = await exec(command, { timeout: 15_000 });
		if (result.exitCode === 0 && !result.timedOut) {
			const version = (result.stdout || "").trim().split("\n")[0]?.trim();
			return version ? { ok: true, version } : { ok: true };
		}
		return {
			ok: false,
			error: (
				result.stderr ||
				result.stdout ||
				`exit ${result.exitCode}`
			).trim(),
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function probeWorkstationTools(
	exec: (
		command: string,
		options?: WorkstationExecOptions,
	) => Promise<WorkstationExecResult>,
): Promise<Record<"gh" | "git", ToolProbe>> {
	// Probe without a pipe: `gh --version | head -n 1` takes the pipeline's exit
	// code from `head`, so a missing `gh` still reported exit 0 with empty
	// stdout and the probe claimed ok. probeTool keeps only the first line.
	const [git, gh] = await Promise.all([
		probeTool(exec, "git --version"),
		probeTool(exec, "gh --version"),
	]);
	return { gh, git };
}

export type JobObservationDiagnostics = {
	retainedEvidence: string;
	nativeRegistry: string;
};

export async function readNativeLogTail(
	c: Context<AppEnv>,
	path: string,
	limit: number,
) {
	const result = await c.get("sandbox").readFile(path, { encoding: "none" });
	const bytes =
		result.content instanceof Uint8Array
			? result.content
			: new TextEncoder().encode(result.content);
	const tail = bytes.slice(Math.max(0, bytes.byteLength - limit));
	return {
		text: new TextDecoder().decode(tail),
		bytes: bytes.byteLength,
		truncated: bytes.byteLength > limit,
	};
}

export async function readJobStatus(
	c: Context<AppEnv>,
	processId: string,
	options: {
		tailBytes?: unknown;
		phases?: WorkstationRequestPhases;
		diagnostics?: JobObservationDiagnostics;
	} = {},
): Promise<WorkstationJobStatus> {
	const phases = options.phases ?? workstationRequestPhases();
	let association: WorkstationLaunchResult | null = null;
	let observed: WorkstationExecutionStatus | null = null;
	let unavailable = false;
	try {
		association = await phases.time("association", () =>
			withWorkstationObservationDeadline(
				() => c.get("sandbox").readExecutionAssociation(processId),
				{ timeoutMs: 10000, operation: "process association" },
			),
		);
		if (association)
			observed = await phases.time("nativeStatus", () =>
				withWorkstationObservationDeadline(
					() =>
						workstationExecutionStatus(c.get("sandbox"), processId, {
							includeLogs: false,
						}),
					{ timeoutMs: 10000, operation: "process status" },
				),
			);
	} catch {
		unavailable = true;
	}
	const metadata = association?.metadata;
	const tailBytes = clampBytes(
		options.tailBytes,
		DEFAULT_PROCESS_TAIL_BYTES,
		MAX_PROCESS_TAIL_BYTES,
	);
	const paths = jobPaths(processId);
	const empty = { text: "", bytes: 0, truncated: false };
	const logs = observed?.found
		? await phases.time("logTails", () =>
				Promise.all([
					readNativeLogTail(c, paths.stdoutPath, tailBytes).catch(() => ({
						...empty,
						truncated: true,
					})),
					readNativeLogTail(c, paths.stderrPath, tailBytes).catch(() => ({
						...empty,
						truncated: true,
					})),
				]),
			)
		: [empty, empty];
	const stdout = logs[0]!,
		stderr = logs[1]!;
	if (options.diagnostics)
		options.diagnostics.nativeRegistry = observed?.observation ?? "not_found";
	return {
		id: processId,
		processId,
		found: !!association,
		...(unavailable ||
		(association &&
			(!observed ||
				observed.observation === "unavailable" ||
				observed.observation === "not_found"))
			? { observation: "unavailable" as const }
			: {}),
		command: metadata?.command ?? null,
		cwd: metadata?.cwd ?? null,
		context: metadata
			? parseWorkstationProcessContext(JSON.stringify(metadata.context))
			: null,
		process: null,
		running: observed?.running ?? false,
		terminal: observed?.terminal ?? false,
		exitCode: observed?.exitCode ?? null,
		signal: observed?.signal,
		canceled: false,
		canceledAt: null,
		timeoutMs: metadata?.timeoutMs ?? null,
		timedOut: observed?.timedOut ?? false,
		timedOutAt: observed?.timedOut ? (observed.endedAt ?? null) : null,
		startedAt: observed?.startedAt ?? null,
		endedAt: observed?.endedAt ?? null,
		logDir: paths.logDir,
		stdoutPath: paths.stdoutPath,
		stderrPath: paths.stderrPath,
		tailBytes,
		stdoutBytes: stdout.bytes,
		stderrBytes: stderr.bytes,
		stdoutTruncated: stdout.truncated,
		stderrTruncated: stderr.truncated,
		stdoutTail: stdout.text,
		stderrTail: stderr.text,
		...(observed?.terminal && commandMayPush(metadata?.command ?? "")
			? { publicationProof: pushPublicationProof(stdout.text) }
			: {}),
	};
}

export function parseWorkstationSessionKind(
	value: unknown,
	fallback: WorkstationSessionKind,
): WorkstationSessionKind | null {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = WorkstationSessionKindSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function workstationSessionSelection(
	tediConfig: TediConfig,
	body: Record<string, unknown> | null,
	fallbackKind: WorkstationSessionKind,
):
	| { ok: true; session: WorkstationSessionSelection }
	| { ok: false; error: string } {
	const identity = activeWorkstationIdentity(tediConfig);
	const sessionKind = parseWorkstationSessionKind(
		body?.sessionKind,
		fallbackKind,
	);
	if (!sessionKind) {
		return {
			ok: false,
			error: `sessionKind must be one of: ${WorkstationSessionKindSchema.options.join(", ")}`,
		};
	}
	const sessionId =
		stringBodyValue(body, "sessionId") ??
		(sessionKind === "shell"
			? identity.sessionId
			: `${identity.workstationId}_${sessionKind}`);
	const participantId =
		stringBodyValue(body, "participantId") ?? identity.leadParticipantId;
	const participantRole =
		participantId === identity.leadParticipantId ? "lead" : "collaborator";
	return {
		ok: true,
		session: {
			leadParticipantId: identity.leadParticipantId,
			leaseId: identity.leaseId,
			participantId,
			participantRole,
			participantTediId: tediConfig.id,
			sessionId,
			sessionKind,
			workstationId: identity.workstationId,
		},
	};
}

export const ACTIVE_WORKSTATION_PARTICIPANT_STATUSES = new Set([
	"active",
	"invited",
	"paused",
]);

export async function workstationSessionSelectionForRequest(
	c: Context<AppEnv>,
	body: Record<string, unknown> | null,
	fallbackKind: WorkstationSessionKind,
): Promise<
	| { ok: true; session: WorkstationSessionSelection }
	| { ok: false; error: string; status?: number }
> {
	const tediConfig = c.get("tediConfig");
	const base = workstationSessionSelection(tediConfig, body, fallbackKind);
	if (!base.ok) return base;

	const requestedLeaseId = stringBodyValue(body, "leaseId");
	// An EXPLICIT lease selection always resolves the durable D1 bundle, even
	// when its id equals the deterministic implicit id. Treating that equality as
	// an implicit selection rebuilt a blank envelope and erased the lease's Work
	// Item/run/trace correlation on every reuse.
	if (!requestedLeaseId) return base;
	if (!c.env.DB) {
		return {
			ok: false,
			error: "workstation lease selection requires DB persistence",
			status: 503,
		};
	}

	const bundle = await getWorkstationLeaseBundle(
		createDbClient(c.env.DB),
		requestedLeaseId,
	);
	if (!bundle) {
		return {
			ok: false,
			error: `workstation lease not found: ${requestedLeaseId}`,
			status: 404,
		};
	}
	const lease = bundle.workstationLease;
	if (lease.organizationId !== tediConfig.organizationId) {
		return {
			ok: false,
			error: `workstation lease ${requestedLeaseId} is not in this organization`,
			status: 403,
		};
	}
	if (lease.profileId !== ACTIVE_WORKSTATION_PROFILE_ID) {
		return {
			ok: false,
			error: `workstation lease ${requestedLeaseId} is not a workstation`,
			status: 400,
		};
	}

	const explicitParticipantId = stringBodyValue(body, "participantId");
	const leadParticipant =
		lease.participants.find((participant) => participant.role === "lead") ??
		lease.participants[0] ??
		null;
	const participant =
		(explicitParticipantId
			? lease.participants.find(
					(candidate) => candidate.id === explicitParticipantId,
				)
			: lease.participants.find(
					(candidate) => candidate.tediId === tediConfig.id,
				)) ?? null;
	if (!participant) {
		return {
			ok: false,
			error: `workstation lease ${requestedLeaseId} has no selectable participant`,
			status: 403,
		};
	}
	if (
		!ACTIVE_WORKSTATION_PARTICIPANT_STATUSES.has(participant.status) &&
		!canAccessInactiveWorkstation({
			path: new URL(c.req.url).pathname,
			leaseStatus: lease.status,
			participantRole: participant.role,
			participantStatus: participant.status,
			preserveChanges: body?.preserveChanges === true,
		})
	) {
		return {
			ok: false,
			error: `workstation participant ${participant.id} is not active`,
			status: 403,
		};
	}
	if (explicitParticipantId && participant.leaseId !== requestedLeaseId) {
		return {
			ok: false,
			error: `workstation participant ${explicitParticipantId} does not belong to lease ${requestedLeaseId}`,
			status: 403,
		};
	}
	if (explicitParticipantId && participant.tediId !== tediConfig.id) {
		return {
			ok: false,
			error: `workstation participant ${explicitParticipantId} does not belong to tedi ${tediConfig.id}`,
			status: 403,
		};
	}
	const requestedWorkstationId = stringBodyValue(body, "workstationId");
	if (
		requestedWorkstationId &&
		requestedWorkstationId !== bundle.workstation.id
	) {
		return {
			ok: false,
			error: `workstationId ${requestedWorkstationId} does not match lease ${requestedLeaseId}`,
			status: 403,
		};
	}

	const sessionKind = base.session.sessionKind;
	const sessionId =
		stringBodyValue(body, "sessionId") ??
		(sessionKind === "shell"
			? `${bundle.workstation.id}_shell`
			: `${bundle.workstation.id}_${sessionKind}`);
	const existingSession =
		lease.sessions.find((session) => session.id === sessionId) ?? null;
	if (
		existingSession?.participantId &&
		existingSession.participantId !== participant.id
	) {
		return {
			ok: false,
			error: `workstation session ${sessionId} belongs to participant ${existingSession.participantId}`,
			status: 403,
		};
	}

	return {
		ok: true,
		session: {
			leaseBundle: bundle,
			leadParticipantId: leadParticipant?.id ?? participant.id,
			leaseId: lease.id,
			participantId: participant.id,
			participantRole: participant.role,
			participantTediId: participant.tediId,
			sessionId,
			sessionKind,
			workstationId: bundle.workstation.id,
		},
	};
}

export function traceIdFromRequest(c: Context<AppEnv>): string | null {
	const direct =
		c.req.header("X-Trace-Id") ??
		c.req.header("X-Tedix-Trace-Id") ??
		c.req.header("trace-id");
	if (direct?.trim()) return direct.trim();

	const traceparent = c.req.header("traceparent")?.trim();
	const traceId = traceparent?.split("-")[1];
	return traceId && /^[a-f0-9]{32}$/i.test(traceId) ? traceId : null;
}

export function processEventType(
	job: WorkstationJobStatus,
): WorkstationProcessEventType {
	if (job.canceled) return "workstation.process.canceled";
	if (job.timedOut) return "workstation.process.timed_out";
	if (!job.terminal) return "workstation.process.started";
	if (job.exitCode === 0) return "workstation.process.completed";
	return "workstation.process.failed";
}

export const WORKSTATION_NON_IDEMPOTENT_AUTHORITY_ROLES =
	new Set<WorkstationSeatRole>(["lead", "operator", "specialist"]);

export function workstationApprovalEscalation(input: {
	approvalKind: "workstation.operation" | "workstation.process.cancel";
	operationLock?: WorkstationOperationLock | null;
	operationLockSource?: WorkstationOperationLockSource | null;
	ownerParticipantId?: string | null;
	reason: string;
	requestingParticipantId?: string | null;
	requestingParticipantRole?: WorkstationSeatRole | null;
	requiredRoles: WorkstationSeatRole[];
}) {
	return {
		approvalKind: input.approvalKind,
		approvalRequired: true,
		operationLock: input.operationLock ?? null,
		operationLockSource: input.operationLockSource ?? null,
		ownerParticipantId: input.ownerParticipantId ?? null,
		reason: input.reason,
		requestingParticipantId: input.requestingParticipantId ?? null,
		requestingParticipantRole: input.requestingParticipantRole ?? null,
		requiredRoles: input.requiredRoles,
	};
}

export function workstationOperationAuthority(
	session: WorkstationSessionSelection,
	lock: WorkstationOperationLockSelection | null,
):
	| { ok: true }
	| {
			ok: false;
			error: string;
			escalation: ReturnType<typeof workstationApprovalEscalation>;
	  } {
	if (!lock) return { ok: true };
	if (WORKSTATION_NON_IDEMPOTENT_AUTHORITY_ROLES.has(session.participantRole)) {
		return { ok: true };
	}
	const requiredRoles = Array.from(WORKSTATION_NON_IDEMPOTENT_AUTHORITY_ROLES);
	const escalation = workstationApprovalEscalation({
		approvalKind: "workstation.operation",
		operationLock: lock.kind,
		operationLockSource: lock.source,
		reason: "participant_role_requires_approval",
		requestingParticipantId: session.participantId,
		requestingParticipantRole: session.participantRole,
		requiredRoles,
	});
	return {
		ok: false,
		error: `participant ${session.participantId} with role ${session.participantRole} requires approval for workstation operation ${lock.kind}`,
		escalation,
	};
}

export type WorkstationCorrelation = {
	kernelRunId?: string | null;
	traceBundleId?: string | null;
	workItemId?: string | null;
};

export function workstationCorrelationFromBody(
	body: Record<string, unknown> | null,
): WorkstationCorrelation {
	return {
		kernelRunId: stringBodyValue(body, "kernelRunId"),
		traceBundleId: stringBodyValue(body, "traceBundleId"),
		workItemId: stringBodyValue(body, "workItemId"),
	};
}

export function buildWorkstationProcessEvidence(
	c: Context<AppEnv>,
	job: WorkstationJobStatus,
	input: {
		artifactRefs?: string[];
		body?: Record<string, unknown> | null;
		cwd?: string | null;
		eventType?: WorkstationProcessEventType;
	} = {},
): WorkstationProcessEvidence {
	const tediConfig = c.get("tediConfig");
	const selection = workstationSessionSelection(
		tediConfig,
		input.body ?? null,
		job.context?.sessionKind ?? "shell",
	);
	let ids: WorkstationSessionSelection;
	if (selection.ok) {
		ids = selection.session;
	} else {
		const fallbackIdentity = activeWorkstationIdentity(tediConfig);
		ids = {
			leadParticipantId: fallbackIdentity.leadParticipantId,
			leaseId: fallbackIdentity.leaseId,
			participantId: fallbackIdentity.leadParticipantId,
			participantRole: "lead",
			participantTediId: tediConfig.id,
			sessionId: fallbackIdentity.sessionId,
			sessionKind: "shell",
			workstationId: fallbackIdentity.workstationId,
		};
	}
	return {
		conversationId: job.context?.conversationId ?? null,
		eventType: input.eventType ?? processEventType(job),
		workstationId: job.context?.workstationId ?? ids.workstationId,
		leaseId: job.context?.leaseId ?? ids.leaseId,
		profileId: ACTIVE_WORKSTATION_PROFILE_ID,
		sessionId: job.context?.sessionId ?? ids.sessionId,
		sessionKind: job.context?.sessionKind ?? ids.sessionKind,
		processId: job.processId,
		participantId: job.context?.participantId ?? ids.participantId,
		participantTediId: job.context?.participantTediId ?? ids.participantTediId,
		workItemId:
			job.context?.workItemId ??
			stringBodyValue(input.body ?? null, "workItemId") ??
			null,
		kernelRunId:
			job.context?.kernelRunId ??
			stringBodyValue(input.body ?? null, "kernelRunId") ??
			null,
		traceId:
			job.context?.traceId ??
			stringBodyValue(input.body ?? null, "traceId") ??
			traceIdFromRequest(c) ??
			null,
		operationLock: job.context?.operationLock ?? null,
		operationLockSource: job.context?.operationLockSource ?? null,
		command: job.command,
		cwd: input.cwd ?? job.cwd,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		terminal: job.terminal,
		running: job.running,
		exitCode: job.exitCode,
		...(job.signal === undefined ? {} : { signal: job.signal }),
		canceled: job.canceled,
		canceledAt: job.canceledAt,
		timeoutMs: job.timeoutMs,
		timedOut: job.timedOut,
		timedOutAt: job.timedOutAt,
		localLogPaths: {
			logDir: job.logDir,
			stdoutPath: job.stdoutPath,
			stderrPath: job.stderrPath,
		},
		artifactRefs: input.artifactRefs ?? [],
	};
}
