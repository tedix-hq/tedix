import type { RepositoryInspectionResult } from "@tedix/api-contract/schemas/workstation";
import {
	ProcessWaitTimeoutError,
	type NativeProcess,
	type NativeProcessOutput,
	type SandboxCommand,
	type SandboxExecOptions,
} from "@tedix/container-runtime/sandbox";
import type { DirectoryBackupRecord } from "@cloudflare/sandbox";

export type WorkstationRepositoryInspectionRequest = {
	operation: "status" | "diff" | "read";
	repositoryPath: string;
	baselineSha: string;
	path?: string;
};

export interface WorkstationExecutionMetadata {
	command: string;
	cwd: string;
	context: Record<string, unknown>;
	timeoutMs: number | null;
}
export type WorkstationLaunchResult = {
	metadata?: WorkstationExecutionMetadata;
} & (
	| { state: "started"; executionId: string; nativeId: string }
	| {
			state: "terminal";
			executionId: string;
			nativeId: string;
			exitCode: number | null;
			startedAt?: string;
			endedAt?: string;
			timedOut?: boolean;
			signal?: number;
			error?: string;
	  }
	| { state: "unknown"; executionId: string; observation: "unavailable" }
);
export interface WorkstationLaunchRequest {
	executionId: string;
	argv: readonly [string, ...string[]];
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	metadata?: WorkstationExecutionMetadata;
}
export type WorkstationRuntimeBody = {
	exec(
		command: SandboxCommand,
		options?: SandboxExecOptions,
	): Promise<NativeProcess>;
	getProcess(id: string): Promise<NativeProcess | null>;
	writeFile(path: string, content: string): Promise<{ success: true }>;
	readFile(
		path: string,
		options?: { encoding?: "utf8" | "none" },
	): Promise<{ success: true; content: string | Uint8Array }>;
	mkdir(
		path: string,
		options?: { recursive?: boolean },
	): Promise<{ success: true }>;
	deleteFile(path: string): Promise<{ success: true }>;
	containerFetch(
		input: Request | string,
		init?: RequestInit | number,
		port?: number,
	): Promise<Response>;
	setOutboundPolicy(params: unknown): Promise<void>;
	snapshotForResume(): Promise<
		| { status: "saved"; snapshotId: string; expiresAt: string }
		| { status: "not_running" | "missing_fence" }
	>;
	pathExists(path: string): Promise<boolean>;
	renamePath(from: string, to: string): Promise<void>;
	destroy(): Promise<void>;
	createBackup(input: {
		dir: string;
		name?: string;
		excludes?: string[];
	}): Promise<DirectoryBackupRecord>;
	restoreBackup(
		input: DirectoryBackupRecord & { dir?: string },
	): Promise<{ success: true }>;
	launchExecution(
		request: WorkstationLaunchRequest,
	): Promise<WorkstationLaunchResult>;
	readExecutionAssociation(
		executionId: string,
	): Promise<WorkstationLaunchResult | null>;
	isRuntimeActive(): Promise<boolean>;
	getWorkstationIdentity(): Promise<string>;
	inspectRepository(
		request: WorkstationRepositoryInspectionRequest,
	): Promise<RepositoryInspectionResult>;
};
export interface WorkstationRuntimeNamespace {
	getByName(name: string): WorkstationRuntimeBody;
	idFromName(name: string): DurableObjectId;
}
export type WorkstationExecResult = NativeProcessOutput;
export interface WorkstationExecutionStatus {
	observation: "running" | "terminal" | "not_found" | "unavailable";
	found: boolean;
	running: boolean;
	terminal: boolean;
	exitCode: number | null;
	startedAt?: string;
	endedAt?: string;
	timedOut?: boolean;
	signal?: number;
	stdout?: string;
	stderr?: string;
	truncated?: boolean;
	error?: string;
}
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export class WorkstationDispatchUnknownError extends Error {
	readonly observation = "unavailable";
	constructor(readonly executionId: string) {
		super(
			`Launch outcome is unknown for execution ${executionId}; do not repeat it`,
		);
		this.name = "WorkstationDispatchUnknownError";
	}
}
export class WorkstationObservationTimeoutError extends Error {
	constructor(
		readonly timeoutMs: number,
		readonly operation: string,
	) {
		super(
			`Workstation ${operation} observation did not answer within ${timeoutMs}ms`,
		);
		this.name = "WorkstationObservationTimeoutError";
	}
}
/** Observation deadlines never cancel the remote process or authorize a replay. */
export async function withWorkstationObservationDeadline<T>(
	operation: () => Promise<T>,
	input: { timeoutMs?: number; operation: string },
): Promise<T> {
	if (!input.timeoutMs || input.timeoutMs <= 0) return operation();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new WorkstationObservationTimeoutError(
								input.timeoutMs!,
								input.operation,
							),
						),
					input.timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
