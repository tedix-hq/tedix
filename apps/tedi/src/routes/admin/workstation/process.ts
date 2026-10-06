import { startCheckoutOperation } from "../../../workstation/checkout-lock";
import {
	commandMayPush,
	pushPublicationProof,
	scopedArtifactsPublicationRemote,
	workstationCommandWithPushPublication,
} from "../../../workstation/push-publication";
import type {
	Workstation,
	WorkstationLease,
	WorkstationSeatRole,
	WorkstationSessionKind,
	WorkstationStatus,
} from "@tedix/api-contract/schemas/workstation";
import { createDbClient } from "@tedix/db/client";
import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import { createTediLogger } from "../../../log";
import {
	workstationExecutionStatus,
	workstationWait,
	workstationKill,
	workstationWaitForPort,
} from "../../../workstation/computer-body";
import { getWorkstationLeaseBundle } from "../../../workstation/persistence";
import {
	type RepoSyncResult,
	readRepoSyncStatus,
} from "../../../workstation/repo-sync";
import {
	ACTIVE_WORKSTATION_PROFILE_ID,
	ACTIVE_WORKSTATION_BINDING,
	DEFAULT_PROCESS_TAIL_BYTES,
	workstationPreparation,
	type WorkstationState,
	type WorkstationProcessContext,
	type WorkstationJobStatus,
	workstationErrorStatus,
	workstationRequestPhases,
	execInRuntimeBody,
	assertCheckoutAuthority,
	isRecoverableWorkstationSandboxError,
	clampTimeout,
	shellSingleQuote,
	workstationOperationLockSelection,
	parseProcessId,
	repoReady,
	repoWorkdir,
	bootstrapReadiness,
	readBootstrapReadiness,
	parseCwd,
	processContextFromBody,
	applyRequestScopedWorkstationEgressContext,
	buildJobCommand,
	parseJsonBody,
	type JobObservationDiagnostics,
	readJobStatus,
	activeWorkstationIdentity,
	ACTIVE_WORKSTATION_PARTICIPANT_STATUSES,
	workstationSessionSelectionForRequest,
	workstationApprovalEscalation,
	workstationOperationAuthority,
	stringBodyValue,
	workstationCorrelationFromBody,
	buildWorkstationProcessEvidence,
	workstationProcessArtifactRefs,
	readPersistedProcessEvidence,
	readBoundedR2Text,
	promoteWorkstationJobEvidence,
	scheduleRepoSync,
	prepareWorkstationFastSafe,
	workstationEnvelope,
	persistentWorkstationEnvelope,
	markWorkstationBodyStatus,
	repoSyncInFlight,
	REPO_SYNC_OPTIONS,
	scheduleRepoSyncForExecution,
} from "./shared";
import { errorMessage } from "@tedix/worker-kit/error-message";

const log = createTediLogger("tedi.workstation.process");
const MIN_ASYNC_PROCESS_TIMEOUT_MS = 1_000;

const MAX_ASYNC_PROCESS_TIMEOUT_MS = 6 * 60 * 60 * 1000;

type WorkstationJobKind =
	| "dependency_install"
	| "typecheck"
	| "tests"
	| "lint"
	| "build"
	| "deploy"
	| "notebook"
	| "data"
	| "command";

const DEPENDENCY_GATED_JOB_KINDS = new Set<WorkstationJobKind>([
	"typecheck",
	"tests",
	"lint",
	"build",
	"deploy",
	"notebook",
	"data",
]);

function parseWorkstationJobKind(value: unknown): WorkstationJobKind | null {
	return typeof value === "string" &&
		(value === "dependency_install" ||
			value === "typecheck" ||
			value === "tests" ||
			value === "lint" ||
			value === "build" ||
			value === "deploy" ||
			value === "notebook" ||
			value === "data" ||
			value === "command")
		? value
		: null;
}

function parseOptionalAsyncTimeout(value: unknown): number | null {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	return Math.min(
		Math.max(Math.trunc(numeric), MIN_ASYNC_PROCESS_TIMEOUT_MS),
		MAX_ASYNC_PROCESS_TIMEOUT_MS,
	);
}

function parsePort(value: unknown, fallback: number): number | null {
	const port =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: fallback;
	if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
	return port;
}

type NativeCheckoutAdmission =
	| {
			ok: true;
			checkoutSha: string | null;
			containerPlacementId: string | null;
	  }
	| { ok: false; error: string };

/**
 * Native Computer disk is deliberately disposable. A repo-sync status is only
 * a readiness observation, not permission to launch against a later container
 * generation. Bind every repo-root job to an immediately observed checkout and
 * placement; callers must rebaseline instead of letting a user command fail in
 * a stale `cd`.
 */
/** Bound on waiting for a repo sync this request scheduled. Well inside the
 * workstation request transport window, which is 120s. */
const REPO_SYNC_ADMISSION_WAIT_MS = 30_000;

/**
 * Wait for the in-flight repo sync, then re-read its status.
 *
 * Returns null when nothing was in flight or the wait ran out — the caller
 * refuses in both cases, exactly as it did before.
 */
async function waitForScheduledRepoSync(
	c: Context<AppEnv>,
): Promise<RepoSyncResult | null> {
	const inFlight = repoSyncInFlight.get(c.get("tediConfig").id);
	if (!inFlight) return null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const finished = await Promise.race([
		inFlight.then(() => true),
		new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), REPO_SYNC_ADMISSION_WAIT_MS);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
	if (!finished) return null;
	try {
		return await readRepoSyncStatus(
			c.get("sandbox"),
			c.get("tediConfig"),
			REPO_SYNC_OPTIONS,
		);
	} catch {
		return null;
	}
}

