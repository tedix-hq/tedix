import { createTediLogger } from "../../../log";
import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import {
	type RepoSyncResult,
	readRepoSyncStatus,
} from "../../../workstation/repo-sync";
import { repoSyncInFlight } from "./in-flight";
import { REPO_SYNC_OPTIONS, ACTIVE_WORKSTATION_PROFILE_ID } from "./constants";
import {
	type WorkstationState,
	type WorkstationProcessContext,
	type WorkstationJobStatus,
} from "./types";
import {
	repoWorkdir,
	repoReady,
	execInRuntimeBody,
	shellSingleQuote,
	activeWorkstationIdentity,
	stringBodyValue,
} from "./shared";
import { scheduleRepoSync } from "./prepare";
import { errorMessage } from "@tedix/worker-kit/error-message";
import {
	type JobObservationDiagnostics,
	ACTIVE_WORKSTATION_PARTICIPANT_STATUSES,
	workstationApprovalEscalation,
} from "./process-runtime";
import type {
	WorkstationSeatRole,
	WorkstationStatus,
	WorkstationSessionKind,
	Workstation,
	WorkstationLease,
} from "@tedix/api-contract/schemas/workstation";
import { getWorkstationLeaseBundle } from "../../../workstation/persistence";
import { createDbClient } from "@tedix/db/client";
import {
	persistentWorkstationEnvelope,
	workstationEnvelope,
	markWorkstationBodyStatus,
} from "./envelope";

export const log = createTediLogger("tedi.workstation.process");
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

export const DEPENDENCY_GATED_JOB_KINDS = new Set<WorkstationJobKind>([
	"typecheck",
	"tests",
	"lint",
	"build",
	"deploy",
	"notebook",
	"data",
]);

export function parseWorkstationJobKind(
	value: unknown,
): WorkstationJobKind | null {
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

export function parseOptionalAsyncTimeout(value: unknown): number | null {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	return Math.min(
		Math.max(Math.trunc(numeric), MIN_ASYNC_PROCESS_TIMEOUT_MS),
		MAX_ASYNC_PROCESS_TIMEOUT_MS,
	);
}

export function parsePort(value: unknown, fallback: number): number | null {
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

export async function admitNativeCheckout(
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

export function jobObservationDiagnostics(): JobObservationDiagnostics {
	return { retainedEvidence: "not_read", nativeRegistry: "not_read" };
}

export async function workstationProcessAccessForRequest(
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

export async function workstationCancellationAuthority(
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
export function scheduleWorkstationEnvelope(
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