export async function workstationStart(
	body: WorkstationRuntimeBody,
	command: string,
	options: {
		processId: string;
		timeout?: number;
		cwd?: string;
		metadata?: WorkstationExecutionMetadata;
	},
) {
	const result = await body.launchExecution({
		executionId: options.processId,
		argv: ["/bin/bash", "-lc", command],
		cwd: options.cwd,
		timeout: options.timeout,
		metadata: options.metadata,
	});
	if (result.state === "unknown")
		throw new WorkstationDispatchUnknownError(options.processId);
	return { id: options.processId, nativeId: result.nativeId };
}
export async function workstationProcess(
	body: WorkstationRuntimeBody,
	executionId: string,
): Promise<NativeProcess | null> {
	const association = await body.readExecutionAssociation(executionId);
	return association?.state === "started" || association?.state === "terminal"
		? body.getProcess(association.nativeId)
		: null;
}
export async function workstationExec(
	body: WorkstationRuntimeBody,
	command: string,
	options: {
		cwd?: string;
		timeout?: number;
		executionId?: string;
		maxBytes?: number;
	} = {},
): Promise<WorkstationExecResult> {
	const executionId = options.executionId ?? crypto.randomUUID();
	await workstationStart(body, command, {
		processId: executionId,
		cwd: options.cwd,
		timeout: options.timeout,
	});
	const process = await workstationProcess(body, executionId);
	if (!process) throw new WorkstationDispatchUnknownError(executionId);
	return process.output({
		encoding: "utf8",
		maxBytes: options.maxBytes ?? MAX_OUTPUT_BYTES,
		timeout: options.timeout,
	});
}
export async function workstationWriteFile(
	body: WorkstationRuntimeBody,
	path: string,
	content: string,
): Promise<void> {
	await body.writeFile(path, content);
}