async function admitNativeCheckout(
	c: Context<AppEnv>,
	state: WorkstationState,
	cwd: string,
): Promise<NativeCheckoutAdmission> {
	const workdir = repoWorkdir(state.repoSync);
	if (!workdir || cwd !== workdir) {
		return {
			checkoutSha: null,
			containerPlacementId: state.containerPlacementId,
			ok: true,
		};
	}
	if (!repoReady(state.repoSync)) {
		scheduleRepoSync(c);
		// This command explicitly targets the repo root, so refusing it hands the
		// caller a wasted round trip on a sync we just started ourselves. Wait for
		// it, bounded well inside the request transport window. Commands outside
		// the repo root never reach here and still return immediately while a
		// background sync runs.
		const settled = await waitForScheduledRepoSync(c);
		if (!settled || !repoReady(settled)) {
			return {
				error: "repo_not_ready: checkout sync is still in progress",
				ok: false,
			};
		}
	}
	const probe = await execInRuntimeBody(
		c,
		`test -d ${shellSingleQuote(cwd)} && test -e ${shellSingleQuote(`${cwd}/.git`)} && git -C ${shellSingleQuote(cwd)} rev-parse HEAD`,
		{ timeout: 15_000 },
	).catch((error) => ({
		exitCode: -1,
		stderr: errorMessage(error),
		stdout: "",
	}));
	if (
		probe.exitCode !== 0 ||
		("timedOut" in probe && probe.timedOut) ||
		!probe.stdout.trim()
	) {
		scheduleRepoSync(c);
		return {
			error: `repo_not_ready: native checkout disappeared before launch${probe.stderr ? ` (${probe.stderr.trim()})` : ""}`,
			ok: false,
		};
	}
	return {
		checkoutSha: probe.stdout.trim().split(/\s+/)[0] ?? null,
		containerPlacementId: null,
		ok: true,
	};
}

function jobObservationDiagnostics(): JobObservationDiagnostics {
	return { retainedEvidence: "not_read", nativeRegistry: "not_read" };
}

async function workstationProcessAccessForRequest(
	c: Context<AppEnv>,
	body: Record<string, unknown>,
	context: WorkstationProcessContext | null,
	options: { allowReleasedRead?: boolean } = {},
): Promise<
	| {
			ok: true;
			leadParticipantId: string | null;
			participantId: string | null;
			participantRole: WorkstationSeatRole | null;
			participantTediId: string;
	  }
	| {
			ok: false;
			error: string;
			status: number;
			leadParticipantId?: string | null;
			participantId?: string | null;
			participantRole?: WorkstationSeatRole | null;
			retryable?: boolean;
	  }
> {
	const tediConfig = c.get("tediConfig");
	const identity = activeWorkstationIdentity(tediConfig);
	const requestedLeaseId = stringBodyValue(body, "leaseId");
	const requestedWorkstationId = stringBodyValue(body, "workstationId");
	const requestedParticipantId = stringBodyValue(body, "participantId");
	const contextLeaseId = context?.leaseId ?? null;
	const contextWorkstationId = context?.workstationId ?? null;
	if (
		requestedLeaseId &&
		contextLeaseId &&
		requestedLeaseId !== contextLeaseId
	) {
		return {
			ok: false,
			error: `process belongs to lease ${contextLeaseId}, not ${requestedLeaseId}`,
			status: 403,
		};
	}
	if (
		requestedWorkstationId &&
		contextWorkstationId &&
		requestedWorkstationId !== contextWorkstationId
	) {
		return {
			ok: false,
			error: `process belongs to workstation ${contextWorkstationId}, not ${requestedWorkstationId}`,
			status: 403,
		};
	}

	const leaseId = requestedLeaseId ?? contextLeaseId;
	const workstationId = requestedWorkstationId ?? contextWorkstationId;
	if (!leaseId) {
		const participantId =
			requestedParticipantId ??
			context?.participantId ??
			identity.leadParticipantId;
		const leadParticipantId =
			context?.leadParticipantId ?? identity.leadParticipantId;
		return {
			ok: true,
			leadParticipantId,
			participantId,
			participantRole: participantId === leadParticipantId ? "lead" : null,
			participantTediId: tediConfig.id,
		};
	}
	if (leaseId === identity.leaseId) {
		if (workstationId && workstationId !== identity.workstationId) {
			return {
				ok: false,
				error: `workstationId ${workstationId} does not match lease ${leaseId}`,
				status: 403,
			};
		}
		const participantId =
			requestedParticipantId ??
			context?.participantId ??
			identity.leadParticipantId;
		const leadParticipantId =
			context?.leadParticipantId ?? identity.leadParticipantId;
		return {
			ok: true,
			leadParticipantId,
			participantId,
			participantRole: participantId === leadParticipantId ? "lead" : null,
			participantTediId: tediConfig.id,
		};
	}
	if (!requestedLeaseId && context?.participantTediId === tediConfig.id) {
		return {
			ok: true,
			leadParticipantId: context.leadParticipantId,
			participantId: context.participantId,
			participantRole:
				context.participantId === context.leadParticipantId ? "lead" : null,
			participantTediId: context.participantTediId,
		};
	}
	if (!c.env.DB) {
		return {
			ok: false,
			error: "workstation lease access requires DB persistence",
			status: 503,
		};
	}
	const bundle = await getWorkstationLeaseBundle(
		createDbClient(c.env.DB),
		leaseId,
	);
	if (!bundle) {
		return {
			ok: false,
			error: `workstation lease not found: ${leaseId}`,
			status: 404,
		};
	}
	const lease = bundle.workstationLease;
	if (lease.organizationId !== tediConfig.organizationId) {
		return {
			ok: false,
			error: `workstation lease ${leaseId} is not in this organization`,
			status: 403,
		};
	}
	if (lease.profileId !== ACTIVE_WORKSTATION_PROFILE_ID) {
		return {
			ok: false,
			error: `workstation lease ${leaseId} is not a workstation`,
			status: 400,
		};
	}
	if (workstationId && workstationId !== bundle.workstation.id) {
		return {
			ok: false,
			error: `workstationId ${workstationId} does not match lease ${leaseId}`,
			status: 403,
		};
	}
	const explicitParticipantId = stringBodyValue(body, "participantId");
	const participant =
		(explicitParticipantId
			? lease.participants.find(
					(candidate) => candidate.id === explicitParticipantId,
				)
			: lease.participants.find(
					(candidate) => candidate.tediId === tediConfig.id,
				)) ?? null;
	if (!participant || participant.tediId !== tediConfig.id) {
		return {
			ok: false,
			error: `workstation lease ${leaseId} has no participant for tedi ${tediConfig.id}`,
			status: 403,
		};
	}
	if (!ACTIVE_WORKSTATION_PARTICIPANT_STATUSES.has(participant.status)) {
		if (options.allowReleasedRead) {
			const leadParticipantId =
				context?.leadParticipantId ??
				lease.participants.find((candidate) => candidate.role === "lead")?.id ??
				lease.participants[0]?.id ??
				null;
			return {
				ok: true,
				leadParticipantId,
				participantId: participant.id,
				participantRole: participant.role,
				participantTediId: participant.tediId,
			};
		}
		return {
			ok: false,
			error: `workstation participant ${participant.id} is not active`,
			status: 403,
			participantId: participant.id,
			participantRole: participant.role,
			retryable: false,
		};
	}
	const leadParticipantId =
		context?.leadParticipantId ??
		lease.participants.find((candidate) => candidate.role === "lead")?.id ??
		lease.participants[0]?.id ??
		null;
	return {
		ok: true,
		leadParticipantId,
		participantId: participant.id,
		participantRole: participant.role,
		participantTediId: participant.tediId,
	};
}

