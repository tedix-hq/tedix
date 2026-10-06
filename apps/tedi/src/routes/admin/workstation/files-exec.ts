import { startCheckoutOperation } from "../../../workstation/checkout-lock";
import {
	commandMayPush,
	pushPublicationProof,
	scopedArtifactsPublicationRemote,
	workstationCommandWithPushPublication,
} from "../../../workstation/push-publication";
import type { Context } from "hono";
import type { AppEnv, TediConfig } from "../../../types";
import {
	WorkstationDispatchUnknownError,
	type WorkstationExecResult,
} from "../../../workstation/computer-body";
import { workstationFiles } from "../../../workstation/files";
import {
	persistWorkstationRecoveryCheckpoint,
	type WorkstationRecoveryCheckpointResult,
} from "../../../workstation/recovery-checkpoint";
import type { RepoSyncResult } from "../../../workstation/repo-sync";
import {
	ACTIVE_WORKSTATION_BINDING,
	workstationPreparation,
	type WorkstationSessionSelection,
	workstationErrorStatus,
	assertCheckoutAuthority,
	execCheckoutOperation,
	isRecoverableWorkstationSandboxError,
	clampTimeout,
	shellSingleQuote,
	workstationOperationLockedInvocation,
	workstationOperationLockSelection,
	repoReady,
	repoWorkdir,
	readBootstrapReadiness,
	workstationStatusForReadiness,
	parseCwd,
	applyRequestScopedWorkstationEgressContext,
	parseJsonBody,
	workstationSessionSelectionForRequest,
	workstationOperationAuthority,
	stringBodyValue,
	workstationCorrelationFromBody,
	workstationRecoveryCheckpointKeys,
	recoveryCheckpointOperation,
	restoreRecoveryCheckpoint,
	prepareWorkstationFastSafe,
	persistentWorkstationEnvelope,
	markWorkstationBodyStatus,
	scheduleRepoSyncForExecution,
} from "./shared";
import { errorMessage } from "@tedix/worker-kit/error-message";

const workstationSessionQueues = new Map<string, Promise<void>>();

function workstationSessionQueueKey(
	_tediConfig: TediConfig,
	session: WorkstationSessionSelection,
): string {
	return `${session.leaseId}:${session.sessionId}`;
}

