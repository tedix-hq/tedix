import type { TediConfig, AppEnv } from "../../../types";
import {
	type WorkstationStatus,
	type WorkstationBootstrapReadiness,
	createWorkstationSnapshot,
	type WorkstationLeaseStatus,
	type WorkstationSessionKind,
	type Workstation,
	type WorkstationSession,
	type WorkstationLease,
	createWorkstationLease,
} from "@tedix/api-contract/schemas/workstation";
import { workstationEgressPolicySummary } from "../../../runtime/workstation-egress";
import { WORKSTATION_DIR } from "../../../workstation/paths";
import { toJsonRecord } from "@tedix/db/utils/json";
import type { Context } from "hono";
import { upsertWorkstationLeaseBundle } from "../../../workstation/persistence";
import { createDbClient } from "@tedix/db/client";
import {
	getWorkstationLeaseBundle as getWorkstationLeaseRowBundle,
	bindWorkstationLeaseRepositoryAuthority,
	updateWorkstationLeaseBodyGeneration,
	recordWorkstationLeaseBodyInstance,
} from "@tedix/db/queries/workstations";
import { getAuthoritativeWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import { errorMessage } from "@tedix/worker-kit/error-message";
import {
	type WorkstationState,
	type WorkstationPreparation,
	type WorkstationSessionSelection,
} from "./types";
import {
	ACTIVE_WORKSTATION_BINDING,
	ACTIVE_WORKSTATION_PROFILE,
} from "./constants";
import {
	activeWorkstationIdentity,
	workstationPreparation,
	repoWorkdir,
	repoReady,
} from "./shared";
import {
	immutableLeasePreflight,
	preparedPreflight,
} from "./recovery-checkpoint";

export function activeWorkstationSnapshot(
	tediConfig: TediConfig,
	state: WorkstationState | null,
	status: WorkstationStatus,
	readiness?: WorkstationBootstrapReadiness,
	workstationId?: string,
) {
	const metadata: Record<string, unknown> = {
		adapter: ACTIVE_WORKSTATION_BINDING.sessionAdapter,
		adapterKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
		bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
		collaborationMode: "exclusive",
		// Durable record of the container placement observed on this probe. A
		// later probe observing a different id proves the platform replaced the
		// container (its repo tree, processes, and markers died with it) — see
		// observeContainerPlacement.
		containerPlacementId: state?.containerPlacementId ?? null,
		egressPolicy: workstationEgressPolicySummary(tediConfig),
		profileDefaultEnvironment:
			ACTIVE_WORKSTATION_BINDING.profile.defaultEnvironment,
		profileTitle: ACTIVE_WORKSTATION_BINDING.profile.title,
		repoStrategy:
			state?.repoSync.strategy ?? ACTIVE_WORKSTATION_PROFILE.repoStrategy,
		repoSyncStatus:
			state?.repoSync.status ??
			(tediConfig.repoConfig ? "pending" : "not_configured"),
		runtimeKind: tediConfig.runtimeKind ?? "agent",
		sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
		workstationRoot: WORKSTATION_DIR,
		toolsReady: state?.toolsReady ?? false,
	};
	if (state) {
		metadata.credentials = state.credentials;
		metadata.repoSync = state.repoSync;
		metadata.tools = state.tools;
	}
	if (readiness) {
		metadata.bootstrapReadiness = readiness;
		metadata.environmentReady = readiness.environmentReady;
		metadata.depsReady = readiness.depsReady;
		metadata.installStatus = readiness.installStatus;
		metadata.repoReady = readiness.repoReady;
		metadata.secretsReady = readiness.secretsReady;
	}
	if (state?.setupError) {
		metadata.setupError = state.setupError;
	}
	return createWorkstationSnapshot({
		organizationId: tediConfig.organizationId,
		profileId: ACTIVE_WORKSTATION_BINDING.profile.id,
		seats: [
			{
				permissionScopes: [],
				role: "lead",
				slug: tediConfig.slug,
				tediId: tediConfig.id,
			},
		],
		status,
		workstationId,
		metadata,
	});
}

export function leaseStatusFromWorkstationStatus(
	status: WorkstationStatus,
): WorkstationLeaseStatus {
	if (status === "ready") return "active";
	if (status === "blocked") return "blocked";
	if (status === "degraded") return "degraded";
	if (status === "archived") return "released";
	return "provisioning";
}

export function workstationEnvelope(
	tediConfig: TediConfig,
	state: WorkstationState | null,
	status: WorkstationStatus,
	sessionKind: WorkstationSessionKind,
	input: {
		attemptId?: string | null;
		preparation?: WorkstationPreparation;
		executionId?: string | null;
		kernelRunId?: string | null;
		participantId?: string | null;
		readiness?: WorkstationBootstrapReadiness;
		session?: WorkstationSessionSelection;
		sessionId?: string | null;
		traceBundleId?: string | null;
		workItemId?: string | null;
	} = {},
) {
	const identity = activeWorkstationIdentity(
		tediConfig,
		input.executionId ?? input.workItemId ?? input.kernelRunId,
	);
	const snapshot = activeWorkstationSnapshot(
		tediConfig,
		state,
		status,
		input.readiness,
		identity.workstationId,
	);
	snapshot.metadata.preparation =
		input.preparation ??
		state?.preparation ??
		workstationPreparation(input.session);
	const selectedSession = input.session;
	if (selectedSession?.leaseBundle) {
		const now = new Date().toISOString();
		const existingWorkstation = selectedSession.leaseBundle.workstation;
		const existingLease = selectedSession.leaseBundle.workstationLease;
		const original = immutableLeasePreflight(existingLease);
		const observedRepo = snapshot.metadata.repoSync;
		if (
			original &&
			(!input.workItemId || input.workItemId === existingLease.workItemId) &&
			observedRepo &&
			typeof observedRepo === "object" &&
			!Array.isArray(observedRepo)
		) {
			snapshot.metadata.repoSync = {
				...observedRepo,
				treePreflight: toJsonRecord(original),
			};
		}

		const existingSession =
			existingLease.sessions.find(
				(session) => session.id === selectedSession.sessionId,
			) ?? null;
		const workstation: Workstation = {
			...existingWorkstation,
			status,
			metadata: {
				...existingWorkstation.metadata,
				...snapshot.metadata,
			},
		};
		const currentSession: WorkstationSession = {
			adapter: ACTIVE_WORKSTATION_BINDING.sessionAdapter,
			artifactRefs: existingSession?.artifactRefs ?? [],
			endedAt: status === "ready" ? null : now,
			externalId: existingSession?.externalId ?? null,
			id: selectedSession.sessionId,
			kind: selectedSession.sessionKind,
			leaseId: selectedSession.leaseId,
			metadata: existingSession?.metadata ?? {},
			organizationId: existingLease.organizationId,
			participantId: selectedSession.participantId,
			sessionKey: `${selectedSession.participantTediId}:${selectedSession.sessionKind}`,
			startedAt: existingSession?.startedAt ?? now,
			status,
		};
		const workstationLease: WorkstationLease = {
			...existingLease,
			metadata: { ...existingLease.metadata, ...snapshot.metadata },
			kernelRunId: input.kernelRunId ?? existingLease.kernelRunId,
			traceBundleId: input.traceBundleId ?? existingLease.traceBundleId,
			workItemId: input.workItemId ?? existingLease.workItemId,
			attemptId: input.attemptId ?? existingLease.attemptId,
			status: leaseStatusFromWorkstationStatus(status),
			// Operation receipts contain only the session touched by this request.
			// Historical sessions stay durable in D1 and are read through a bounded,
			// paginated history surface rather than replayed on every tool call.
			sessions: [currentSession],
			updatedAt: now,
		};
		return { workstation, workstationLease };
	}

	const workstation = snapshot;
	const sessionId =
		input.sessionId ??
		selectedSession?.sessionId ??
		(sessionKind === "shell"
			? identity.sessionId
			: `${workstation.id}_${sessionKind}`);
	const participantId =
		input.participantId ??
		selectedSession?.participantId ??
		identity.leadParticipantId;
	const lease = createWorkstationLease({
		kernelRunId: input.kernelRunId ?? null,
		leaseId: identity.leaseId,
		metadata: {
			...workstation.metadata,
			executionId: input.executionId ?? null,
		},
		organizationId: tediConfig.organizationId,
		profileId: ACTIVE_WORKSTATION_BINDING.profile.id,
		seats: workstation.seats,
		sessions: [
			{
				adapter: ACTIVE_WORKSTATION_BINDING.sessionAdapter,
				artifactRefs: [],
				endedAt: null,
				externalId: null,
				id: sessionId,
				kind: sessionKind,
				metadata: {},
				participantId,
				sessionKey: `${selectedSession?.participantTediId ?? tediConfig.id}:${sessionKind}`,
				status,
			},
		],
		status: leaseStatusFromWorkstationStatus(status),
		traceBundleId: input.traceBundleId ?? null,
		workItemId: input.workItemId ?? null,
		workstationId: workstation.id,
	});
	return {
		workstation,
		workstationLease: { ...lease, attemptId: input.attemptId ?? null },
	};
}

export async function persistentWorkstationEnvelope(
	c: Context<AppEnv>,
	state: WorkstationState | null,
	status: WorkstationStatus,
	sessionKind: WorkstationSessionKind,
	input: {
		attemptId?: string | null;
		bindRepositoryAuthority?: boolean;
		preparation?: WorkstationPreparation;
		executionId?: string | null;
		kernelRunId?: string | null;
		participantId?: string | null;
		readiness?: WorkstationBootstrapReadiness;
		session?: WorkstationSessionSelection;
		sessionId?: string | null;
		traceBundleId?: string | null;
		workItemId?: string | null;
	} = {},
): Promise<{
	workstation: Workstation;
	workstationLease: WorkstationLease;
	workstationPersistence: {
		error?: string;
		status: "failed" | "persisted" | "skipped";
	};
}> {
	const envelope = workstationEnvelope(
		c.get("tediConfig"),
		state,
		status,
		sessionKind,
		input,
	);
	if (!c.env.DB) {
		return {
			...envelope,
			workstationPersistence: { status: "skipped" },
		};
	}
	try {
		const persisted = await upsertWorkstationLeaseBundle(
			createDbClient(c.env.DB),
			envelope,
		);
		await persistWorkstationBodyGeneration(
			c,
			persisted.workstationLease.id,
			status,
		);
		const repo = state?.repoSync;
		const preflight = repo ? preparedPreflight({ repoSync: repo }) : null;
		const repositoryPath = (repo ? repoWorkdir(repo) : null)
			?.replace(/^\/home\/tedi\/workstation\/repos\//, "")
			.replace(/^\/workspace\/repos\//, "");
		const rowBundle = await getWorkstationLeaseRowBundle(
			createDbClient(c.env.DB),
			persisted.workstationLease.id,
		);
		if (
			input.bindRepositoryAuthority &&
			preflight?.authoritySource === "fresh_preparation" &&
			rowBundle?.workstationLease.attemptId &&
			rowBundle.workstationLease.orgId &&
			rowBundle.workstationLease.workItemId &&
			rowBundle.workstationLease.bodyGenerationId &&
			repositoryPath &&
			preflight.startSha &&
			repo &&
			repoReady(repo)
		) {
			await getAuthoritativeWorkItemAttempt(createDbClient(c.env.DB), {
				orgId: rowBundle.workstationLease.orgId,
				workItemId: rowBundle.workstationLease.workItemId,
				attemptId: rowBundle.workstationLease.attemptId,
				executor: { type: "tedi", id: c.get("tediConfig").id },
			});
			await bindWorkstationLeaseRepositoryAuthority(createDbClient(c.env.DB), {
				leaseId: persisted.workstationLease.id,
				orgId: rowBundle.workstationLease.orgId,
				workItemId: rowBundle.workstationLease.workItemId,
				attemptId: rowBundle.workstationLease.attemptId,
				generationId: rowBundle.workstationLease.bodyGenerationId,
				repositoryPath,
				repoStartSha: preflight.startSha,
				preparedStartSha: preflight.startSha,
			});
		}
		await persistWorkstationBodyInstance(c, persisted.workstationLease.id);
		return {
			...persisted,
			workstationPersistence: { status: "persisted" },
		};
	} catch (error) {
		const message = errorMessage(error);
		console.warn("[workstation] persistence failed", message);
		return {
			...envelope,
			workstationPersistence: { error: message, status: "failed" },
		};
	}
}

export async function persistWorkstationBodyGeneration(
	c: Context<AppEnv>,
	leaseId: string,
	status: WorkstationStatus,
): Promise<void> {
	const tediConfig = c.get("tediConfig");
	const generation =
		(await c
			.get("runtimeBodyLauncher")
			?.arm({ requireToken: true })
			.catch(() => null)) ?? null;
	const generationId =
		generation?.generationId ?? tediConfig.secrets?.TEDIX_BODY_GENERATION_ID;
	if (!(generationId && generation?.tokenHash)) return;
	if (typeof c.env.DB?.prepare !== "function") return;
	const runtimeSelection = c.get("workstationRuntimeSelection") ?? null;
	const leaseGenerationStatus =
		status === "ready" ? "ready" : status === "blocked" ? "failed" : "starting";
	const now = new Date().toISOString();
	await updateWorkstationLeaseBodyGeneration(createDbClient(c.env.DB), {
		leaseId,
		generationId,
		status: leaseGenerationStatus,
		tokenHash: generation.tokenHash,
		tokenExpiresAt: generation.tokenExpiresAt,
		externalId: runtimeSelection?.workstationId ?? tediConfig.id,
		heartbeatAt: now,
		updatedAt: now,
	});
}

/**
 * Stamp the resolved container body onto the lease.
 *
 * Deliberately separate from `persistWorkstationBodyGeneration`, which returns
 * early whenever a generation credential is absent. Container identity has
 * nothing to do with that credential, and a lease that could not be tied to its
 * instance is exactly the row that later strands a Running container nobody
 * dares stop.
 *
 * Failure is logged, never fatal: losing the join makes a container harder to
 * reap, while failing the request makes the workstation unusable.
 */
export async function persistWorkstationBodyInstance(
	c: Context<AppEnv>,
	leaseId: string,
): Promise<void> {
	const instance = c.get("workstationBodyInstance");
	if (!(instance && c.env.DB)) return;
	try {
		await recordWorkstationLeaseBodyInstance(createDbClient(c.env.DB), {
			instanceId: instance.id,
			instanceName: instance.name,
			leaseId,
			observedAt: new Date().toISOString(),
		});
	} catch (error) {
		console.warn(
			"[workstation] body instance identity not recorded",
			errorMessage(error),
		);
	}
}

export async function markWorkstationBodyStatus(
	c: Context<AppEnv>,
	status: WorkstationStatus,
): Promise<void> {
	const launcherStatus =
		status === "ready" ? "ready" : status === "blocked" ? "failed" : "starting";
	try {
		await c.get("runtimeBodyLauncher")?.status(launcherStatus);
	} catch (error) {
		console.warn(
			"[workstation] body generation status update failed",
			error instanceof Error ? error.message : error,
		);
	}
}