const WORKSTATION_CANCEL_AUTHORITY_ROLES = new Set<WorkstationSeatRole>([
	"lead",
	"operator",
]);

async function workstationCancellationAuthority(
	c: Context<AppEnv>,
	body: Record<string, unknown>,
	job: WorkstationJobStatus,
): Promise<
	| { ok: true }
	| {
			ok: false;
			reason: "invalid_session" | "participant_not_authorized";
			error: string;
			escalation?: ReturnType<typeof workstationApprovalEscalation>;
			ownerParticipantId?: string;
			requestingParticipantId?: string | null;
			requestingParticipantRole?: WorkstationSeatRole | null;
	  }
> {
	const ownerParticipantId = job.context?.participantId;
	if (!ownerParticipantId) return { ok: true };
	const access = await workstationProcessAccessForRequest(c, body, job.context);
	if (!access.ok) {
		return {
			ok: false,
			reason: "invalid_session",
			error: access.error,
			ownerParticipantId,
			requestingParticipantId: access.participantId ?? null,
		};
	}
	const requestingParticipantId = access.participantId;
	const leadParticipantId =
		job.context?.leadParticipantId ?? access.leadParticipantId;
	if (
		requestingParticipantId === ownerParticipantId ||
		requestingParticipantId === leadParticipantId ||
		(access.participantRole !== null &&
			WORKSTATION_CANCEL_AUTHORITY_ROLES.has(access.participantRole))
	) {
		return { ok: true };
	}
	const requiredRoles = Array.from(WORKSTATION_CANCEL_AUTHORITY_ROLES);
	return {
		ok: false,
		escalation: workstationApprovalEscalation({
			approvalKind: "workstation.process.cancel",
			ownerParticipantId,
			reason: "participant_role_requires_approval",
			requestingParticipantId,
			requestingParticipantRole: access.participantRole,
			requiredRoles,
		}),
		reason: "participant_not_authorized",
		error: `participant ${requestingParticipantId} with role ${access.participantRole ?? "unknown"} cannot cancel process owned by ${ownerParticipantId} without approval`,
		ownerParticipantId,
		requestingParticipantId,
		requestingParticipantRole: access.participantRole,
	};
}

/**
 * Answer with the envelope now; persist it behind the response.
 *
 * Persisting the lease bundle, the body generation and the body instance,
 * plus the launcher status write, is the largest phase of a `/process/start`
 * request, larger than all of readiness preparation. None of it is on the path to
 * launching the command: the rows it writes are the lease heartbeat and the
 * container-identity join, and no caller reads them back from this response.
 *
 * The write still happens, and still on this request — `waitUntil` keeps the
 * Worker alive for it. What it no longer does is hold the tedi's command
 * behind three D1 round trips. The envelope in the response is the one that
 * was persisted, computed from the same inputs, so the body is unchanged apart
 * from `workstationPersistence.status`, which now honestly says `scheduled`
 * rather than claiming a write that had not landed yet.
 */
function scheduleWorkstationEnvelope(
	c: Context<AppEnv>,
	state: WorkstationState | null,
	status: WorkstationStatus,
	sessionKind: WorkstationSessionKind,
	input: Parameters<typeof persistentWorkstationEnvelope>[4] = {},
): {
	workstation: Workstation;
	workstationLease: WorkstationLease;
	workstationPersistence: { status: "scheduled" };
} {
	const envelope = workstationEnvelope(
		c.get("tediConfig"),
		state,
		status,
		sessionKind,
		input,
	);
	const persisted = persistentWorkstationEnvelope(
		c,
		state,
		status,
		sessionKind,
		input,
	).then(() => markWorkstationBodyStatus(c, status));
	try {
		c.executionCtx.waitUntil(persisted);
	} catch {
		// executionCtx is absent under test; the write still runs detached.
	}
	return { ...envelope, workstationPersistence: { status: "scheduled" } };
}