export function inspectWorkstationRepository(
	body: WorkstationRuntimeBody,
	request: WorkstationRepositoryInspectionRequest,
) {
	return body.inspectRepository(request);
}
function unavailable(): WorkstationExecutionStatus {
	return {
		observation: "unavailable",
		found: false,
		running: false,
		terminal: false,
		exitCode: null,
	};
}
export async function workstationExecutionStatus(
	body: WorkstationRuntimeBody,
	executionId: string,
	options: { includeLogs?: boolean } = {},
): Promise<WorkstationExecutionStatus> {
	try {
		const association = await body.readExecutionAssociation(executionId);
		if (!association) return { ...unavailable(), observation: "not_found" };
		if (association.state === "terminal") {
			let outputError: string | undefined;
			const process =
				options.includeLogs === false
					? null
					: await body.getProcess(association.nativeId).catch(() => null);
			const output = process
				? await process
						.output({
							encoding: "utf8",
							maxBytes: MAX_OUTPUT_BYTES,
							timeout: 10_000,
						})
						.catch(() => {
							outputError = "Native execution logs unavailable";
							return undefined;
						})
				: undefined;
			return {
				observation: "terminal",
				found: true,
				running: false,
				terminal: true,
				exitCode: association.exitCode,
				startedAt: association.startedAt,
				endedAt: association.endedAt,
				timedOut: association.timedOut,
				signal: association.signal,
				error: association.error ?? outputError,
				...(output
					? {
							stdout: output.stdout,
							stderr: output.stderr,
							truncated: output.truncated,
						}
					: {}),
			};
		}
		const process =
			association.state === "started"
				? await body.getProcess(association.nativeId)
				: null;
		if (!process) return unavailable();
		const status = await process.status();
		if (status.state === "running" || status.state === "starting")
			return {
				observation: "running",
				found: true,
				running: true,
				terminal: false,
				exitCode: null,
				startedAt: status.startedAt,
			};
		if (status.state === "error")
			return {
				observation: "terminal",
				found: true,
				running: false,
				terminal: true,
				exitCode: null,
				startedAt: status.startedAt,
				endedAt: status.endedAt,
				error: status.error.message,
			};
		if (status.state !== "exited") return unavailable();
		let outputError: string | undefined;
		const output =
			options.includeLogs === false
				? undefined
				: await process
						.output({
							encoding: "utf8",
							maxBytes: MAX_OUTPUT_BYTES,
							timeout: 10_000,
						})
						.catch(() => {
							outputError = "Native execution logs unavailable";
							return undefined;
						});
		return {
			observation: "terminal",
			found: true,
			running: false,
			terminal: true,
			exitCode: status.exit.code,
			startedAt: status.startedAt,
			endedAt: status.endedAt,
			timedOut: status.exit.timedOut,
			signal: status.exit.signal,
			...(outputError ? { error: outputError } : {}),
			...(output
				? {
						stdout: output.stdout,
						stderr: output.stderr,
						truncated: output.truncated,
					}
				: {}),
		};
	} catch {
		return unavailable();
	}
}
export async function workstationWait(
	body: WorkstationRuntimeBody,
	executionId: string,
	timeoutMs: number,
): Promise<{ terminal: boolean; observation: "terminal" | "unavailable" }> {
	try {
		return await withWorkstationObservationDeadline(
			async () => {
				const process = await workstationProcess(body, executionId);
				if (!process)
					return { terminal: false, observation: "unavailable" } as const;
				await process.waitForExit({ timeout: timeoutMs });
				return { terminal: true, observation: "terminal" } as const;
			},
			{ timeoutMs, operation: "wait" },
		);
	} catch {
		return { terminal: false, observation: "unavailable" };
	}
}
export async function workstationKill(
	body: WorkstationRuntimeBody,
	executionId: string,
): Promise<void> {
	const process = await workstationProcess(body, executionId);
	if (!process) throw new WorkstationDispatchUnknownError(executionId);
	await process.kill(15);
	try {
		await process.waitForExit({ timeout: 5_000 });
	} catch (error) {
		if (!(error instanceof ProcessWaitTimeoutError)) throw error;
		await process.kill(9);
		await process.waitForExit({ timeout: 5_000 });
	}
}
export async function workstationWaitForPort(
	body: WorkstationRuntimeBody,
	port: number,
	options: { timeout?: number } = {},
): Promise<void> {
	const deadline = Date.now() + (options.timeout ?? 60_000);
	while (Date.now() < deadline) {
		try {
			const response = await body.containerFetch(
				new Request("http://container/", {
					method: "HEAD",
					signal: AbortSignal.timeout(
						Math.max(1, Math.min(1_000, deadline - Date.now())),
					),
				}),
				port,
			);
			await response.body?.cancel();
			if (response.status < 500) return;
		} catch {
			/* The existing server may still be starting. */
		}
		await new Promise((resolve) =>
			setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now()))),
		);
	}
	throw new WorkstationObservationTimeoutError(
		options.timeout ?? 60_000,
		"port readiness",
	);
}

/** DO binding shape; the public client wraps native process descriptors into handles. */
export type WorkstationRuntimeDO = WorkstationRuntimeBody;