async function withWorkstationSessionQueue<T>(
	tediConfig: TediConfig,
	session: WorkstationSessionSelection,
	run: () => Promise<T>,
): Promise<T> {
	const key = workstationSessionQueueKey(tediConfig, session);
	const previous = workstationSessionQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const next = previous
		.catch(() => undefined)
		.then(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
	workstationSessionQueues.set(key, next);
	await previous.catch(() => undefined);
	try {
		return await run();
	} finally {
		release();
		if (workstationSessionQueues.get(key) === next) {
			workstationSessionQueues.delete(key);
		}
	}
}

const WORKSTATION_BRANCH_PUSH_TIMEOUT_MS = 90_000;

/** Parse an execution-boundary policy refusal from retained output. */
export function pushGuardViolation(stdout: string | undefined): string | null {
	return (
		stdout?.match(/(?:^|\n)TEDIX_PUSH_GUARD=([a-z_]+)(?:\n|$)/)?.[1] ?? null
	);
}

async function persistRecoveryCheckpoint(
	c: Context<AppEnv>,
	repoSync: RepoSyncResult,
	reason: string,
): Promise<WorkstationRecoveryCheckpointResult> {
	const workdir = repoWorkdir(repoSync);
	if (!workdir || !repoReady(repoSync)) return { status: "missing" };
	return recoveryCheckpointOperation(
		c,
		workdir,
		repoSync.configured ? repoSync.treePreflight : undefined,
		(input) =>
			persistWorkstationRecoveryCheckpoint({
				...input,
				...workstationRecoveryCheckpointKeys(c),
				reason,
				storage: c.env.TEDI_STORAGE ?? null,
				workdir,
			}),
	);
}

export async function writeWorkstationFiles(c: Context<AppEnv>) {
	const body = await parseJsonBody(c);
	if (!body || !stringBodyValue(body, "leaseId"))
		return c.json({ ok: false, error: "leaseId is required" }, 400);
	const selected = await workstationSessionSelectionForRequest(
		c,
		body,
		"shell",
	);
	if (!selected.ok)
		return c.json(
			{ ok: false, error: selected.error },
			workstationErrorStatus(selected.status),
		);
	try {
		const result = await withWorkstationSessionQueue(
			c.get("tediConfig"),
			selected.session,
			() =>
				workstationFiles(body, c.get("sandbox"), (argv) =>
					startCheckoutOperation(c.get("sandbox"), {
						command: argv.map(shellSingleQuote).join(" "),
						mode: "shared",
						timeout: 60_000,
						authorize: () => assertCheckoutAuthority(c),
					}),
				),
		);
		return c.json(result);
	} catch (error) {
		return c.json({ ok: false, error: errorMessage(error) }, 400);
	}
}

export async function execWorkstationCommand(c: Context<AppEnv>) {
	const body = await parseJsonBody(c);
	if (!body) return c.json({ ok: false, error: "Invalid JSON body" }, 400);
	const command = typeof body.command === "string" ? body.command.trim() : "";
	if (!command) return c.json({ ok: false, error: "command is required" }, 400);
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

	const selectedSession = await workstationSessionSelectionForRequest(
		c,
		body,
		"shell",
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
				error: operationAuthority.error,
				...operationAuthority.escalation,
			},
			403,
		);
	}

	let state = await prepareWorkstationFastSafe(
		c,
		workstationPreparation(session),
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
			bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
			error: state.setupError,
			repoSync: state.repoSync,
			sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
			setupError: state.setupError,
			tools: state.tools,
			...envelope,
		});
	}
	scheduleRepoSyncForExecution(c, state);
	let recoveryCheckpoint = await restoreRecoveryCheckpoint(c, state.repoSync);
	if (recoveryCheckpoint.status === "failed") {
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
			error: `workstation recovery checkpoint could not be restored: ${recoveryCheckpoint.error ?? "unknown error"}`,
			recoveryCheckpoint,
			repoSync: state.repoSync,
			sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
			...envelope,
		});
	}
	await applyRequestScopedWorkstationEgressContext(c, body, session);
	let cwd = parseCwd(body.cwd, state.repoSync);
	const timeout = hasGitPush
		? clampTimeout(
				body.timeoutMs,
				WORKSTATION_BRANCH_PUSH_TIMEOUT_MS,
				WORKSTATION_BRANCH_PUSH_TIMEOUT_MS,
			)
		: clampTimeout(body.timeoutMs, 120_000, 600_000);
	const pushSafetyBypassReason =
		typeof body.pushSafetyBypassReason === "string" &&
		body.pushSafetyBypassReason.trim()
			? body.pushSafetyBypassReason.trim()
			: null;
	const protectedPathExemptRemote = scopedArtifactsPublicationRemote({
		preparation: workstationPreparation(session),
		workItemId: session.leaseBundle?.workstationLease.workItemId,
		attemptId: session.leaseBundle?.workstationLease.attemptId,
		repository: c.get("tediConfig").workstationEgress?.artifactsRepository,
	});
	const pushCommand = await workstationCommandWithPushPublication(command, {
		allowPush: hasGitPush,
		bypassReason: pushSafetyBypassReason,
		protectedPathExemptRemote,
	});
	const executionCommand = operationLock
		? workstationOperationLockedInvocation(
				operationLock.kind,
				`bash -lc ${shellSingleQuote(pushCommand)}`,
			)
		: pushCommand;
	let result: WorkstationExecResult | null = null;
	try {
		result = await withWorkstationSessionQueue(
			c.get("tediConfig"),
			session,
			() =>
				execCheckoutOperation(c, executionCommand, { cwd, timeout }, "shared"),
		);
	} catch (err) {
		const launchError = err;
		if (!result) {
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
				bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
				error,
				...(launchError instanceof WorkstationDispatchUnknownError
					? { executionId: launchError.executionId, observation: "unknown" }
					: {}),
				repoSync: state.repoSync,
				sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
				...envelope,
			});
		}
	}
	const publicationProof = hasGitPush
		? pushPublicationProof(result.stdout)
		: null;
	const publicationVerified =
		!publicationProof ||
		["not_applicable", "pushed", "unchanged", "dry_run"].includes(
			publicationProof.status,
		);
	const executionSucceeded =
		result.exitCode === 0 && !result.timedOut && publicationVerified;
	if (executionSucceeded) {
		recoveryCheckpoint = await persistRecoveryCheckpoint(
			c,
			state.repoSync,
			"after-successful-workstation-exec",
		);
	}
	const bootstrap = await readBootstrapReadiness(c, state, body, session);
	const status = executionSucceeded
		? workstationStatusForReadiness(state, bootstrap)
		: "blocked";
	const envelope = await persistentWorkstationEnvelope(
		c,
		state,
		status,
		session.sessionKind,
		{
			...workstationCorrelationFromBody(body),
			participantId: session.participantId,
			readiness: bootstrap,
			session,
			sessionId: session.sessionId,
		},
	);
	await markWorkstationBodyStatus(c, status);

	return c.json({
		ok: executionSucceeded,
		ready: executionSucceeded && bootstrap.environmentReady,
		bootstrap,
		readiness: bootstrap.dimensions,
		command,
		bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
		exitCode: result.exitCode,
		leaseId: session.leaseId,
		operationLock: operationLock?.kind ?? null,
		operationLockSource: operationLock?.source ?? null,
		publicationProof,
		pushSafety: hasGitPush
			? {
					guardViolation: pushGuardViolation(result.stdout),
					bypassed: pushSafetyBypassReason !== null,
					...(pushSafetyBypassReason
						? { bypassReason: pushSafetyBypassReason }
						: {}),
				}
			: null,
		participantId: session.participantId,
		participantTediId: session.participantTediId,
		recoveryCheckpoint,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		sessionId: session.sessionId,
		sessionKind: session.sessionKind,
		workstationId: session.workstationId,
		repoSync: state.repoSync,
		sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
		...envelope,
	});
}