export async function workstationProcessStatus(c: Context<AppEnv>) {
	const body = await parseJsonBody(c);
	if (!body) return c.json({ ok: false, error: "Invalid JSON body" }, 400);
	const rawProcessId =
		typeof body.processId === "string" ? body.processId.trim() : "";
	const processId = parseProcessId(rawProcessId, "");
	if (!processId)
		return c.json({ ok: false, error: "processId is required" }, 400);
	const phases = workstationRequestPhases({
		processId,
		leaseId: c.get("workstationRuntimeSelection")?.leaseId,
	});
	const diagnostics = jobObservationDiagnostics();
	const persistedEvidence = await phases.time("retainedEvidence", () =>
		readPersistedProcessEvidence(c, processId, diagnostics),
	);
	if (persistedEvidence) {
		const access = await phases.time("access", () =>
			workstationProcessAccessForRequest(
				c,
				body,
				{
					admittedAt: null,
					admittedCheckoutSha: null,
					admittedContainerPlacementId: null,
					conversationId: persistedEvidence.conversationId ?? null,
					kernelRunId: persistedEvidence.kernelRunId,
					leadParticipantId: null,
					leaseId: persistedEvidence.leaseId,
					operationLock: persistedEvidence.operationLock,
					operationLockSource: persistedEvidence.operationLockSource,
					participantId: persistedEvidence.participantId,
					participantTediId: persistedEvidence.participantTediId ?? null,
					sessionId: persistedEvidence.sessionId,
					sessionKind: persistedEvidence.sessionKind,
					traceBundleId: null,
					traceId: persistedEvidence.traceId,
					workItemId: persistedEvidence.workItemId,
					workstationId: persistedEvidence.workstationId,
				},
				{ allowReleasedRead: true },
			),
		);
		if (!access.ok) {
			return c.json(
				{
					ok: false,
					found: true,
					error: access.error,
					processId,
					retryable: access.retryable ?? false,
				},
				workstationErrorStatus(access.status),
			);
		}
		const effectiveTailBytes =
			typeof body.tailBytes === "number" && body.tailBytes > 0
				? body.tailBytes
				: DEFAULT_PROCESS_TAIL_BYTES;
		const persistedArtifacts = workstationProcessArtifactRefs(c, processId);
		const [persistedStdoutTail, persistedStderrTail] =
			c.env.TEDI_STORAGE &&
			persistedEvidence.artifactWriteStatus?.status !== "failed"
				? await phases.time("retainedLogs", () =>
						Promise.all([
							readBoundedR2Text(
								c.env.TEDI_STORAGE,
								persistedArtifacts.stdout.key,
								effectiveTailBytes,
							),
							readBoundedR2Text(
								c.env.TEDI_STORAGE,
								persistedArtifacts.stderr.key,
								effectiveTailBytes,
							),
						]),
					)
				: ["", ""];
		const localPaths = persistedEvidence.localLogPaths ?? {
			logDir: "",
			stdoutPath: "",
			stderrPath: "",
		};
		const persistedJob: WorkstationJobStatus = {
			id: processId,
			processId,
			found: true,
			command: persistedEvidence.command,
			context: {
				admittedAt: null,
				admittedCheckoutSha: null,
				admittedContainerPlacementId: null,
				conversationId: persistedEvidence.conversationId ?? null,
				kernelRunId: persistedEvidence.kernelRunId,
				leadParticipantId: access.leadParticipantId,
				leaseId: persistedEvidence.leaseId,
				operationLock: persistedEvidence.operationLock,
				operationLockSource: persistedEvidence.operationLockSource,
				participantId: persistedEvidence.participantId,
				participantTediId: persistedEvidence.participantTediId ?? null,
				sessionId: persistedEvidence.sessionId,
				sessionKind: persistedEvidence.sessionKind,
				traceBundleId: null,
				traceId: persistedEvidence.traceId,
				workItemId: persistedEvidence.workItemId,
				workstationId: persistedEvidence.workstationId,
			},
			cwd: persistedEvidence.cwd,
			process: null,
			running: false,
			terminal: true,
			exitCode: persistedEvidence.exitCode,
			signal: persistedEvidence.signal,
			canceled: persistedEvidence.canceled,
			canceledAt: persistedEvidence.canceledAt,
			timeoutMs: persistedEvidence.timeoutMs,
			timedOut: persistedEvidence.timedOut,
			timedOutAt: persistedEvidence.timedOutAt,
			startedAt: persistedEvidence.startedAt,
			endedAt: persistedEvidence.endedAt,
			logDir: localPaths.logDir,
			stdoutPath: localPaths.stdoutPath,
			stderrPath: localPaths.stderrPath,
			tailBytes: effectiveTailBytes,
			stdoutBytes: null,
			stderrBytes: null,
			stdoutTruncated: false,
			stderrTruncated: false,
			stdoutTail: persistedStdoutTail,
			stderrTail: persistedStderrTail,
			...(commandMayPush(persistedEvidence.command ?? "")
				? { publicationProof: pushPublicationProof(persistedStdoutTail) }
				: {}),
			artifactRefs: persistedEvidence.artifactRefs,
			evidence: persistedEvidence,
			artifactWriteStatus: persistedEvidence.artifactWriteStatus ?? {
				reason: "evidence_r2_readback",
				status: "persisted",
			},
			artifactRowPersistence: {
				reason: "evidence_already_persisted",
				status: "skipped",
			},
			workstationEvidencePersistence: {
				reason: "evidence_already_persisted",
				status: "skipped",
			},
		};
		return c.json({
			ok: true,
			found: true,
			persistedEvidenceReadback: true,
			processId,
			job: persistedJob,
		});
	}
	if (c.get("workstationRuntimeSelection")?.released)
		return c.json(
			{
				ok: false,
				found: false,
				processId,
				error: "No retained receipt for this released Computer",
			},
			404,
		);
	const job = await readJobStatus(c, processId, {
		tailBytes: body.tailBytes,
		phases,
		diagnostics,
	});
	if (!job.found) {
		if (job.observation) {
			log.error("Job observation unavailable", {
				event: "workstation.process_observation_unavailable",
				leaseId: c.get("workstationRuntimeSelection")?.leaseId ?? undefined,
				observation: job.observation,
				outcome: "unavailable",
			});
			return c.json({
				ok: false,
				processId,
				error: `workstation job observation ${job.observation}; diagnostics=${JSON.stringify(diagnostics)}${job.containerExitContext ?? ""}`,
				observation: job.observation,
				retryable: job.observation === "unavailable",
			});
		}
		return c.json({
			ok: false,
			found: false,
			processId,
			error: `process not found: ${processId}`,
			job,
		});
	}
	const access = await phases.time("access", () =>
		workstationProcessAccessForRequest(c, body, job.context),
	);
	if (!access.ok) {
		return c.json(
			{ ok: false, found: true, error: access.error, processId },
			workstationErrorStatus(access.status),
		);
	}
	const promotedJob = await phases.time("evidencePromotion", () =>
		promoteWorkstationJobEvidence(c, job, body),
	);
	return c.json({
		ok: true,
		found: true,
		processId,
		job: promotedJob,
	});
}

