import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import { parseJsonBody, readJobStatus } from "./process-runtime";
import {
	parseProcessId,
	workstationRequestPhases,
	workstationErrorStatus,
	DEFAULT_PROCESS_TAIL_BYTES,
	type WorkstationJobStatus,
} from "./shared";
import {
	readPersistedProcessEvidence,
	workstationProcessArtifactRefs,
	readBoundedR2Text,
	promoteWorkstationJobEvidence,
} from "./process-evidence";
import {
	commandMayPush,
	pushPublicationProof,
} from "../../../workstation/push-publication";
import {
	workstationWait,
	workstationKill,
	workstationExecutionStatus,
} from "../../../workstation/computer-body";
import { errorMessage } from "@tedix/worker-kit/error-message";
import {
	jobObservationDiagnostics,
	workstationProcessAccessForRequest,
	log,
	workstationCancellationAuthority,
} from "./process-access";

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
