import type {
	NativeProcess,
	NativeProcessStatus,
	SandboxCommand,
	SandboxExecOptions,
} from "@tedix/container-runtime/sandbox";
import type { CmsJobClient } from "../sandbox";
const PREVIEW_EXEC_TIMEOUT_MS = 2 * 60 * 1000;
export type CmsPreviewExecStatus =
	| "running"
	| "complete"
	| "failed"
	| "timeout"
	| "cancelled";

export interface CmsPreviewExecSnapshot {
	jobId: string;
	status: CmsPreviewExecStatus;
	exitCode: number | null;
	running: boolean;
	command: string;
	startedAt: number | null;
	durationMs: number | null;
	stdoutTail: string;
	stderrTail: string;
	logTail: string;
	message: string;
}

export interface CmsPreviewExecCancelSnapshot extends CmsPreviewExecSnapshot {
	cancelled: boolean;
	previousStatus: string | null;
}

export interface CmsPreviewExecLaunch {
	jobId: string;
	processId: string;
	startedAt: number;
}

export interface CmsPreviewExecOptions {
	command: string;
	jobId?: string;
	timeoutMs?: number;
}

function assertPreviewExecJobId(jobId: string): void {
	if (!/^[a-zA-Z0-9._-]{1,96}$/.test(jobId)) {
		throw new Error(`Invalid CMS preview exec jobId "${jobId}"`);
	}
}

function assertPreviewExecCommand(command: string): string {
	const normalized = command.trim();
	if (!normalized) throw new Error("CMS preview exec command is required");
	if (normalized.length > 4000) {
		throw new Error("CMS preview exec command must be 4000 characters or less");
	}
	return normalized;
}

export async function startCmsPreviewExec(
	sandbox: CmsJobClient,
	options: CmsPreviewExecOptions,
): Promise<CmsPreviewExecLaunch> {
	const jobId = options.jobId ?? `px-${crypto.randomUUID()}`;
	assertPreviewExecJobId(jobId);
	const command = assertPreviewExecCommand(options.command);
	const timeout = Math.min(
		Math.max(options.timeoutMs ?? PREVIEW_EXEC_TIMEOUT_MS, 1000),
		PREVIEW_EXEC_TIMEOUT_MS,
	);
	const process = await startCmsJob(
		sandbox,
		`preview-exec:${jobId}`,
		["bash", "-lc", command],
		{ cwd: "/workspace", timeout },
	);
	return {
		jobId,
		processId: process.id,
		startedAt: cmsProcessStartedAt(await process.status()) ?? Date.now(),
	};
}
export async function readCmsPreviewExecStatus(
	sandbox: CmsJobClient,
	jobId: string,
	options: { command?: string; timeoutMs?: number } = {},
): Promise<CmsPreviewExecSnapshot> {
	assertPreviewExecJobId(jobId);
	const process = await getCmsJob(sandbox, `preview-exec:${jobId}`);
	if (!process)
		return {
			jobId,
			status: "failed",
			exitCode: null,
			running: false,
			command: options.command ?? "",
			startedAt: null,
			durationMs: null,
			stdoutTail: "",
			stderrTail: "",
			logTail: "",
			message: "CMS preview exec process was not found",
		};
	const logs = await readCmsProcessLogs(process);
	const state = await process.status();
	const status = cmsProcessOutcome(state);
	const startedAt = cmsProcessStartedAt(state);
	const tail = (value: string) => value.split("\n").slice(-120).join("\n");
	return {
		jobId,
		status,
		exitCode: cmsProcessExitCode(state),
		running: status === "running",
		command: options.command ?? state.command.join(" "),
		startedAt,
		durationMs: cmsProcessDurationMs(state),
		stdoutTail: tail(logs.stdout),
		stderrTail: tail(logs.stderr),
		logTail: tail([logs.stdout, logs.stderr].filter(Boolean).join("\n")),
		message: `CMS preview exec ${status}`,
	};
}
export async function cancelCmsPreviewExec(
	sandbox: CmsJobClient,
	jobId: string,
): Promise<CmsPreviewExecCancelSnapshot> {
	const before = await readCmsPreviewExecStatus(sandbox, jobId);
	if (!before.running)
		return { ...before, cancelled: false, previousStatus: before.status };
	const process = await getCmsJob(sandbox, `preview-exec:${jobId}`);
	if (!process)
		throw new Error("CMS preview process disappeared during cancellation");
	await process.kill();
	await process.waitForExit({ timeout: 10_000 });
	return {
		...(await readCmsPreviewExecStatus(sandbox, jobId)),
		cancelled: true,
		previousStatus: before.status,
	};
}

export async function startCmsJob(
	sandbox: CmsJobClient,
	key: string,
	command: SandboxCommand,
	options: SandboxExecOptions,
	replaceExited = false,
): Promise<NativeProcess> {
	const id = await sandbox.launchCmsJob(key, command, options, replaceExited);
	const process = await sandbox.getProcess(id);
	if (!process)
		throw new Error(
			`CMS process ${id} is unavailable; launch will not be repeated`,
		);
	return process;
}
export async function getCmsJob(
	sandbox: CmsJobClient,
	key: string,
): Promise<NativeProcess | null> {
	const id = await sandbox.getCmsJobId(key);
	return id ? sandbox.getProcess(id) : null;
}
export function cmsProcessStartedAt(
	status: NativeProcessStatus,
): number | null {
	const value = Date.parse(status.startedAt);
	return Number.isFinite(value) ? value : null;
}
export function cmsProcessDurationMs(
	status: NativeProcessStatus,
): number | null {
	const startedAt = cmsProcessStartedAt(status);
	const endedAt =
		status.state === "running" || status.state === "starting"
			? Date.now()
			: Date.parse(status.endedAt);
	return startedAt === null || !Number.isFinite(endedAt)
		? null
		: Math.max(0, endedAt - startedAt);
}
export function cmsProcessExitCode(status: NativeProcessStatus): number | null {
	return status.state === "exited" ? status.exit.code : null;
}
export function cmsProcessOutcome(
	status: NativeProcessStatus,
): "running" | "complete" | "failed" | "timeout" | "cancelled" {
	if (status.state === "running" || status.state === "starting")
		return "running";
	if (status.state === "error") return "failed";
	if (status.exit.timedOut) return "timeout";
	if (status.exit.signal !== undefined) return "cancelled";
	return status.exit.code === 0 ? "complete" : "failed";
}
/** Read only the currently retained log snapshot; never wait for a live server to exit. */
export async function readCmsProcessLogs(
	process: NativeProcess,
): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
	const result = await process.logSnapshot();
	return result.truncated
		? {
				...result,
				stderr: `${result.stderr}\n[Earlier process output truncated]`,
			}
		: result;
}