export async function startWorkstationProcess(c: Context<AppEnv>) {
	const phases = workstationRequestPhases();
	const body = await parseJsonBody(c);
	if (!body) return c.json({ ok: false, error: "Invalid JSON body" }, 400);
	const command = typeof body.command === "string" ? body.command.trim() : "";
	if (!command) return c.json({ ok: false, error: "command is required" }, 400);
	const processId = parseProcessId(body.processId);
	if (!processId) {
		return c.json(
			{
				ok: false,
				error:
					"processId must start with a letter or number and contain only letters, numbers, underscores, dots, colons, or hyphens",
			},
			400,
		);
	}
	const hasGitPush = commandMayPush(command);
	const operationLockSelection = workstationOperationLockSelection(
		body,
		command,
		hasGitPush,
	);
	if (!operationLockSelection.ok) {
		return c.json({ ok: false, error: operationLockSelection.error }, 400);
	}
	const operationLock = operationLockSelection.lock;

	const selectedSession = await phases.time("session", () =>
		workstationSessionSelectionForRequest(c, body, "shell"),
	);
	if (!selectedSession.ok) {
		return c.json(
			{ ok: false, error: selectedSession.error },
			workstationErrorStatus(selectedSession.status),
		);
	}
	const session = selectedSession.session;
	const operationAuthority = workstationOperationAuthority(
		session,
		operationLock,
	);
	if (!operationAuthority.ok) {
		return c.json(
			{
				ok: false,
				command,
				processId,
				error: operationAuthority.error,
				...operationAuthority.escalation,
			},
			403,
		);
	}

	let state = await prepareWorkstationFastSafe(
		c,
		workstationPreparation(session),
		phases,
	);
	await phases.time("egressContext", () =>
		applyRequestScopedWorkstationEgressContext(c, body, session),
	);
	if (state.setupError) {
		const envelope = await persistentWorkstationEnvelope(
			c,
			state,
			"blocked",
			session.sessionKind,
			{
				...workstationCorrelationFromBody(body),
				participantId: session.participantId,
				session,
				sessionId: session.sessionId,
			},
		);
		await markWorkstationBodyStatus(c, "blocked");
		return c.json({
			ok: false,
			command,
			processId,
			bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
			error: state.setupError,
			repoSync: state.repoSync,
			sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
			setupError: state.setupError,
			tools: state.tools,
			...envelope,
		});
	}

	const existingJob = await phases.time("existingJob", () =>
		readJobStatus(c, processId, { tailBytes: body.tailBytes }),
	);
	if (existingJob.found || existingJob.observation === "unavailable") {
		const existingAccess = await workstationProcessAccessForRequest(
			c,
			body,
			existingJob.context,
		);
		if (!existingAccess.ok) {
			return c.json(
				{ ok: false, error: existingAccess.error, processId },
				workstationErrorStatus(existingAccess.status),
			);
		}
		const existingStatus = repoReady(state.repoSync) ? "degraded" : "blocked";
		const envelope = await persistentWorkstationEnvelope(
			c,
			state,
			existingStatus,
			session.sessionKind,
			{
				...workstationCorrelationFromBody(body),
				participantId: session.participantId,
				session,
				sessionId: session.sessionId,
			},
		);
		await markWorkstationBodyStatus(c, existingStatus);
		const promotedJob = await promoteWorkstationJobEvidence(
			c,
			existingJob,
			body,
		);
		return c.json({
			ok: true,
			alreadyRunning: existingJob.running,
			alreadyDispatched: true,
			command: promotedJob.command ?? command,
			processId,
			bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
			cwd: promotedJob.cwd ?? parseCwd(body.cwd, state.repoSync),
			leaseId: session.leaseId,
			operationLock: promotedJob.context?.operationLock ?? null,
			operationLockSource: promotedJob.context?.operationLockSource ?? null,
			participantId: session.participantId,
			participantTediId: session.participantTediId,
			sessionId: session.sessionId,
			sessionKind: session.sessionKind,
			workstationId: session.workstationId,
			timeoutMs: promotedJob.timeoutMs,
			job: promotedJob,
			repoSync: state.repoSync,
			sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
			timings: phases.timings(),
			tools: state.tools,
			...envelope,
		});
	}

	const timeoutMs = parseOptionalAsyncTimeout(body.timeoutMs);
	const jobKind = parseWorkstationJobKind(body.kind);
	if (body.kind !== undefined && !jobKind) {
		return c.json({ ok: false, error: "invalid workstation job kind" }, 400);
	}
	if (jobKind && DEPENDENCY_GATED_JOB_KINDS.has(jobKind)) {
		const bootstrap = await phases.time("bootstrapReadiness", () =>
			readBootstrapReadiness(c, state, body, session),
		);
		if (!bootstrap.depsReady) {
			return c.json(
				{
					ok: false,
					command,
					processId,
					kind: jobKind,
					error: "workstation dependencies are not ready",
					bootstrap,
					repoSync: state.repoSync,
					retryable:
						bootstrap.installStatus === "missing" ||
						bootstrap.installStatus === "running" ||
						bootstrap.nextAction === "wait_for_repo_sync",
				},
				409,
			);
		}
	}
	scheduleRepoSyncForExecution(c, state);
	let cwd = parseCwd(body.cwd, state.repoSync);
	const admission = await phases.time("admission", () =>
		admitNativeCheckout(c, state, cwd),
	);
	if (!admission.ok) {
		return c.json(
			{
				ok: false,
				command,
				processId,
				error: admission.error,
				repoSync: state.repoSync,
				timings: phases.timings(),
			},
			409,
		);
	}
	const processContext = processContextFromBody(
		c,
		body,
		session,
		operationLock,
		admission,
	);
	const protectedPathExemptRemote = scopedArtifactsPublicationRemote({
		preparation: workstationPreparation(session),
		workItemId: session.leaseBundle?.workstationLease.workItemId,
		attemptId: session.leaseBundle?.workstationLease.attemptId,
		repository: c.get("tediConfig").workstationEgress?.artifactsRepository,
	});
	const executionCommand = await workstationCommandWithPushPublication(
		command,
		{
			allowPush: hasGitPush,
			protectedPathExemptRemote,
		},
	);
	let { paths, wrappedCommand, metadata } = buildJobCommand(
		processId,
		command,
		cwd,
		processContext,
		timeoutMs,
		true,
		executionCommand,
	);
	let execution: { id: string } | null = null;
	const launchStartedAt = Date.now();
	try {
		execution = await startCheckoutOperation(c.get("sandbox"), {
			command: wrappedCommand,
			metadata,
			executionId: processId,
			timeout: timeoutMs ?? undefined,
			mode: "shared",
			authorize: () => assertCheckoutAuthority(c),
		});
	} catch (err) {
		const launchError = err;
		if (!execution) {
			const error =
				state.setupError && isRecoverableWorkstationSandboxError(launchError)
					? state.setupError
					: errorMessage(launchError);
			const envelope = await persistentWorkstationEnvelope(
				c,
				state,
				"blocked",
				session.sessionKind,
				{
					...workstationCorrelationFromBody(body),
					participantId: session.participantId,
					session,
					sessionId: session.sessionId,
				},
			);
			await markWorkstationBodyStatus(c, "blocked");
			return c.json({
				ok: false,
				command,
				processId,
				bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
				error,
				repoSync: state.repoSync,
				sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
				setupError: state.setupError,
				tools: state.tools,
				...envelope,
			});
		}
	}
	phases.mark("launch", launchStartedAt);
	const status = repoReady(state.repoSync) ? "ready" : "degraded";
	const envelope = scheduleWorkstationEnvelope(
		c,
		state,
		status,
		session.sessionKind,
		{
			...workstationCorrelationFromBody(body),
			participantId: session.participantId,
			session,
			sessionId: session.sessionId,
		},
	);
	const startedJob: WorkstationJobStatus = {
		id: processId,
		processId,
		found: true,
		command,
		context: processContext,
		cwd,
		logDir: paths.logDir,
		stdoutPath: paths.stdoutPath,
		stderrPath: paths.stderrPath,
		process: null,
		running: true,
		terminal: false,
		exitCode: null,
		canceled: false,
		canceledAt: null,
		timeoutMs,
		timedOut: false,
		timedOutAt: null,
		startedAt: null,
		endedAt: null,
		tailBytes: DEFAULT_PROCESS_TAIL_BYTES,
		stdoutBytes: null,
		stderrBytes: null,
		stdoutTruncated: false,
		stderrTruncated: false,
		stdoutTail: "",
		stderrTail: "",
	};

	return c.json({
		ok: true,
		command,
		processId,
		bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
		cwd,
		leaseId: session.leaseId,
		operationLock: operationLock?.kind ?? null,
		operationLockSource: operationLock?.source ?? null,
		participantId: session.participantId,
		participantTediId: session.participantTediId,
		sessionId: session.sessionId,
		sessionKind: session.sessionKind,
		workstationId: session.workstationId,
		timeoutMs,
		job: {
			...startedJob,
			artifactRefs: [],
			artifactWriteStatus: {
				reason: "process_not_terminal",
				status: "skipped",
			},
			evidence: buildWorkstationProcessEvidence(c, startedJob, {
				body,
				cwd,
				eventType: "workstation.process.started",
			}),
		},
		repoSync: state.repoSync,
		sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
		timings: phases.timings(),
		tools: state.tools,
		...envelope,
	});
}

