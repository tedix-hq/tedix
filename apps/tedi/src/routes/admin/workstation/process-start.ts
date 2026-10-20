import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import {
	workstationRequestPhases,
	parseProcessId,
	workstationErrorStatus,
	workstationPreparation,
	ACTIVE_WORKSTATION_BINDING,
	repoReady,
	assertCheckoutAuthority,
	isRecoverableWorkstationSandboxError,
	type WorkstationJobStatus,
	DEFAULT_PROCESS_TAIL_BYTES,
	clampTimeout,
} from "./shared";
import {
	parseJsonBody,
	workstationSessionSelectionForRequest,
	workstationOperationAuthority,
	applyRequestScopedWorkstationEgressContext,
	workstationCorrelationFromBody,
	readJobStatus,
	processContextFromBody,
	buildJobCommand,
	buildWorkstationProcessEvidence,
} from "./process-runtime";
import {
	commandMayPush,
	scopedArtifactsPublicationRemote,
	workstationCommandWithPushPublication,
} from "../../../workstation/push-publication";
import { workstationOperationLockSelection } from "./locks";
import {
	prepareWorkstationFastSafe,
	scheduleRepoSyncForExecution,
} from "./prepare";
import {
	persistentWorkstationEnvelope,
	markWorkstationBodyStatus,
} from "./envelope";
import { promoteWorkstationJobEvidence } from "./process-evidence";
import { parseCwd, readBootstrapReadiness } from "./bootstrap-readiness";
import { startCheckoutOperation } from "../../../workstation/checkout-lock";
import { errorMessage } from "@tedix/worker-kit/error-message";
import { workstationWaitForPort } from "../../../workstation/computer-body";
import {
	workstationProcessAccessForRequest,
	parseOptionalAsyncTimeout,
	parseWorkstationJobKind,
	DEPENDENCY_GATED_JOB_KINDS,
	admitNativeCheckout,
	scheduleWorkstationEnvelope,
	parsePort,
} from "./process-access";

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