export async function waitWorkstationProcess(c: Context<AppEnv>) {
	const body = await parseJsonBody(c);
	if (!body) return c.json({ ok: false, error: "Invalid JSON body" }, 400);
	const processId = parseProcessId(body.processId, "");
	if (!processId)
		return c.json({ ok: false, error: "processId is required" }, 400);
	if (
		c.get("workstationRuntimeSelection")?.released ||
		(await readPersistedProcessEvidence(c, processId))
	)
		return workstationProcessStatus(c);
	const timeoutMs =
		typeof body.timeoutMs === "number"
			? Math.max(1, Math.min(body.timeoutMs, 90_000))
			: 90_000;
	const phases = workstationRequestPhases({ processId });
	const job = await readJobStatus(c, processId, {
		tailBytes: body.tailBytes,
		phases,
	});
	if (!job.found)
		return c.json(
			{ ok: false, found: false, processId, job, observation: job.observation },
			job.observation ? 503 : 404,
		);
	const access = await workstationProcessAccessForRequest(c, body, job.context);
	if (!access.ok)
		return c.json(
			{ ok: false, found: true, processId, error: access.error },
			workstationErrorStatus(access.status),
		);
	const started = Date.now();
	const waited =
		!job.terminal && !job.observation
			? await phases.time("nativeWait", () =>
					workstationWait(c.get("sandbox"), processId, timeoutMs),
				)
			: null;
	const final = job.terminal
		? job
		: await readJobStatus(c, processId, { tailBytes: body.tailBytes, phases });
	if (waited?.observation === "unavailable" && !final.terminal) {
		final.observation = "unavailable";
		final.running = false;
	}
	const promoted = final.terminal
		? await phases.time("finalArtifacts", () =>
				promoteWorkstationJobEvidence(c, final, body),
			)
		: final;
	return c.json({
		...promoted,
		ok: true,
		found: true,
		processId,
		waitedMs: Date.now() - started,
		job: promoted,
		timings: phases.timings(),
	});
}

export async function cancelWorkstationProcess(c: Context<AppEnv>) {
	const body = await parseJsonBody(c);
	if (!body) return c.json({ ok: false, error: "Invalid JSON body" }, 400);
	const rawProcessId =
		typeof body.processId === "string" ? body.processId.trim() : "";
	const processId = parseProcessId(rawProcessId, "");
	if (!processId)
		return c.json({ ok: false, error: "processId is required" }, 400);
	const retained = await readPersistedProcessEvidence(c, processId);
	if (retained?.canceled) {
		const response = await workstationProcessStatus(c);
		if (!response.ok) return response;
		const status = (await response.json()) as Record<string, unknown>;
		return c.json({
			...status,
			canceled: true,
			canceledAt: retained.canceledAt,
		});
	}
	const activeJob = await readJobStatus(c, processId, {
		tailBytes: body.tailBytes,
	});
	const authority = await workstationCancellationAuthority(c, body, activeJob);
	if (!authority.ok) {
		return c.json(
			{
				ok: false,
				found: true,
				processId,
				canceled: false,
				error: authority.error,
				approvalEscalation: authority.escalation ?? null,
				approvalRequired: authority.escalation?.approvalRequired ?? false,
				ownerParticipantId: authority.ownerParticipantId,
				reason: authority.reason,
				requestingParticipantId: authority.requestingParticipantId,
				requestingParticipantRole: authority.requestingParticipantRole,
			},
			authority.reason === "invalid_session" ? 400 : 403,
		);
	}
	if (activeJob.canceled) {
		const promotedJob = await promoteWorkstationJobEvidence(c, activeJob, body);
		return c.json({
			ok: true,
			found: true,
			processId,
			canceled: true,
			canceledAt: promotedJob.canceledAt,
			job: promotedJob,
		});
	}
	if (!activeJob.found || !activeJob.running) {
		return c.json(
			{
				ok: false,
				found: activeJob.found,
				processId,
				canceled: false,
				error: activeJob.found
					? `process is not running: ${processId}`
					: `process not found: ${processId}`,
			},
			404,
		);
	}
	try {
		await workstationKill(c.get("sandbox"), processId);
	} catch (error) {
		return c.json(
			{
				ok: false,
				found: true,
				processId,
				canceled: false,
				observation: "unavailable",
				error: errorMessage(error),
			},
			503,
		);
	}
	const remainingExecution = await workstationExecutionStatus(
		c.get("sandbox"),
		processId,
		{ includeLogs: false },
	);
	const observedJob = await readJobStatus(c, processId, {
		tailBytes: body.tailBytes,
	});
	const job = observedJob.terminal
		? {
				...observedJob,
				canceled: true,
				canceledAt: observedJob.endedAt ?? new Date().toISOString(),
			}
		: observedJob;
	const promotedJob = await promoteWorkstationJobEvidence(c, job, body);
	return c.json({
		ok: true,
		found: true,
		processId,
		canceled: promotedJob.canceled,
		canceledAt: promotedJob.canceledAt,
		job: promotedJob,
		leaked: remainingExecution?.running ?? false,
		remainingExecution,
		remainingProcess: null,
		process: null,
	});
}

export async function startWorkstationDevServer(c: Context<AppEnv>) {
	const body = await parseJsonBody(c);
	if (!body) return c.json({ ok: false, error: "Invalid JSON body" }, 400);
	const command =
		typeof body.command === "string" && body.command.trim()
			? body.command.trim()
			: "bun run dev";
	const port = parsePort(body.port, 3000);
	if (port === null) {
		return c.json(
			{ ok: false, error: "port must be an integer between 1024 and 65535" },
			400,
		);
	}
	const processId = parseProcessId(body.processId, `dev-${port}`);
	if (!processId) {
		return c.json(
			{
				ok: false,
				error:
					"processId must start with a letter or number and contain only letters, numbers, underscores, dots, colons, or hyphens",
			},
			400,
		);
	}

	const selectedSession = await workstationSessionSelectionForRequest(
		c,
		body,
		"dev-server",
	);
	if (!selectedSession.ok) {
		return c.json(
			{ ok: false, error: selectedSession.error },
			workstationErrorStatus(selectedSession.status),
		);
	}
	const session = selectedSession.session;
	let state = await prepareWorkstationFastSafe(
		c,
		workstationPreparation(session),
	);
	await applyRequestScopedWorkstationEgressContext(c, body, session);
	if (state.setupError) {
		const envelope = await persistentWorkstationEnvelope(
			c,
			state,
			"blocked",
			session.sessionKind,
			{
				...workstationCorrelationFromBody(body),
				participantId: session.participantId,
				session,
				sessionId: session.sessionId,
			},
		);
		await markWorkstationBodyStatus(c, "blocked");
		return c.json({
			ok: false,
			command,
			bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
			error: state.setupError,
			port,
			portReady: false,
			repoSync: state.repoSync,
			sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
			setupError: state.setupError,
			tools: state.tools,
			preview: { mode: "computer_port", port, publicUrl: null },
			...envelope,
		});
	}
	scheduleRepoSyncForExecution(c, state);
	let cwd = parseCwd(body.cwd, state.repoSync);
	const admission = await admitNativeCheckout(c, state, cwd);
	if (!admission.ok) {
		return c.json(
			{
				ok: false,
				command,
				bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
				error: admission.error,
				port,
				portReady: false,
				repoSync: state.repoSync,
			},
			409,
		);
	}
	const processContext = processContextFromBody(
		c,
		body,
		session,
		null,
		admission,
	);
	let { paths, wrappedCommand, metadata } = buildJobCommand(
		processId,
		command,
		cwd,
		processContext,
		null,
	);
	let execution: { id: string } | null = null;
	try {
		execution = await startCheckoutOperation(c.get("sandbox"), {
			command: wrappedCommand,
			metadata,
			executionId: processId,
			mode: "shared",
			authorize: () => assertCheckoutAuthority(c),
		});
	} catch (err) {
		const launchError = err;
		if (!execution) {
			const error =
				state.setupError && isRecoverableWorkstationSandboxError(launchError)
					? state.setupError
					: errorMessage(launchError);
			const envelope = await persistentWorkstationEnvelope(
				c,
				state,
				"blocked",
				session.sessionKind,
				{
					...workstationCorrelationFromBody(body),
					participantId: session.participantId,
					session,
					sessionId: session.sessionId,
				},
			);
			await markWorkstationBodyStatus(c, "blocked");
			return c.json({
				ok: false,
				command,
				processId,
				bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
				error,
				port,
				portReady: false,
				repoSync: state.repoSync,
				sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
				setupError: state.setupError,
				tools: state.tools,
				preview: { mode: "computer_port", port, publicUrl: null },
				...envelope,
			});
		}
	}

	let portReady = true;
	let portError: string | null = null;
	try {
		await workstationWaitForPort(c.get("sandbox"), port, {
			timeout: clampTimeout(body.waitForPortMs, 60_000, 180_000),
		});
	} catch (error) {
		portReady = false;
		portError = errorMessage(error);
	}
	const status = portReady && repoReady(state.repoSync) ? "ready" : "degraded";
	const envelope = await persistentWorkstationEnvelope(
		c,
		state,
		status,
		session.sessionKind,
		{
			...workstationCorrelationFromBody(body),
			participantId: session.participantId,
			session,
			sessionId: session.sessionId,
		},
	);
	await markWorkstationBodyStatus(c, status);
	if (!portReady) {
		const failedJob = await readJobStatus(c, processId);
		return c.json({
			ok: false,
			command,
			bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
			error: `Computer dev-server port ${port} is not ready: ${portError ?? "probe failed"}`,
			leaseId: session.leaseId,
			participantId: session.participantId,
			participantTediId: session.participantTediId,
			port,
			portReady: false,
			preview: { mode: "computer_port", port, publicUrl: null },
			processId,
			process: null,
			job: failedJob,
			repoSync: state.repoSync,
			sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
			sessionId: session.sessionId,
			sessionKind: session.sessionKind,
			workstationId: session.workstationId,
			...envelope,
		});
	}

	return c.json({
		ok: true,
		command,
		bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
		leaseId: session.leaseId,
		port,
		participantId: session.participantId,
		participantTediId: session.participantTediId,
		portReady,
		preview: { mode: "computer_port", port, publicUrl: null },
		sessionId: session.sessionId,
		sessionKind: session.sessionKind,
		workstationId: session.workstationId,
		processId,
		process: null,
		job: {
			id: processId,
			processId,
			found: true,
			command,
			context: processContext,
			cwd,
			logDir: paths.logDir,
			stdoutPath: paths.stdoutPath,
			stderrPath: paths.stderrPath,
			process: null,
			running: true,
			terminal: false,
			exitCode: null,
			canceled: false,
			canceledAt: null,
			timeoutMs: null,
			timedOut: false,
			timedOutAt: null,
			startedAt: null,
			endedAt: null,
			tailBytes: DEFAULT_PROCESS_TAIL_BYTES,
			stdoutBytes: null,
			stderrBytes: null,
			stdoutTruncated: false,
			stderrTruncated: false,
			stdoutTail: "",
			stderrTail: "",
			artifactRefs: [],
			artifactWriteStatus: {
				reason: "process_not_terminal",
				status: "skipped",
			},
			evidence: buildWorkstationProcessEvidence(
				c,
				{
					id: processId,
					processId,
					found: true,
					command,
					context: processContext,
					cwd,
					logDir: paths.logDir,
					stdoutPath: paths.stdoutPath,
					stderrPath: paths.stderrPath,
					process: null,
					running: true,
					terminal: false,
					exitCode: null,
					canceled: false,
					canceledAt: null,
					timeoutMs: null,
					timedOut: false,
					timedOutAt: null,
					startedAt: null,
					endedAt: null,
					tailBytes: DEFAULT_PROCESS_TAIL_BYTES,
					stdoutBytes: null,
					stderrBytes: null,
					stdoutTruncated: false,
					stderrTruncated: false,
					stdoutTail: "",
					stderrTail: "",
				},
				{
					body,
					cwd,
					eventType: "workstation.process.started",
				},
			),
		},
		repoSync: state.repoSync,
		sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
		...envelope,
	});
}
