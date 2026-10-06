import { createWorkstationLease } from "@tedix/api-contract/schemas/workstation";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
	symlinkSync,
	realpathSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProtectedWorkstationPushPath } from "../../workstation/push-publication";
import {} from "@tedix/api-contract/schemas/workstation";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppEnv } from "../../types";
import type {
	WorkstationRuntimeBody,
	WorkstationLaunchResult,
} from "../../workstation/computer-body";
import type { NativeProcessStatus as ProcessStatus } from "@tedix/container-runtime/sandbox";
import { CheckoutAdmissionPendingError } from "../../workstation/checkout-lock";
import { WorkstationDispatchUnknownError } from "../../workstation/computer-body";
import {
	persistWorkstationRecoveryCheckpoint,
	restoreWorkstationRecoveryCheckpoint,
} from "../../workstation/recovery-checkpoint";
const processMocks = vi.hoisted(() => ({
	ensureCleanRepoTreeForTurn: vi.fn(),
	readRepoSyncStatus: vi.fn(),
	syncRepoIfConfigured: vi.fn(),
}));

const githubCredentialMocks = vi.hoisted(() => ({
	hydrateGitHubCliCredentials: vi.fn(),
	hydrateGitIdentity: vi.fn(async () => ({
		email: "cto@tedix.tech",
		name: "CTO",
	})),
	probeGitHubCliCredentials: vi.fn(
		async (): Promise<{ status: string; httpStatus?: number }> => ({
			status: "valid",
		}),
	),
}));

const sandboxDestroyMocks = vi.hoisted(() => ({
	destroySandboxWithTimeout: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
	createDbClient: vi.fn(() => "db-client"),
	getWorkstationLeaseBundle: vi.fn(),
	upsertWorkstationLeaseBundle: vi.fn(
		async (_db: unknown, bundle: unknown) => bundle,
	),
	joinWorkstationLease: vi.fn(),
	releaseWorkstationLease: vi.fn(),
}));
const authorityMocks = vi.hoisted(() => ({
	bindWorkstationLeaseRepositoryAuthority: vi.fn(),
	getAuthoritativeWorkItemAttempt: vi.fn(),
	getWorkstationLeaseRowBundle: vi.fn(),
	recordWorkstationLeaseBodyInstance: vi.fn(),
	updateWorkstationLeaseBodyGeneration: vi.fn(),
}));

vi.mock("@cloudflare/sandbox", () => ({
	ProcessWaitTimeoutError: class extends Error {},
}));
vi.mock("cloudflare:workers", () => ({
	DurableObject: class {},
	RpcTarget: class {},
	tracing: { enterSpan: vi.fn((_name: string, run: () => unknown) => run()) },
}));
vi.mock("../../workstation/repo-sync", () => processMocks);
vi.mock("../../workstation/github-credentials", () => githubCredentialMocks);
vi.mock("../../workstation/sandbox-destroy", () => sandboxDestroyMocks);
vi.mock("@tedix/db/client", () => ({
	createDbClient: dbMocks.createDbClient,
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	getAuthoritativeWorkItemAttempt:
		authorityMocks.getAuthoritativeWorkItemAttempt,
}));
vi.mock("@tedix/db/queries/workstations", () => ({
	bindWorkstationLeaseRepositoryAuthority:
		authorityMocks.bindWorkstationLeaseRepositoryAuthority,
	getWorkstationLeaseBundle: authorityMocks.getWorkstationLeaseRowBundle,
	recordWorkstationLeaseBodyInstance:
		authorityMocks.recordWorkstationLeaseBodyInstance,
	updateWorkstationLeaseBodyGeneration:
		authorityMocks.updateWorkstationLeaseBodyGeneration,
}));
vi.mock("../../workstation/persistence", () => ({
	getWorkstationLeaseBundle: dbMocks.getWorkstationLeaseBundle,
	upsertWorkstationLeaseBundle: dbMocks.upsertWorkstationLeaseBundle,
	joinWorkstationLease: dbMocks.joinWorkstationLease,
	releaseWorkstationLease: dbMocks.releaseWorkstationLease,
}));

import {
	bootstrapInstallInFlight,
	bootstrapProbeCommand,
	verifiedInstallCommandForLockfile,
	bootstrapInstallLaunchFailedAt,
	probeTool,
	repoSyncInFlight,
	isWorkstationRequest,
	resolveWorkstationArtifactScopeRunId,
	workstationSourceArtifactRefs,
	WORKSTATION_HEADER,
	withWorkstationCommitProvenance,
	checkpointNative,
	stageWorkstationSpool,
	unpreparedCheckoutProbeCommand,
	restorePreparedBaseCommand,
	ensureWorkstationEgressGuard,
} from "./workstation/shared";
import { pushGuardViolation } from "./workstation/files-exec";
import { workstation } from "./workstation/router";
describe("probeTool", () => {
	const execOk = (stdout: string) =>
		vi.fn().mockResolvedValue({ exitCode: 0, stdout, stderr: "" });

	it("omits version entirely when stdout is empty", async () => {
		// A `version: undefined` property is not JSON, so persisting it fails
		// metadata.tools schema validation and 500s the wake route.
		const probe = await probeTool(execOk(""), "gh --version");
		expect(probe).toEqual({ ok: true });
		expect("version" in probe).toBe(false);
		expect(JSON.parse(JSON.stringify(probe))).toEqual(probe);
	});

	it("omits version when stdout is only whitespace", async () => {
		const probe = await probeTool(execOk("  \n \n"), "gh --version");
		expect("version" in probe).toBe(false);
	});

	it("keeps only the first line of a multi-line version banner", async () => {
		const probe = await probeTool(
			execOk("gh version 2.62.0 (2026-08-01)\nhttps://github.com/cli/cli\n"),
			"gh --version",
		);
		expect(probe).toEqual({
			ok: true,
			version: "gh version 2.62.0 (2026-08-01)",
		});
	});

	it("reports not-ok with the stderr reason on a non-zero exit", async () => {
		const exec = vi.fn().mockResolvedValue({
			exitCode: 127,
			stdout: "",
			stderr: "gh: command not found\n",
		});
		const probe = await probeTool(exec, "gh --version");
		expect(probe).toEqual({ ok: false, error: "gh: command not found" });
	});
});

const workdir = "/home/tedi/workstation/repos/tedix/tedix";
const completeOutput = {
	exitCode: 0,
	stdout: "",
	stderr: "",
	timedOut: false,
	truncated: false,
};
const bytes = (text: string) => new TextEncoder().encode(text);
function nativeFixture(
	tediConfigOverrides: Partial<AppEnv["Variables"]["tediConfig"]> = {},
) {
	let currentCommand = "";
	let readiness =
		"packageJson=0\nnodeModules=0\nlockfile=\nlockfileHash=\ndepsReady=0\n";
	const associations = new Map<string, WorkstationLaunchResult>();
	const processes = new Map<string, typeof handle>();
	let state: ProcessStatus = {
		id: "native-1",
		pid: 123,
		command: ["bash", "-lc", "true"],
		startedAt: new Date().toISOString(),
		state: "running",
	};
	const handle = {
		id: "native-1",
		pid: 123,
		exitCode: Promise.resolve(0),
		status: vi.fn(async () => state),
		output: vi.fn(async () => ({
			...completeOutput,
			stdout: currentCommand.includes("packageJson=")
				? readiness
				: currentCommand.includes("rev-parse HEAD")
					? "a".repeat(40)
					: "ready",
		})),
		waitForLog: vi.fn(async () => ({
			stream: "stdout",
			text: "TEDIX_CHECKOUT_LOCK_ACQUIRED",
			match: "TEDIX_CHECKOUT_LOCK_ACQUIRED",
		})),
		waitForExit: vi.fn(async () => {
			if (state.state === "running")
				state = {
					...state,
					state: "exited",
					endedAt: "2026-09-20T00:00:01Z",
					exit: { code: 0, timedOut: false },
				};
			return state.state === "exited"
				? state.exit
				: { code: 1, timedOut: false };
		}),
		kill: vi.fn(async () => undefined),
	};
	const raw = {
		exec: vi.fn(async (argv: readonly string[]) => ({
			...handle,
			status: vi.fn(async (): Promise<ProcessStatus> => ({
				...state,
				state: "running",
			})),
			waitForExit: vi.fn(async () => ({ code: 0, timedOut: false })),
			output: vi.fn(async () => ({
				...completeOutput,
				stdout: argv.join(" ").includes("packageJson=")
					? "packageJson=0\nnodeModules=0\nlockfile=\nlockfileHash=\ndepsReady=0\n"
					: argv.join(" ").includes("rev-parse HEAD")
						? "a".repeat(40)
						: "ready",
			})),
		})),
		listProcesses: vi.fn(async (): Promise<ProcessStatus[]> => []),
		getProcess: vi.fn(async (id?: string) => processes.get(id ?? "") ?? handle),
		readExecutionAssociation: vi.fn(
			async (id: string) => associations.get(id) ?? null,
		),
		launchExecution: vi.fn(
			async (request: {
				executionId: string;
				argv?: readonly string[];
				metadata?: WorkstationLaunchResult["metadata"];
			}) => {
				currentCommand = request.argv?.join(" ") ?? "";
				const nativeId = currentCommand.includes("/tmp/tedix-checkout-")
					? `native-${request.executionId}`
					: "native-1";
				if (nativeId !== "native-1")
					processes.set(
						nativeId,
						(await raw.exec(request.argv ?? [])) as typeof handle,
					);
				const result: WorkstationLaunchResult = {
					state: "started",
					executionId: request.executionId,
					nativeId,
					metadata: request.metadata,
				};
				associations.set(request.executionId, result);
				return result;
			},
		),
		readFile: vi.fn(async (path: string) => ({
			size: new TextEncoder().encode(
				path.endsWith("stdout.log")
					? "root and descendant output\n"
					: "error output\n",
			).byteLength,
			content: bytes(
				path.endsWith("stdout.log")
					? "root and descendant output\n"
					: "error output\n",
			),
		})),
		writeFile: vi.fn(async (_path: string, _content?: unknown) => ({
			success: true,
		})),
		deleteFile: vi.fn(async () => ({ success: true })),
		renamePath: vi.fn(async () => ({ success: true })),
		pathExists: vi.fn(async () => ({ pathExists: true })),
		setOutboundPolicy: vi.fn(async () => undefined),
		snapshotForResume: vi.fn(async () => ({
			status: "saved" as const,
			snapshotId: "native-snapshot",
			expiresAt: "2026-10-30T00:00:00.000Z",
		})),
		destroy: vi.fn(async () => undefined),
		containerFetch: vi.fn(async () => new Response("", { status: 200 })),
		restoreBackup: vi.fn(async () => ({ success: true })),
	};
	const body = raw as unknown as WorkstationRuntimeBody;
	const storage = {
		get: vi.fn(async (_key: string): Promise<unknown> => null),
		put: vi.fn(
			async (
				_key: string,
				value: unknown,
				_options?: { onlyIf?: { etagDoesNotMatch?: string } },
			): Promise<{ etag: string } | null> => {
				if (value instanceof ReadableStream) {
					if (!knownLengthStreams.has(value))
						throw new Error("Stream must have a known length");
					await new Response(value).arrayBuffer();
				}
				return { etag: "etag" };
			},
		),
		delete: vi.fn(),
		list: vi.fn(async () => ({ objects: [] })),
	};
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("sandbox", body);
		c.set("runtimeBodyLauncher", null);
		c.set("tediConfig", {
			id: "tedi-1",
			organizationId: "org_tedix",
			slug: "cto",
			secrets: {},
			...tediConfigOverrides,
		} as AppEnv["Variables"]["tediConfig"]);
		c.set("workstationRuntimeSelection", {
			leaseId: "test-lease",
			workstationId: "test-computer",
			participantTediId: "tedi-1",
		});
		await next();
	});
	app.route("/workstation", workstation);
	const env = {
		TEDI_STORAGE: storage,
		ENVIRONMENT: "production",
	} as unknown as AppEnv["Bindings"];
	const request = async (
		path: string,
		input: Record<string, unknown>,
		headers: Record<string, string> = {},
	) => {
		const response = await app.request(
			`https://tedi/workstation/${path}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: JSON.stringify(input),
			},
			env,
		);
		return { status: response.status, body: (await response.json()) as any };
	};
	const add = (id = "job", context: Record<string, unknown> = {}) =>
		associations.set(id, {
			state: "started",
			executionId: id,
			nativeId: "native-1",
			metadata: {
				command: "echo test",
				cwd: workdir,
				timeoutMs: 5000,
				context,
			},
		});
	return {
		body,
		app,
		env,
		setReadiness: (value: string) => {
			readiness = value;
		},
		raw,
		handle,
		storage,
		request,
		add,
		associations,
		setState: (next: ProcessStatus) => {
			state = next;
		},
		finish: (exit = { code: 0, timedOut: false }) => {
			state = {
				...state,
				state: "exited",
				endedAt: "2026-09-20T00:00:01Z",
				exit,
			};
		},
	};
}
const knownLengthStreams = new WeakSet<ReadableStream>();
beforeEach(() => {
	vi.stubGlobal(
		"FixedLengthStream",
		class extends TransformStream<Uint8Array, Uint8Array> {
			constructor(expected: number) {
				let seen = 0;
				super({
					transform(chunk, controller) {
						seen += chunk.byteLength;
						if (seen > expected) throw new Error("length mismatch");
						controller.enqueue(chunk);
					},
					flush() {
						if (seen !== expected) throw new Error("length mismatch");
					},
				});
				knownLengthStreams.add(this.readable);
			}
		},
	);
	vi.clearAllMocks();
	sandboxDestroyMocks.destroySandboxWithTimeout.mockResolvedValue({
		completed: true,
		timedOut: false,
	});
	dbMocks.getWorkstationLeaseBundle.mockResolvedValue(null);
	authorityMocks.bindWorkstationLeaseRepositoryAuthority.mockImplementation(
		async (_db, input) => input,
	);
	authorityMocks.getAuthoritativeWorkItemAttempt.mockResolvedValue({
		id: "attempt-1",
	});
	authorityMocks.getWorkstationLeaseRowBundle.mockResolvedValue(null);
	authorityMocks.recordWorkstationLeaseBodyInstance.mockResolvedValue(
		undefined,
	);
	authorityMocks.updateWorkstationLeaseBodyGeneration.mockResolvedValue(
		undefined,
	);
	processMocks.readRepoSyncStatus.mockResolvedValue({
		configured: true,
		status: "updated",
		branch: "main",
		workdir,
		repoUrl: "https://github.com/tedix/tedix.git",
		treePreflight: { startSha: "a".repeat(40), turnKey: "turn" },
	});
	processMocks.ensureCleanRepoTreeForTurn.mockResolvedValue({
		at: "2026-09-20T00:00:00Z",
		outcome: "clean",
		startSha: "a".repeat(40),
		turnKey: "turn",
		branch: "main",
		workdir,
	});
	githubCredentialMocks.hydrateGitHubCliCredentials.mockResolvedValue({
		configured: true,
		status: "brokered",
	});
	repoSyncInFlight.clear();
	bootstrapInstallInFlight.clear();
	bootstrapInstallLaunchFailedAt.clear();
});

describe("native spool upload", () => {
	it("uploads exact buffered binary bytes", async () => {
		const data = new Uint8Array([0, 255, 128, 13, 10]);
		const body = {
			readFile: vi.fn(async () => ({ content: data, size: data.byteLength })),
		} as unknown as WorkstationRuntimeBody;
		const put = vi.fn(async () => undefined);
		await stageWorkstationSpool(
			body,
			{ put } as unknown as R2Bucket,
			"/spool",
			"key",
		);
		expect(put).toHaveBeenCalledWith("key", data, expect.anything());
	});
});

describe("native process lifecycle and artifacts", () => {
	it("returns missing separately from an unknown native observation", async () => {
		const f = nativeFixture();
		const missing = await f.request("process/status", { processId: "absent" });
		expect(missing.body.found).toBe(false);
		f.add();
		f.raw.getProcess.mockRejectedValue(new Error("stale incarnation"));
		const stale = await f.request("process/status", { processId: "job" });
		expect(stale.body.job.observation).toBe("unavailable");
		expect(stale.body.job.running).toBe(false);
		expect(stale.body.job.terminal).toBe(false);
		expect(f.raw.launchExecution).not.toHaveBeenCalled();
	});
	it("keeps an unanswered association explicitly unavailable", async () => {
		const f = nativeFixture();
		f.raw.readExecutionAssociation.mockRejectedValue(new Error("offline"));
		const result = await f.request("process/status", { processId: "job" });
		expect(result.body.observation).toBe("unavailable");
		expect(f.raw.launchExecution).not.toHaveBeenCalled();
	});
	it("retains timeout and native signal even when root exits zero", async () => {
		const f = nativeFixture();
		f.add();
		f.finish({ code: 0, timedOut: true, signal: 15 } as any);
		const r = await f.request("process/status", {
			processId: "job",
			tailBytes: 8,
		});
		expect(r.body.job).toMatchObject({
			terminal: true,
			exitCode: 0,
			timedOut: true,
			signal: 15,
		});
		expect(r.body.job.evidence.eventType).toBe("workstation.process.timed_out");
		expect(r.body.job.stdoutTruncated).toBe(true);
		expect(r.body.job.evidence.signal).toBe(15);
		expect(f.handle.output).not.toHaveBeenCalled();
	});
	it("uploads complete native file streams before publishing evidence", async () => {
		const f = nativeFixture();
		f.add();
		f.finish();
		const writes: string[] = [];
		f.storage.put.mockImplementation(async (key, value) => {
			if (value instanceof ReadableStream) {
				const text = await new Response(value).text();
				expect(text).toMatch(/output/);
			}
			writes.push(key);
			return { etag: "ok" };
		});
		await f.request("process/status", { processId: "job" });
		expect(writes.at(-1)).toMatch(/evidence/);
		expect(writes.length).toBe(3);
	});
	it("reads retained terminal truth after native loss without waking the Sandbox", async () => {
		const f = nativeFixture();
		f.add();
		f.finish();
		let retained: string | null = null;
		f.storage.get.mockImplementation(async (key) =>
			key.endsWith("evidence.json") && retained
				? { text: async () => retained! }
				: null,
		);
		f.storage.put.mockImplementation(async (key, value, options) => {
			if (value instanceof ReadableStream) {
				throw new Error("upload failed");
			} else if (key.endsWith("evidence.json")) {
				if (options?.onlyIf && retained) return null;
				retained = String(value);
			}
			return { etag: "stored" };
		});
		const first = await f.request("process/status", { processId: "job" });
		expect(first.body.job).toMatchObject({
			terminal: true,
			exitCode: 0,
			artifactRefs: expect.arrayContaining([
				expect.stringContaining("evidence.json"),
			]),
			artifactWriteStatus: { status: "persisted" },
		});
		f.raw.getProcess.mockRejectedValue(new Error("native gone"));
		f.raw.readFile.mockRejectedValue(new Error("files gone"));
		for (const method of Object.values(f.raw)) method.mockClear();
		const second = await f.request("process/status", { processId: "job" });
		expect(second.body.job).toMatchObject({
			terminal: true,
			exitCode: 0,
			artifactRefs: expect.arrayContaining([
				expect.stringContaining("evidence.json"),
			]),
			artifactWriteStatus: { status: "persisted" },
		});
		for (const method of Object.values(f.raw))
			expect(method).not.toHaveBeenCalled();
		expect(JSON.parse(retained!).artifactRefs.length).toBeGreaterThan(0);
	});
	it("never publishes complete-log evidence when a spool upload fails", async () => {
		const f = nativeFixture();
		f.add();
		f.finish();
		f.storage.put.mockRejectedValue(new Error("R2 offline"));
		const r = await f.request("process/status", { processId: "job" });
		expect(r.body.job.artifactWriteStatus.status).toBe("failed");
		expect(r.body.job.artifactRefs).toEqual([]);
		expect(
			f.storage.put.mock.calls.some(([key]) => key.includes("evidence")),
		).toBe(true);
	});
	it("settles the delayed peer upload before returning a spool failure", async () => {
		const f = nativeFixture();
		f.add();
		f.finish();
		let release!: () => void, started!: () => void;
		const delayed = new Promise<void>((resolve) => {
			release = resolve;
		});
		const peerStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		f.storage.put.mockImplementation(async (key, value) => {
			if (key.includes("stdout")) throw new Error("stdout upload failed");
			if (key.includes("stderr")) {
				started();
				await delayed;
				await new Response(value as ReadableStream).arrayBuffer();
				throw new Error("stderr upload failed later");
			}
			return { etag: "unexpected" };
		});
		let settled = false;
		const pending = f
			.request("process/status", { processId: "job" })
			.then((value) => {
				settled = true;
				return value;
			});
		await peerStarted;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);
		release();
		const result = await pending;
		expect(result.body.job.artifactWriteStatus).toMatchObject({
			status: "failed",
			error: "stdout upload failed",
		});
		expect(result.body.job.artifactRefs).toEqual([]);
		expect(
			f.storage.put.mock.calls.some(([key]) => key.includes("evidence")),
		).toBe(true);
	});
	it("waits on native completion and promotes terminal artifacts", async () => {
		const f = nativeFixture();
		f.add();
		const r = await f.request("process/wait", {
			processId: "job",
			timeoutMs: 50,
		});
		expect(r.body.terminal).toBe(true);
		expect(f.handle.waitForExit).toHaveBeenCalledWith({ timeout: 50 });
		expect(f.handle.kill).not.toHaveBeenCalled();
	});
	it("wait expiry is unavailable and never kills or infers still-running", async () => {
		const f = nativeFixture();
		f.add();
		f.handle.waitForExit.mockRejectedValue(new Error("observation timeout"));
		const r = await f.request("process/wait", {
			processId: "job",
			timeoutMs: 5,
		});
		expect(r.body.job).toMatchObject({
			terminal: false,
			running: false,
			observation: "unavailable",
		});
		expect(f.handle.kill).not.toHaveBeenCalled();
	});
	it("rejects a mismatched lease before returning process output", async () => {
		const f = nativeFixture();
		f.add("job", {
			leaseId: "owner-lease",
			workstationId: "owner-workstation",
		});
		const r = await f.request("process/status", {
			processId: "job",
			leaseId: "other",
		});
		expect(r.status).toBe(403);
		expect(r.body.job).toBeUndefined();
	});
	it("does not redispatch a retained terminal or unknown process id", async () => {
		for (const stale of [false, true]) {
			const f = nativeFixture();
			f.add();
			f.finish();
			if (stale) f.raw.getProcess.mockRejectedValue(new Error("stale"));
			const r = await f.request("process/start", {
				processId: "job",
				command: "touch dangerous",
			});
			if (!stale) expect(r.body.alreadyDispatched).toBe(true);
			expect(
				f.raw.launchExecution.mock.calls.some(
					([request]) => request.executionId === "job",
				),
			).toBe(false);
		}
	});
	it("does not replay a failed foreground dispatch", async () => {
		const f = nativeFixture();
		let attempts = 0;
		const original = f.raw.launchExecution.getMockImplementation()!;
		f.raw.launchExecution.mockImplementation(async (request) => {
			if (JSON.stringify(request).includes("touch dangerous")) {
				attempts++;
				throw new Error("connection lost after dispatch");
			}
			return original(request);
		});
		const r = await f.request("exec", { command: "touch dangerous" });
		expect(r.body.ok).toBe(false);
		expect(attempts).toBe(1);
		expect(f.raw.destroy).not.toHaveBeenCalled();
	});
	it("cancellation preserves the actual native zero exit after TERM", async () => {
		const f = nativeFixture();
		f.add();
		const r = await f.request("process/cancel", { processId: "job" });
		expect(r.body.canceled).toBe(true);
		expect(r.body.job.exitCode).toBe(0);
		expect(f.handle.kill).toHaveBeenCalledWith(15);
	});
	it("does not claim cancellation when native kill observation fails", async () => {
		const f = nativeFixture();
		f.add();
		f.handle.waitForExit.mockRejectedValue(new Error("stale handle"));
		const r = await f.request("process/cancel", { processId: "job" });
		expect(r.body.canceled).toBe(false);
	});
});

describe("native checkpoint lock and incarnation fences", () => {
	it.each([
		{ truncated: true, timedOut: false },
		{ truncated: false, timedOut: true },
	])("rejects incomplete checkpoint capture even exit0: %j", async (flags) => {
		const f = nativeFixture();
		f.raw.exec.mockResolvedValue({
			...f.handle,
			output: vi.fn(async () => ({ ...completeOutput, ...flags })),
		});
		await expect(
			checkpointNative(f.body, workdir, async () => undefined).exec("capture"),
		).rejects.toThrow(/incomplete|timed out/);
	});
	it("passes an explicit complete capture budget and native writes", async () => {
		const f = nativeFixture();
		const output = vi.fn(async () => completeOutput);
		f.raw.exec.mockResolvedValue({ ...f.handle, output });
		const guard = vi.fn(async () => undefined);
		const native = checkpointNative(f.body, workdir, guard);
		await native.exec("capture", { timeout: 123 });
		expect(output).toHaveBeenCalledWith(
			expect.objectContaining({ maxBytes: 16 * 1024 * 1024 }),
		);
		await native.writeFile("/tmp/tedix-restore-abc.patch.base64", "data");
		expect(f.raw.writeFile).toHaveBeenCalledWith(
			"/tmp/tedix-restore-abc.patch.base64",
			"data",
		);
		expect(guard).toHaveBeenCalledTimes(1);
	});
	it("restores a divergent unpublished branch after main advances using the original task base", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-replacement-"));
		const origin = join(dir, "origin"),
			replacement = join(dir, "replacement");
		mkdirSync(origin);
		const env = { ...process.env };
		for (const key of Object.keys(env))
			if (key.startsWith("GIT_")) Reflect.deleteProperty(env, key);
		const git = (cwd: string, ...args: string[]) =>
			execFileSync("git", args, {
				cwd,
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		try {
			git(origin, "init", "-b", "main");
			git(origin, "config", "user.name", "Test");
			git(origin, "config", "user.email", "test@example.invalid");
			writeFileSync(join(origin, "base"), "base");
			git(origin, "add", ".");
			git(origin, "commit", "-m", "base");
			const base = git(origin, "rev-parse", "HEAD");
			git(origin, "checkout", "-b", "task");
			writeFileSync(join(origin, "task"), "unpublished");
			git(origin, "add", ".");
			git(origin, "commit", "-m", "task commit");
			const taskHead = git(origin, "rev-parse", "HEAD");
			writeFileSync(join(origin, "dirty"), "dirty data");
			const store = new Map<string, string>();
			const storage = {
				get: async (key: string) =>
					store.has(key)
						? { etag: "etag", text: async () => store.get(key)! }
						: null,
				put: async (key: string, value: string) => {
					store.set(key, value);
					return { etag: "etag" };
				},
			};
			const native = (cwd: string) => ({
				exec: async (command: string) => {
					const r = spawnSync("bash", ["-c", command], {
						cwd,
						env,
						encoding: "utf8",
					});
					return {
						exitCode: r.status ?? 1,
						stdout: r.stdout,
						stderr: r.stderr,
					};
				},
				writeFile: async (path: string, content: string) => {
					writeFileSync(path, content);
				},
			});
			const common = {
				manifestKey: "manifest",
				storage,
				workdir: origin,
				preparedStartSha: base,
				provenance: {
					taskId: "task",
					leaseId: "lease",
					workstationId: "workstation",
					containerPlacementId: "native-process:old",
				},
				withLockedCheckpoint: async <T>(
					fn: (n: ReturnType<typeof native>) => Promise<T>,
				) => fn(native(origin)),
			};
			expect(
				(
					await persistWorkstationRecoveryCheckpoint({
						...common,
						patchPrefix: "patches",
						reason: "replacement",
					})
				).status,
			).toBe("persisted");
			git(origin, "checkout", "main");
			writeFileSync(join(origin, "main-new"), "concurrent main");
			git(origin, "add", "main-new");
			git(origin, "commit", "-m", "advance main");
			git(dir, "clone", "--branch", "main", origin, replacement);
			const command = restorePreparedBaseCommand(replacement, {
				startSha: base,
				branch: "main",
				workdir: replacement,
				outcome: "clean",
				at: "now",
				turnKey: "task",
			});
			execFileSync("bash", ["-c", command], { env });
			expect(git(replacement, "rev-parse", "HEAD")).toBe(base);
			// Manifest workdir is native-path stable across replacement containers.
			store.set(
				"manifest",
				store.get("manifest")!.replaceAll(origin, replacement),
			);
			const restored = await restoreWorkstationRecoveryCheckpoint({
				...common,
				workdir: replacement,
				provenance: {
					...common.provenance,
					containerPlacementId: "native-process:new",
				},
				withLockedCheckpoint: async (fn) => fn(native(replacement)),
			});
			expect(restored.status, restored.error).toBe("restored");
			expect(git(replacement, "rev-parse", "HEAD")).toBe(taskHead);
			expect(readFileSync(join(replacement, "dirty"), "utf8")).toBe(
				"dirty data",
			);
			writeFileSync(join(replacement, "extra"), "must survive");
			expect(spawnSync("bash", ["-c", command]).status).not.toBe(0);
			expect(readFileSync(join(replacement, "extra"), "utf8")).toBe(
				"must survive",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
describe("push-safety invariants (healer parity, 72ecb864)", () => {
	it("protects the deploy pipeline, dependency identity, schema, and settlement machinery", () => {
		for (const path of [
			".github/workflows/deploy-workers.yml",
			"bun.lock",
			"apps/api/package.json",
			"apps/mcp/wrangler.jsonc",
			"apps/api/worker-configuration.d.ts",
			"apps/cms/Dockerfile",
			"scripts/work/check-push-provenance.ts",
			"scripts/db-access-exceptions.json",
			"packages/db/src/schema/mcp-payments.ts",
		]) {
			expect(isProtectedWorkstationPushPath(path), path).toBe(true);
		}
		for (const path of [
			"apps/mcp/src/mcp/payments.ts",
			"docs/DEVELOPMENT.md",
			"packages/db/src/queries/mcp-payments.ts",
			"apps/api/src/rpc/routers/work-items.ts",
		]) {
			expect(isProtectedWorkstationPushPath(path), path).toBe(false);
		}
	});

	it("parses guard violations out of exec output", () => {
		expect(
			pushGuardViolation("some output\nTEDIX_PUSH_GUARD=protected_path\n"),
		).toBe("protected_path");
		expect(pushGuardViolation("TEDIX_PUSHED_COMMIT=abc\n")).toBeNull();
		expect(pushGuardViolation(undefined)).toBeNull();
	});
});

describe("native commit execution environment", () => {
	it("shares the bootstrap Bun cache with native command shells", () => {
		const command = withWorkstationCommitProvenance(
			'printf "%s" "$BUN_INSTALL_CACHE_DIR"',
			{ workItemId: null, kernelRunId: null },
		);
		expect(
			execFileSync("bash", ["-c", command], {
				encoding: "utf8",
				env: { ...process.env, BUN_INSTALL_CACHE_DIR: "/stale-cache" },
			}),
		).toBe("/home/tedi/workstation/cache/package-managers/bun");
	});
	it("replaces stale parent metadata and clears it for unbound commands in real shells", () => {
		const command = `printf '%s\n%s\n' "$TEDIX_COMMIT_WORK_ITEM" "$TEDIX_COMMIT_AGENT_SESSION"`;
		const env = {
			...process.env,
			TEDIX_COMMIT_WORK_ITEM: "stale-item",
			TEDIX_COMMIT_AGENT_SESSION: "kernel:stale",
		};
		const run = (context: {
			workItemId: string | null;
			kernelRunId: string | null;
		}) =>
			execFileSync(
				"bash",
				["-c", withWorkstationCommitProvenance(command, context)],
				{ env, encoding: "utf8" },
			);
		expect(
			run({
				workItemId: "5eed0016-0000-4000-8000-000000000016",
				kernelRunId: "child-a",
			}),
		).toBe("5eed0016-0000-4000-8000-000000000016\nkernel:child-a\n");
		expect(run({ workItemId: null, kernelRunId: "unbound" })).toBe("\n\n");
		expect(run({ workItemId: "partial", kernelRunId: null })).toBe(
			"partial\n\n",
		);
	});
});

// These are real generated shell commands, not mocked timeout results. Run this
// suite on Linux (GNU timeout/setsid); a platform skip is not release evidence.
describe("dependency preparation identity in a real shell", () => {
	it("reuses only matching preparations and never publishes failed or changed installs", () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-dependency-identity-"));
		const bin = join(dir, "bin");
		const marker = join(dir, "node_modules/.tedix-dependency-fingerprint");
		const lockfileHash = () =>
			createHash("sha256")
				.update(readFileSync(join(dir, "bun.lock")))
				.digest("hex");
		const nativeNode = execFileSync("node", ["-p", "process.execPath"], {
			encoding: "utf8",
		}).trim();
		const localize = (command: string) =>
			command.replaceAll("/home/tedi/workstation", join(dir, "workstation"));
		mkdirSync(bin);
		writeFileSync(
			join(bin, "bun"),
			`#!/bin/bash
if [ "$1" = --version ]; then printf '%s\\n' "\${TEST_BUN_VERSION:-1.4.2}"; exit 0; fi
if [ -f node_modules/.tedix-dependency-fingerprint ]; then echo 'stale marker survived' >&2; exit 81; fi
printf '%s|%s\\n' "$*" "$BUN_INSTALL_CACHE_DIR" >> installs.log
if [ "\${TEST_INSTALL_FAIL:-}" = 1 ]; then exit 1; fi
mkdir -p node_modules
printf 'installed\\n' > node_modules/retained
if [ "\${TEST_CHANGE_LOCKFILE:-}" = 1 ]; then printf 'changed during install' > bun.lock; fi
`,
			{ mode: 0o755 },
		);
		writeFileSync(join(bin, "timeout"), '#!/bin/bash\nshift\nexec "$@"\n', {
			mode: 0o755,
		});
		writeFileSync(
			join(bin, "node"),
			`#!/bin/bash
export TEST_NODE_SCRIPT="$2"
exec ${JSON.stringify(nativeNode)} -e 'for (const [key, env] of [["platform", "TEST_PLATFORM"], ["arch", "TEST_ARCH"], ["version", "TEST_NODE_VERSION"]]) { if (process.env[env]) Object.defineProperty(process, key, { value: process.env[env] }); } eval(process.env.TEST_NODE_SCRIPT);' "\${@:3}"
`,
			{ mode: 0o755 },
		);
		const run = (command: string, extra: Record<string, string> = {}) =>
			spawnSync("bash", ["-c", localize(command)], {
				cwd: dir,
				encoding: "utf8",
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra },
			});
		const probe = (
			extra: Record<string, string> = {},
			command = bootstrapProbeCommand("identity-test"),
		) => {
			const result = run(command, extra);
			expect(result.status, result.stderr).toBe(0);
			return result.stdout;
		};
		const install = (extra: Record<string, string> = {}) =>
			run(verifiedInstallCommandForLockfile("bun.lock", lockfileHash()), extra);
		try {
			writeFileSync(join(dir, "package.json"), "{}");
			writeFileSync(join(dir, "bun.lock"), "initial lockfile");
			mkdirSync(join(dir, "node_modules"));
			writeFileSync(
				join(dir, "node_modules/.tedix-lockfile-hash"),
				lockfileHash(),
			);
			expect(probe()).toContain("depsReady=0");
			const first = install();
			expect(first.status, first.stderr).toBe(0);
			expect(probe()).toContain("depsReady=1");
			const identity = readFileSync(marker, "utf8");
			expect(identity.trim()).toMatch(/^[a-f0-9]{64}$/);
			expect(existsSync(`${marker}.tmp`)).toBe(false);
			const installed = readFileSync(join(dir, "installs.log"), "utf8");
			expect(installed).toContain(
				"--frozen-lockfile --ignore-scripts --filter !@tedix/cms --filter !@tedix/cms-runtime",
			);
			expect(installed).toContain(
				join(dir, "workstation/cache/package-managers/bun"),
			);
			writeFileSync(
				join(dir, "node_modules/retained"),
				"preserve warm dependencies",
			);
			const warm = install();
			expect(warm.status, warm.stderr).toBe(0);
			expect(warm.stdout).toContain("TEDIX_WORKSTATION_INSTALL=prepared");
			expect(readFileSync(join(dir, "installs.log"), "utf8")).toBe(installed);
			expect(readFileSync(join(dir, "node_modules/retained"), "utf8")).toBe(
				"preserve warm dependencies",
			);
			for (const extra of [
				{ TEST_BUN_VERSION: "9.9.9" },
				{ TEST_PLATFORM: "another-platform" },
				{ TEST_ARCH: "another-architecture" },
				{ TEST_NODE_VERSION: "v99.0.0" },
			] as Array<Record<string, string>>) {
				expect(probe(extra)).toContain("depsReady=0");
			}
			expect(
				probe(
					{},
					bootstrapProbeCommand("identity-test").replaceAll(
						"!@tedix/cms-runtime",
						"!@tedix/changed-filter",
					),
				),
			).toContain("depsReady=0");
			expect(readFileSync(marker, "utf8")).toBe(identity);
			writeFileSync(join(dir, "bun.lock"), "new lockfile");
			expect(probe()).toContain("depsReady=0");
			expect(install({ TEST_INSTALL_FAIL: "1" }).status).not.toBe(0);
			expect(existsSync(marker)).toBe(false);
			expect(probe()).toContain("depsReady=0");
			expect(install({ TEST_CHANGE_LOCKFILE: "1" }).status).not.toBe(0);
			expect(existsSync(marker)).toBe(false);
			const recovered = install();
			expect(recovered.status, recovered.stderr).toBe(0);
			expect(probe()).toContain("depsReady=1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);
});

function createCodingLeaseBundleFixture() {
	const lease = createWorkstationLease({
		organizationId: "org_tedix",
		profileId: "general",
		seats: [
			{
				permissionScopes: [],
				role: "lead",
				slug: "cto",
				tediId: "tedi-1",
			},
		],
		status: "active",
	});
	lease.id = "test-lease";
	lease.workstationId = "test-computer";
	return {
		workstation: {
			id: lease.workstationId,
			profileId: "general",
			organizationId: "org_tedix",
			status: "ready",
			seats: [],
			capabilities: [],
			adapters: [],
			artifactRefs: [],
			metadata: {},
		},
		workstationLease: {
			...lease,
			sessions: [
				{
					adapter: "sandbox-workstation",
					artifactRefs: [],
					endedAt: null,
					externalId: null,
					id: `${lease.workstationId}_shell`,
					kind: "shell",
					leaseId: lease.id,
					metadata: {},
					organizationId: "org_tedix",
					participantId: null,
					sessionKey: "tedi-1",
					startedAt: lease.createdAt,
					status: "ready",
				},
			],
		},
	};
}

function createSharedCodingLeaseBundleFixture() {
	const bundle = createCodingLeaseBundleFixture();
	const participant = {
		...bundle.workstationLease.participants[0],
		id: "participant-cto",
		leaseId: "lease-shared",
		status: "active",
		tediId: "tedi-1",
	};
	return {
		workstation: {
			...bundle.workstation,
			id: "workstation-shared",
			status: "ready",
		},
		workstationLease: {
			...bundle.workstationLease,
			id: "lease-shared",
			participants: [participant],
			sessions: [],
			status: "active",
			workstationId: "workstation-shared",
		},
	};
}

function createTestApp(
	tediConfigOverrides: Partial<AppEnv["Variables"]["tediConfig"]> = {},
) {
	const f = nativeFixture(tediConfigOverrides);
	f.env.DB = {} as D1Database;
	return { ...f, sandbox: f.raw };
}

describe("shell Computer theme publication", () => {
	it("passes the admitted Artifacts remote to the native process push guard", async () => {
		const host = `${"a".repeat(32)}.artifacts.cloudflare.net`;
		const remote = `https://${host}/git/tedix-prod/cms-theme-tedix-landing.git`;
		const bundle = createCodingLeaseBundleFixture();
		bundle.workstation.metadata = { preparation: "shell" };
		bundle.workstationLease.workItemId = "work-1";
		bundle.workstationLease.attemptId = "attempt-1";
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(bundle);
		processMocks.readRepoSyncStatus.mockResolvedValue({
			configured: false,
			status: "not_configured",
		});
		const f = createTestApp({
			workstationEgress: {
				artifactsRepository: {
					host,
					path: "/git/tedix-prod/cms-theme-tedix-landing.git",
				},
			},
		});
		const response = await f.request("process/start", {
			command: "git push origin cmo/blog-landing-kumo-v22",
			leaseId: bundle.workstationLease.id,
			processId: "theme-push",
		});
		expect(response.status).toBe(200);
		const launched = JSON.stringify(f.raw.launchExecution.mock.calls);
		const decodedScripts = [
			...launched.matchAll(/[A-Za-z0-9+/]{100,}={0,2}/g),
		].map(([encoded]) => {
			try {
				return Buffer.from(encoded, "base64").toString("utf8");
			} catch {
				return "";
			}
		});
		expect(decodedScripts.some((script) => script.includes(remote))).toBe(true);
	});
});

describe("repository credential diagnosis", () => {
	it("probes brokered GitHub authority only after repository sync fails", async () => {
		const f = createTestApp();
		const bundle = createCodingLeaseBundleFixture();
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(bundle);
		authorityMocks.getWorkstationLeaseRowBundle.mockResolvedValue(bundle);
		processMocks.readRepoSyncStatus.mockResolvedValue({
			configured: true,
			status: "failed",
			branch: "main",
			workdir,
			repoUrl: "https://github.com/tedix/tedix.git",
			error: "GitHub returned HTTP 429",
		});
		githubCredentialMocks.probeGitHubCliCredentials.mockResolvedValue({
			status: "valid",
			httpStatus: 200,
		});

		const response = await f.request("wake", {
			attemptId: "attempt-1",
			leaseId: "test-lease",
			workItemId: "work-1",
		});

		expect(
			githubCredentialMocks.probeGitHubCliCredentials,
		).toHaveBeenCalledOnce();
		expect(response.body.credentials).toMatchObject({
			configured: true,
			status: "brokered",
			probe: { status: "valid", httpStatus: 200 },
		});
	});
});

describe("repository inspection authority capture", () => {
	it("binds the fresh provisioning baseline once and does not trust marker replay", async () => {
		const f = createTestApp();
		const bundle = createCodingLeaseBundleFixture();
		Object.assign(bundle.workstationLease, {
			attemptId: "attempt-1",
			bodyGenerationId: "generation-1",
			bodyInstanceName: "body-1",
			orgId: "org_tedix",
			status: "provisioning",
			workItemId: "work-1",
		});
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(bundle);
		authorityMocks.getWorkstationLeaseRowBundle.mockResolvedValue(bundle);
		processMocks.readRepoSyncStatus.mockResolvedValue({
			configured: true,
			status: "updated",
			branch: "main",
			workdir,
			repoUrl: "https://github.com/tedix/tedix.git",
		});
		processMocks.ensureCleanRepoTreeForTurn.mockResolvedValue({
			at: "2026-09-20T00:00:00Z",
			authoritySource: "fresh_preparation",
			branch: "main",
			outcome: "clean",
			startSha: "a".repeat(40),
			turnKey: "attempt-1",
			workdir,
		});

		const first = await f.request("wake", {
			attemptId: "attempt-1",
			leaseId: "test-lease",
			workItemId: "work-1",
		});
		expect(first.status).toBe(200);
		expect(
			authorityMocks.bindWorkstationLeaseRepositoryAuthority,
		).toHaveBeenCalledWith(
			"db-client",
			expect.objectContaining({
				attemptId: "attempt-1",
				generationId: "generation-1",
				leaseId: "test-lease",
				preparedStartSha: "a".repeat(40),
				repositoryPath: "tedix/tedix",
				workItemId: "work-1",
			}),
		);

		authorityMocks.bindWorkstationLeaseRepositoryAuthority.mockClear();
		processMocks.ensureCleanRepoTreeForTurn.mockResolvedValue({
			at: "2026-09-20T00:00:00Z",
			branch: "main",
			outcome: "clean",
			startSha: "b".repeat(40),
			turnKey: "attempt-1",
			workdir,
		});
		processMocks.readRepoSyncStatus.mockResolvedValue({
			configured: true,
			status: "updated",
			branch: "main",
			workdir,
			repoUrl: "https://github.com/tedix/tedix.git",
			treePreflight: {
				authoritySource: "fresh_preparation",
				startSha: "b".repeat(40),
				turnKey: "attempt-1",
			},
		});
		await f.request("wake", {
			attemptId: "attempt-1",
			leaseId: "test-lease",
			workItemId: "work-1",
		});
		expect(
			authorityMocks.bindWorkstationLeaseRepositoryAuthority,
		).not.toHaveBeenCalled();
	});
});
describe("unprepared checkout safety probe", () => {
	it.each([
		"relative/missing",
		"./missing",
		"/home/tedi/workstation/../escape",
		"/home/tedi/workstation/./missing",
		"/tmp/../missing",
		"/tmp/./missing",
	])("rejects noncanonical path before filesystem proof: %s", (target) => {
		const result = spawnSync(
			"bash",
			["-c", unpreparedCheckoutProbeCommand(target)],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	it.each(["absent", "empty", "nonempty", "symlink", "symlink-parent", "file"])(
		"classifies %s without following symlinks",
		(state) => {
			const root = realpathSync(mkdtempSync(join(tmpdir(), "empty-checkout-")));
			const target = join(root, "repo");
			try {
				if (state === "file") writeFileSync(target, "data");
				else if (state !== "absent") mkdirSync(target);
				if (state === "nonempty")
					writeFileSync(join(target, ".hidden"), "keep");
				let probe = target;
				if (state === "symlink" || state === "symlink-parent") {
					symlinkSync(target, join(root, "link"));
					probe = join(
						root,
						"link",
						...(state === "symlink-parent" ? ["missing"] : []),
					);
				}
				const result = spawnSync(
					"bash",
					["-c", unpreparedCheckoutProbeCommand(probe)],
					{ encoding: "utf8" },
				);
				expect(result.status, result.stderr).toBe(
					state === "absent" || state === "empty" ? 0 : 1,
				);
				if (result.status === 0)
					expect(result.stdout.trim()).toBe("no-checkpoint-needed");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
	it.each([
		"absent",
		"empty",
		"nonempty",
		"wrong-target",
		"missing-alias",
		"real-alias",
		"canonical-symlink",
		"descendant-symlink",
		"alias-parent-symlink",
	])("allows only the exact image root alias: %s", (state) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "image-alias-")));
		const alias = join(root, "home", "tedi", "workstation"),
			canonical = join(root, "workspace");
		try {
			mkdirSync(join(root, "home", "tedi"), { recursive: true });
			mkdirSync(canonical);
			if (state === "alias-parent-symlink") {
				rmSync(join(root, "home", "tedi"), { recursive: true });
				mkdirSync(join(root, "other"));
				symlinkSync(join(root, "other"), join(root, "home", "tedi"));
			}
			if (state === "real-alias") mkdirSync(alias);
			else if (state !== "missing-alias")
				symlinkSync(state === "wrong-target" ? root : canonical, alias);
			if (state === "canonical-symlink") {
				rmSync(canonical, { recursive: true });
				symlinkSync(root, canonical);
			} else if (state !== "absent") {
				mkdirSync(join(canonical, "repo"));
				if (state === "nonempty")
					writeFileSync(join(canonical, "repo", ".keep"), "data");
			}
			if (state === "descendant-symlink") {
				rmSync(join(canonical, "repo"), { recursive: true });
				symlinkSync(join(root, "missing"), join(canonical, "repo"));
			}
			const command = unpreparedCheckoutProbeCommand(
				"/home/tedi/workstation/repo",
			)
				.replaceAll("/home/tedi/workstation", alias)
				.replaceAll("/workspace", canonical);
			const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
			expect(result.status, result.stderr).toBe(
				state === "absent" || state === "empty" ? 0 : 1,
			);
			if (result.status === 0)
				expect(result.stdout.trim()).toBe("no-checkpoint-needed");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("workstation release route", () => {
	beforeEach(() =>
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(
			createCodingLeaseBundleFixture(),
		),
	);
	it("releases a blocked repository-mode lease that never had a checkout", async () => {
		const f = createTestApp();
		const bundle = createCodingLeaseBundleFixture();
		bundle.workstationLease.status = "blocked";
		bundle.workstationLease.metadata = {
			repoSync: { configured: false, status: "not_configured" },
		};
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(bundle);
		dbMocks.releaseWorkstationLease.mockImplementation(async () => {
			bundle.workstationLease.status = "released";
			return { ok: true, alreadyReleased: false, bundle };
		});

		const result = await f.request("release", {
			leaseId: "test-lease",
			preserveChanges: true,
		});
		expect(result.body).toMatchObject({
			ok: true,
			workstationLease: { status: "released" },
		});
		expect(dbMocks.releaseWorkstationLease).toHaveBeenCalledOnce();
		expect(f.storage.put).not.toHaveBeenCalled();
	});
	it.each([
		undefined,
		null,
		"",
		42,
		"/tmp/other",
		"relative/repo",
		"/home/tedi/workstation/../other",
		"/home/tedi/workstation/./repo",
		"/home/tedi/workstation/repo\0",
	])(
		"refuses missing or invalid recorded repository path: %s",
		async (recorded) => {
			const f = createTestApp();
			const bundle = createCodingLeaseBundleFixture();
			bundle.workstationLease.metadata = {
				repoSync: { workdir: recorded },
			} as any;
			dbMocks.getWorkstationLeaseBundle.mockResolvedValue(bundle);
			const result = await f.request("release", {
				leaseId: "test-lease",
				preserveChanges: true,
				cwd: workdir,
			});
			expect(result.body).toMatchObject({
				ok: false,
				error: "Computer release requires its recorded repository cwd",
			});
			expect(
				f.raw.exec.mock.calls.every(([argv]) =>
					argv.join(" ").includes("TEDIX_CHECKOUT_LOCK_ACQUIRED"),
				),
			).toBe(true);
			expect(dbMocks.releaseWorkstationLease).not.toHaveBeenCalled();
			expect(
				f.raw.writeFile.mock.calls.every(([path]) =>
					path.startsWith("/tmp/tedix-checkout-"),
				),
			).toBe(true);
			expect(
				sandboxDestroyMocks.destroySandboxWithTimeout,
			).not.toHaveBeenCalled();
		},
	);
	it.each([
		"empty",
		"nonempty",
		"unknown",
		"read-error",
		"truncated",
		"timeout",
		"signal",
		"wrong-path",
		"default-root",
		"authority-changed",
		"lock-lost",
	])("retains unprepared checkout unless safely empty: %s", async (state) => {
		const f = createTestApp();
		const bundle = createCodingLeaseBundleFixture();
		bundle.workstationLease.metadata = { repoSync: { workdir } };
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(bundle);
		let probed = false;
		f.raw.exec.mockImplementation(async (argv) => {
			if (argv.join(" ").includes("TEDIX_CHECKOUT_LOCK_ACQUIRED"))
				return f.handle;
			probed = true;
			expect(argv.join(" ")).toContain(workdir);
			expect(argv.join(" ")).not.toContain(workdir + "/other");
			if (state === "read-error") throw new Error("read failure");
			if (state === "authority-changed")
				dbMocks.getWorkstationLeaseBundle.mockResolvedValue({
					...bundle,
					workstationLease: {
						...bundle.workstationLease,
						workItemId: "changed",
					},
				});
			if (state === "lock-lost")
				f.handle.status.mockRejectedValue(new Error("stale"));
			return {
				...f.handle,
				output: vi.fn(async () => ({
					...completeOutput,
					stdout: state === "unknown" ? "" : "no-checkpoint-needed\n",
					exitCode: state === "nonempty" ? 1 : 0,
					timedOut: state === "timeout",
					truncated: state === "truncated",
					...(state === "signal" ? { signal: 15 } : {}),
				})),
			};
		});
		dbMocks.releaseWorkstationLease.mockImplementation(async () => {
			expect(probed).toBe(true);
			expect(
				f.raw.exec.mock.calls.some(([argv]) =>
					argv.join(" ").includes("checkout.closing"),
				),
			).toBe(true);
			return { ok: true, alreadyReleased: false, bundle };
		});
		const result = await f.request("release", {
			leaseId: "test-lease",
			preserveChanges: true,
			cwd:
				state === "wrong-path"
					? workdir + "/other"
					: state === "default-root"
						? "/home/tedi/workstation"
						: workdir,
		});
		const safe = ["empty", "wrong-path", "default-root"].includes(state);
		expect(result.body.ok).toBe(safe);
		expect(f.storage.put).not.toHaveBeenCalled();
		if (!safe) {
			expect(dbMocks.releaseWorkstationLease).not.toHaveBeenCalled();
			expect(
				sandboxDestroyMocks.destroySandboxWithTimeout,
			).not.toHaveBeenCalled();
			expect(
				f.raw.writeFile.mock.calls.every(([path]) =>
					path.startsWith("/tmp/tedix-checkout-"),
				),
			).toBe(true);
		}
	});

	it.each([false, true])(
		"keeps closing fenced through checkpoint upload and destruction timeout=%s",
		async (timedOut) => {
			const f = createTestApp(),
				bundle = createCodingLeaseBundleFixture();
			bundle.workstationLease.metadata = {
				repoSync: {
					workdir,
					treePreflight: { startSha: "a".repeat(40), turnKey: "turn" },
				},
			};
			dbMocks.getWorkstationLeaseBundle.mockResolvedValue(bundle);
			let closed = false;
			let snapshotted = false;
			let publish!: () => void;
			let begin!: () => void;
			const pending = new Promise<void>((resolve) => {
				publish = resolve;
			});
			const started = new Promise<void>((resolve) => {
				begin = resolve;
			});
			f.raw.exec.mockImplementation(async (argv) => ({
				...f.handle,
				output: vi.fn(async () => {
					expect(argv.join(" ")).toContain("checkout.closing");
					closed = true;
					return {
						...completeOutput,
						stdout: `${"a".repeat(40)}\n\n${btoa("dirty patch")}\n`,
					};
				}),
			}));
			f.storage.put.mockImplementation(async () => {
				expect(closed).toBe(true);
				begin();
				await pending;
				return { etag: "etag" };
			});
			dbMocks.releaseWorkstationLease.mockImplementation(async () => {
				expect(closed).toBe(true);
				bundle.workstationLease.status = "released";
				return { ok: true, alreadyReleased: false, bundle };
			});
			f.raw.snapshotForResume.mockImplementation(async () => {
				expect(closed).toBe(true);
				snapshotted = true;
				return {
					status: "saved",
					snapshotId: "native-snapshot",
					expiresAt: "2026-10-30T00:00:00.000Z",
				};
			});
			sandboxDestroyMocks.destroySandboxWithTimeout.mockImplementation(
				async () => {
					expect(closed).toBe(true);
					expect(snapshotted).toBe(true);
					return { completed: !timedOut, timedOut };
				},
			);
			const response = f.request("release", {
				leaseId: "test-lease",
				preserveChanges: true,
			});
			await started;
			expect(dbMocks.releaseWorkstationLease).not.toHaveBeenCalled();
			expect(
				sandboxDestroyMocks.destroySandboxWithTimeout,
			).not.toHaveBeenCalled();
			publish();
			expect((await response).body).toMatchObject({
				ok: !timedOut,
				adapterCleanup: { status: timedOut ? "timed_out" : "destroyed" },
				nativeSnapshot: {
					status: "saved",
					snapshotId: "native-snapshot",
				},
			});
			expect(f.raw.deleteFile).not.toHaveBeenCalled();
			expect(f.handle.kill).not.toHaveBeenCalled();
		},
	);
	it("continues durable release cleanup when native snapshot creation fails", async () => {
		const f = createTestApp();
		const bundle = createCodingLeaseBundleFixture();
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(bundle);
		dbMocks.releaseWorkstationLease.mockResolvedValue({
			ok: true,
			alreadyReleased: false,
			bundle,
		});
		f.raw.snapshotForResume.mockRejectedValue(
			new Error("provider snapshot unavailable"),
		);
		const result = await f.request("release", {
			leaseId: "test-lease",
			preserveChanges: false,
		});
		expect(result.body).toMatchObject({
			ok: true,
			nativeSnapshot: {
				status: "failed",
				error: "provider snapshot unavailable",
			},
			adapterCleanup: { status: "destroyed" },
		});
		expect(sandboxDestroyMocks.destroySandboxWithTimeout).toHaveBeenCalledTimes(
			1,
		);
	});
	it("retains the closing body for exact release retry when R2 publication fails", async () => {
		const f = createTestApp();
		const bundle = createCodingLeaseBundleFixture();
		bundle.workstationLease.metadata = {
			repoSync: {
				workdir,
				treePreflight: { startSha: "a".repeat(40), turnKey: "turn" },
			},
		};
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(bundle);
		f.raw.exec.mockResolvedValue({
			...f.handle,
			output: vi.fn(async () => ({
				...completeOutput,
				stdout: `${"a".repeat(40)}\n\n${btoa("dirty patch")}\n`,
			})),
		});
		f.storage.put.mockRejectedValue(new Error("R2 unavailable"));
		expect(
			(
				await f.request("release", {
					leaseId: "test-lease",
					preserveChanges: true,
					cwd: workdir,
				})
			).body,
		).toMatchObject({ ok: false, checkpoint: { status: "failed" } });
		expect(
			f.raw.writeFile.mock.calls.every(([path]) =>
				path.startsWith("/tmp/tedix-checkout-"),
			),
		).toBe(true);
		expect(dbMocks.releaseWorkstationLease).not.toHaveBeenCalled();
		expect(
			sandboxDestroyMocks.destroySandboxWithTimeout,
		).not.toHaveBeenCalled();
		expect(f.handle.kill).not.toHaveBeenCalled();
	});
	it("rechecks lease authority after native lock acquisition before publishing the gate", async () => {
		const f = createTestApp(),
			bundle = createCodingLeaseBundleFixture();
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(bundle);
		f.raw.pathExists.mockImplementation(async () => {
			dbMocks.getWorkstationLeaseBundle.mockResolvedValue({
				...bundle,
				workstationLease: { ...bundle.workstationLease, status: "released" },
			});
			return { pathExists: true };
		});
		expect(
			(await f.request("release", { leaseId: "test-lease" })).body,
		).toMatchObject({
			ok: false,
			error: expect.stringContaining("authority changed"),
		});
		expect(f.raw.renamePath).not.toHaveBeenCalled();
		expect(dbMocks.releaseWorkstationLease).not.toHaveBeenCalled();
	});

	it("refuses lease closure when the closing marker write is unsuccessful", async () => {
		const f = createTestApp();
		f.raw.writeFile.mockRejectedValue(new Error("marker write failed"));
		expect(
			(await f.request("release", { leaseId: "test-lease" })).body,
		).toMatchObject({ ok: false });
		expect(dbMocks.releaseWorkstationLease).not.toHaveBeenCalled();
		expect(
			sandboxDestroyMocks.destroySandboxWithTimeout,
		).not.toHaveBeenCalled();
	});
	it("retries cleanup of a released lease without booting a native lock holder", async () => {
		const f = createTestApp();
		const bundle = createCodingLeaseBundleFixture();
		bundle.workstationLease.status = "released";
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(bundle);
		expect(
			(await f.request("release", { leaseId: "test-lease" })).body,
		).toMatchObject({ ok: true, alreadyReleased: true });
		expect(f.raw.exec).not.toHaveBeenCalled();
		expect(
			f.raw.writeFile.mock.calls.every(([path]) =>
				path.startsWith("/tmp/tedix-checkout-"),
			),
		).toBe(true);
		expect(dbMocks.releaseWorkstationLease).not.toHaveBeenCalled();
		expect(sandboxDestroyMocks.destroySandboxWithTimeout).toHaveBeenCalled();
	});

	it("retains the lease when repository preservation is unavailable", async () => {
		const bundle = createCodingLeaseBundleFixture();
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(bundle);
		const { app, env } = createTestApp();
		env.TEDI_STORAGE = undefined as unknown as R2Bucket;
		const response = await app.request(
			"/workstation/release",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					leaseId: bundle.workstationLease.id,
					preserveChanges: true,
					cwd: "/home/tedi/workstation/repo",
				}),
			},
			env,
		);
		await expect(response.json()).resolves.toMatchObject({ ok: false });
		expect(dbMocks.releaseWorkstationLease).not.toHaveBeenCalled();
		expect(
			sandboxDestroyMocks.destroySandboxWithTimeout,
		).not.toHaveBeenCalled();
	});
	it("retries physical cleanup after a timeout instead of accepting the closed ledger", async () => {
		const bundle = createCodingLeaseBundleFixture();
		dbMocks.releaseWorkstationLease
			.mockResolvedValueOnce({ ok: true, alreadyReleased: false, bundle })
			.mockResolvedValueOnce({ ok: true, alreadyReleased: true, bundle });
		sandboxDestroyMocks.destroySandboxWithTimeout
			.mockResolvedValueOnce({ completed: false, timedOut: true })
			.mockResolvedValueOnce({ completed: true, timedOut: false });
		const { app, env } = createTestApp();
		const request = () =>
			app.request(
				"/workstation/release",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ leaseId: bundle.workstationLease.id }),
				},
				env,
			);
		await expect((await request()).json()).resolves.toMatchObject({
			ok: false,
			adapterCleanup: { status: "timed_out" },
		});
		await expect((await request()).json()).resolves.toMatchObject({
			ok: true,
			adapterCleanup: { status: "destroyed" },
		});
		expect(sandboxDestroyMocks.destroySandboxWithTimeout).toHaveBeenCalledTimes(
			2,
		);
	});

	it("releases the persisted lease and destroys the task Sandbox", async () => {
		const bundle = createCodingLeaseBundleFixture();
		bundle.workstation.status = "archived";
		bundle.workstationLease.status = "released";
		bundle.workstationLease.releasedAt = "2026-07-12T13:30:00.000Z";
		dbMocks.releaseWorkstationLease.mockResolvedValue({
			alreadyReleased: false,
			bundle,
			ok: true,
		});

		const { app, env } = createTestApp();
		const response = await app.request(
			"/workstation/release",
			{
				body: JSON.stringify({
					leaseId: bundle.workstationLease.id,
					reason: "write proof complete",
					traceId: "trace-release-1",
				}),
				headers: { "Content-Type": "application/json" },
				method: "POST",
			},
			env,
		);

		expect(response.status).toBe(200);
		expect(dbMocks.releaseWorkstationLease).toHaveBeenCalledWith(
			"db-client",
			bundle.workstationLease.id,
			{
				expectedOrganizationId: "org_tedix",
				releaseContext: {
					reason: "write proof complete",
					releasedBySlug: "cto",
					releasedByTediId: "tedi-1",
					traceId: "trace-release-1",
				},
			},
		);
		expect(sandboxDestroyMocks.destroySandboxWithTimeout).toHaveBeenCalled();
		await expect(response.json()).resolves.toMatchObject({
			adapterCleanup: { status: "destroyed" },
			alreadyReleased: false,
			ok: true,
			workstationLease: { status: "released" },
		});
	});

	it("retries destruction after the lease ledger was already released", async () => {
		const bundle = createCodingLeaseBundleFixture();
		bundle.workstation.status = "archived";
		bundle.workstationLease.status = "released";
		bundle.workstationLease.releasedAt = "2026-07-12T13:30:00.000Z";
		dbMocks.releaseWorkstationLease.mockResolvedValue({
			alreadyReleased: true,
			bundle,
			ok: true,
		});

		const { app, env } = createTestApp();
		const response = await app.request(
			"/workstation/release",
			{
				body: JSON.stringify({ leaseId: bundle.workstationLease.id }),
				headers: { "Content-Type": "application/json" },
				method: "POST",
			},
			env,
		);

		expect(response.status).toBe(200);
		expect(sandboxDestroyMocks.destroySandboxWithTimeout).toHaveBeenCalled();
		await expect(response.json()).resolves.toMatchObject({
			adapterCleanup: {
				status: "destroyed",
			},
			alreadyReleased: true,
			ok: true,
			workstation: { status: "archived" },
			workstationLease: { status: "released" },
			workstationPersistence: { status: "persisted" },
		});
	});
});

describe("reviewer operation authority", () => {
	it("requires approval when a reviewer starts a non-idempotent bounded exec", async () => {
		const shared = createSharedCodingLeaseBundleFixture();
		const baseParticipant = shared.workstationLease.participants[0];
		if (!baseParticipant) throw new Error("missing shared lease participant");
		shared.workstationLease.participants = [
			{
				...baseParticipant,
				id: "participant-reviewer",
				role: "reviewer",
				tediId: "tedi-1",
			},
		];
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(shared);

		const { app, env, sandbox } = createTestApp();
		const response = await app.request(
			"/workstation/exec",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: "git push origin main",
					leaseId: "lease-shared",
					processId: "push-main",
				}),
			},
			env,
		);
		const body = await response.json();

		expect(response.status).toBe(403);
		expect(sandbox.exec).not.toHaveBeenCalled();
		expect(body).toMatchObject({
			ok: false,
			approvalKind: "workstation.operation",
			approvalRequired: true,
			operationLock: "branch_push",
			operationLockSource: "detected",
			reason: "participant_role_requires_approval",
			requestingParticipantId: "participant-reviewer",
			requestingParticipantRole: "reviewer",
			requiredRoles: expect.arrayContaining(["lead", "operator", "specialist"]),
		});
	});

	it("requires approval when a reviewer starts a non-idempotent async process", async () => {
		const shared = createSharedCodingLeaseBundleFixture();
		const baseParticipant = shared.workstationLease.participants[0];
		if (!baseParticipant) throw new Error("missing shared lease participant");
		shared.workstationLease.participants = [
			{
				...baseParticipant,
				id: "participant-reviewer",
				role: "reviewer",
				tediId: "tedi-1",
			},
		];
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(shared);

		const { app, env, sandbox } = createTestApp();
		const response = await app.request(
			"/workstation/process/start",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: "bun install",
					leaseId: "lease-shared",
					processId: "install-deps",
				}),
			},
			env,
		);
		const body = await response.json();

		expect(response.status).toBe(403);
		expect(sandbox.launchExecution).not.toHaveBeenCalled();
		expect(body).toMatchObject({
			ok: false,
			approvalKind: "workstation.operation",
			approvalRequired: true,
			operationLock: "package_install",
			operationLockSource: "detected",
			processId: "install-deps",
			reason: "participant_role_requires_approval",
			requestingParticipantId: "participant-reviewer",
			requestingParticipantRole: "reviewer",
			requiredRoles: expect.arrayContaining(["lead", "operator", "specialist"]),
		});
	});

	it("requires approval for reviewer package-manager dependency mutations", async () => {
		const commands = [
			"bun add zod",
			"bun remove zod",
			"npm add zod",
			"npm remove zod",
			"npm uninstall zod",
			"pnpm add zod",
			"pnpm remove zod",
			"yarn remove zod",
			"corepack pnpm add zod",
			"pnpm --filter @tedix/api add zod",
			"pnpm -F @tedix/api add zod",
			"npm -w apps/api install zod",
		];

		for (const command of commands) {
			const shared = createSharedCodingLeaseBundleFixture();
			const baseParticipant = shared.workstationLease.participants[0];
			if (!baseParticipant) throw new Error("missing shared lease participant");
			shared.workstationLease.participants = [
				{
					...baseParticipant,
					id: "participant-reviewer",
					role: "reviewer",
					tediId: "tedi-1",
				},
			];
			dbMocks.getWorkstationLeaseBundle.mockResolvedValueOnce(shared);

			const { app, env, sandbox } = createTestApp();
			const response = await app.request(
				"/workstation/process/start",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						command,
						leaseId: "lease-shared",
						processId: `pkg-${commands.indexOf(command)}`,
					}),
				},
				env,
			);
			const body = await response.json();

			expect(response.status, command).toBe(403);
			expect(sandbox.launchExecution, command).not.toHaveBeenCalled();
			expect(body, command).toMatchObject({
				ok: false,
				approvalKind: "workstation.operation",
				approvalRequired: true,
				operationLock: "package_install",
				operationLockSource: "detected",
				reason: "participant_role_requires_approval",
				requestingParticipantId: "participant-reviewer",
				requestingParticipantRole: "reviewer",
			});
		}
	});
});
describe("workstation request classification", () => {
	it.each([
		"wake",
		"provision",
		"exec",
		"files",
		"dev-server",
		"process/start",
		"process/status",
		"process/wait",
		"process/cancel",
		"join",
		"release",
		"status",
	])("accepts only the canonical marked POST for %s", (operation) => {
		const headers = new Headers({ [WORKSTATION_HEADER]: "true" });
		const canonicalPath = `/api/admin/workstation/${operation}`;
		expect(isWorkstationRequest("POST", canonicalPath, headers)).toBe(true);
		expect(
			isWorkstationRequest("POST", `/api/workstation/${operation}`, headers),
		).toBe(false);
		expect(isWorkstationRequest("GET", canonicalPath, headers)).toBe(false);
		expect(isWorkstationRequest("POST", canonicalPath, new Headers())).toBe(
			false,
		);
	});
});
describe("workstation join route", () => {
	it("recognizes the join path as an isolate workstation bypass request", () => {
		const headers = new Headers({ [WORKSTATION_HEADER]: "true" });
		expect(
			isWorkstationRequest("POST", "/api/admin/workstation/join", headers),
		).toBe(true);
	});

	it("appends participant seats to an existing lease and returns the snapshot", async () => {
		dbMocks.joinWorkstationLease.mockResolvedValue({
			ok: true,
			added: ["tedi-devops"],
			bundle: {
				workstation: { id: "ws_general_org-tedix_cto", profileId: "general" },
				workstationLease: {
					id: "wl_general_org-tedix_cto",
					participants: [
						{ tediId: "tedi-1", role: "lead" },
						{ tediId: "tedi-devops", role: "specialist", slug: "devops" },
					],
				},
			},
		});

		const { app, env } = createTestApp();
		const response = await app.request(
			"/workstation/join",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Trace-Id": "trace-join-1",
				},
				body: JSON.stringify({
					kernelRunId: "kernel-run-join-1",
					leaseId: "wl_general_org-tedix_cto",
					seats: [
						{ tediId: "tedi-devops", role: "specialist", slug: "devops" },
						// Invalid role is dropped (left undefined), junk seat ignored.
						{ tediId: "tedi-qa", role: "not-a-role" },
						{ notATediId: true },
					],
					traceBundleId: "trace-bundle-join-1",
					workItemId: "work-item-join-1",
				}),
			},
			env,
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(dbMocks.joinWorkstationLease).toHaveBeenCalledWith(
			"db-client",
			"wl_general_org-tedix_cto",
			[
				{
					tediId: "tedi-devops",
					role: "specialist",
					slug: "devops",
					permissionScopes: undefined,
				},
				{
					tediId: "tedi-qa",
					role: undefined,
					slug: undefined,
					permissionScopes: undefined,
				},
			],
			{
				expectedOrganizationId: "org_tedix",
				expectedProfileId: "general",
				joinContext: {
					joinedBySlug: "cto",
					joinedByTediId: "tedi-1",
					kernelRunId: "kernel-run-join-1",
					traceBundleId: "trace-bundle-join-1",
					traceId: "trace-join-1",
					workItemId: "work-item-join-1",
				},
			},
		);
		expect(body).toMatchObject({
			ok: true,
			leaseId: "wl_general_org-tedix_cto",
			added: ["tedi-devops"],
			joinEvidence: {
				addedTediIds: ["tedi-devops"],
				joinedBySlug: "cto",
				joinedByTediId: "tedi-1",
				kernelRunId: "kernel-run-join-1",
				leaseId: "wl_general_org-tedix_cto",
				traceBundleId: "trace-bundle-join-1",
				traceId: "trace-join-1",
				workItemId: "work-item-join-1",
			},
			workstationLease: {
				participants: [
					{ tediId: "tedi-1", role: "lead" },
					{ tediId: "tedi-devops", role: "specialist" },
				],
			},
			workstationPersistence: { status: "persisted" },
		});
	});

	it("returns structured not-found evidence when the lease does not exist", async () => {
		dbMocks.joinWorkstationLease.mockResolvedValue({
			ok: false,
			reason: "lease_not_found",
			leaseId: "wl_missing",
		});

		const { app, env } = createTestApp();
		const response = await app.request(
			"/workstation/join",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					leaseId: "wl_missing",
					seats: [{ tediId: "tedi-devops" }],
				}),
			},
			env,
		);
		const body = await response.json();

		expect(response.status).toBe(404);
		expect(body).toMatchObject({
			ok: false,
			leaseId: "wl_missing",
			reason: "lease_not_found",
			error: "workstation lease not found: wl_missing",
		});
	});

	it("rejects collaborator admission when the requesting tedi is not the lease lead", async () => {
		dbMocks.joinWorkstationLease.mockResolvedValue({
			ok: false,
			reason: "not_lease_lead",
			leaseId: "wl_general_org-tedix_cto",
			leadTediId: "tedi-cto",
		});
		const { app, env } = createTestApp();
		const response = await app.request(
			"/workstation/join",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					leaseId: "wl_general_org-tedix_cto",
					seats: [{ tediId: "tedi-devops" }],
				}),
			},
			env,
		);
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			reason: "not_lease_lead",
			leadTediId: "tedi-cto",
		});
	});

	it("returns structured cross-org and profile mismatch evidence for joins", async () => {
		const { app, env } = createTestApp();
		dbMocks.joinWorkstationLease.mockResolvedValueOnce({
			ok: false,
			reason: "organization_mismatch",
			leaseId: "wl_other_org",
			expectedOrganizationId: "org_tedix",
			actualOrganizationId: "org_other",
		});

		const orgResponse = await app.request(
			"/workstation/join",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					leaseId: "wl_other_org",
					seats: [{ tediId: "tedi-devops" }],
				}),
			},
			env,
		);
		expect(orgResponse.status).toBe(403);
		await expect(orgResponse.json()).resolves.toMatchObject({
			ok: false,
			reason: "organization_mismatch",
			expectedOrganizationId: "org_tedix",
			actualOrganizationId: "org_other",
		});

		dbMocks.joinWorkstationLease.mockResolvedValueOnce({
			ok: false,
			reason: "profile_mismatch",
			leaseId: "wl_wrong_profile",
			expectedProfileId: "general",
			actualProfileId: "browser-automation",
		});
		const profileResponse = await app.request(
			"/workstation/join",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					leaseId: "wl_wrong_profile",
					seats: [{ tediId: "tedi-devops" }],
				}),
			},
			env,
		);
		expect(profileResponse.status).toBe(400);
		await expect(profileResponse.json()).resolves.toMatchObject({
			ok: false,
			reason: "profile_mismatch",
			expectedProfileId: "general",
			actualProfileId: "browser-automation",
		});
	});

	it("rejects a join request with no valid seats before touching the db", async () => {
		const { app, env } = createTestApp();
		const response = await app.request(
			"/workstation/join",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					leaseId: "wl_general_org-tedix_cto",
					seats: [],
				}),
			},
			env,
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body).toMatchObject({
			ok: false,
			error: "seats must include at least one tediId",
		});
		expect(dbMocks.joinWorkstationLease).not.toHaveBeenCalled();
	});
});

describe("native durable authority and retention", () => {
	it("refuses a nonowner cancellation and allows an operator with original process attribution", async () => {
		const f = createTestApp();
		const shared = createSharedCodingLeaseBundleFixture();
		const base = shared.workstationLease.participants[0]!;
		shared.workstationLease.participants = [
			{ ...base, id: "owner", role: "specialist", tediId: "other" },
			{ ...base, id: "reviewer", role: "reviewer", tediId: "tedi-1" },
		];
		dbMocks.getWorkstationLeaseBundle.mockResolvedValue(shared);
		f.add("job", {
			participantId: "owner",
			participantTediId: "other",
			leaseId: "lease-shared",
			workstationId: "workstation-shared",
			sessionId: "owner-session",
			sessionKind: "shell",
		});
		const denied = await f.request("process/cancel", {
			processId: "job",
			leaseId: "lease-shared",
			participantId: "reviewer",
		});
		expect(denied.status).toBe(403);
		expect(f.handle.kill).not.toHaveBeenCalled();
		shared.workstationLease.participants[1]!.role = "operator";
		const allowed = await f.request("process/cancel", {
			processId: "job",
			leaseId: "lease-shared",
			participantId: "reviewer",
		});
		expect(allowed.body.canceled).toBe(true);
		expect(allowed.body.job.evidence.participantId).toBe("owner");
	});
	it("returns retained terminal R2 evidence after native replacement, including timeout and signal", async () => {
		const f = nativeFixture();
		f.add();
		f.finish({ code: 0, timedOut: true, signal: 15 } as any);
		const first = await f.request("process/status", { processId: "job" });
		const evidence = first.body.job.evidence;
		f.storage.get.mockImplementation(async (key) =>
			key.endsWith("evidence.json")
				? { text: async () => JSON.stringify(evidence) }
				: { text: async () => "retained full output" },
		);
		f.associations.clear();
		f.raw.getProcess.mockClear();
		f.raw.readExecutionAssociation.mockClear();
		f.raw.getProcess.mockRejectedValue(new Error("old native gone"));
		const read = await f.request("process/status", { processId: "job" });
		expect(read.body.persistedEvidenceReadback).toBe(true);
		expect(read.body.job).toMatchObject({
			terminal: true,
			exitCode: 0,
			timedOut: true,
			signal: 15,
		});
		expect(f.raw.getProcess).not.toHaveBeenCalled();
		expect(f.raw.readExecutionAssociation).not.toHaveBeenCalled();
	});
	it("keeps Kernel scope authoritative and supports direct Work Item artifacts", () => {
		expect(
			resolveWorkstationArtifactScopeRunId({
				kernelRunId: "kernel",
				workItemId: "work",
			}),
		).toBe("kernel");
		expect(resolveWorkstationArtifactScopeRunId({ workItemId: "work" })).toBe(
			"work-item:work",
		);
	});
	it("does not duplicate a running bootstrap or retry a terminal timed-out bootstrap", async () => {
		for (const timedOut of [false, true]) {
			const f = nativeFixture();
			f.add("bootstrap-install");
			f.setReadiness(
				"packageJson=1\nnodeModules=1\nlockfile=bun.lock\nlockfileHash=" +
					"a".repeat(64) +
					"\ndepsReady=0\ninstallProcessId=bootstrap-install\n",
			);
			if (timedOut) f.finish({ code: 0, timedOut: true });
			const result = await f.request("wake", {});
			expect(result.body.bootstrap.installStatus).toBe(
				timedOut ? "timed_out" : "running",
			);
			expect(
				f.raw.launchExecution.mock.calls.some(([request]) =>
					request.metadata?.command.includes("bun install"),
				),
			).toBe(false);
		}
	});
	it("accepts an exact dependency marker only with a durable successful install receipt", async () => {
		const readiness =
			"packageJson=1\nnodeModules=1\nlockfile=bun.lock\nlockfileHash=" +
			"a".repeat(64) +
			"\ndepsReady=1\ninstallProcessId=bootstrap-install\n";
		const proven = nativeFixture();
		proven.setReadiness(readiness);
		proven.associations.set("bootstrap-install", {
			state: "terminal",
			executionId: "bootstrap-install",
			nativeId: "expired-native",
			exitCode: 0,
			startedAt: "2026-09-20T00:00:00Z",
			endedAt: "2026-09-20T00:00:01Z",
			timedOut: false,
		});
		proven.raw.getProcess.mockImplementation(async (id?: string) => {
			if (id === "expired-native") throw new Error("native process expired");
			return proven.handle;
		});
		const ready = await proven.request("wake", {});
		expect(ready.body.bootstrap).toMatchObject({
			depsReady: true,
			installStatus: "ready",
			nextAction: null,
		});
		expect(proven.raw.getProcess).not.toHaveBeenCalledWith("expired-native");

		const unknown = nativeFixture();
		unknown.setReadiness(readiness);
		unknown.associations.set("bootstrap-install", {
			state: "unknown",
			executionId: "bootstrap-install",
			observation: "unavailable",
		});
		const waiting = await unknown.request("wake", {});
		expect(waiting.body.bootstrap).toMatchObject({
			depsReady: false,
			installStatus: "running",
			nextAction: "wait_for_install_process",
		});
		expect(
			unknown.raw.launchExecution.mock.calls.some(([request]) =>
				request.metadata?.command.includes("bun install"),
			),
		).toBe(false);
	});
	it.each([
		{
			name: "nonzero exit",
			receipt: { exitCode: 1, timedOut: false },
			status: "failed",
		},
		{
			name: "timeout",
			receipt: { exitCode: 124, timedOut: true },
			status: "timed_out",
		},
		{
			name: "native error",
			receipt: {
				exitCode: null,
				timedOut: false,
				error: "native install failed",
			},
			status: "failed",
		},
	])(
		"does not let an old matching marker hide a retained $name",
		async ({ receipt, status }) => {
			const f = nativeFixture();
			f.setReadiness(
				"packageJson=1\nnodeModules=1\nlockfile=bun.lock\nlockfileHash=" +
					"a".repeat(64) +
					"\ndepsReady=1\ninstallProcessId=bootstrap-install\n",
			);
			f.associations.set("bootstrap-install", {
				state: "terminal",
				executionId: "bootstrap-install",
				nativeId: "expired-native",
				startedAt: "2026-09-20T00:00:00Z",
				endedAt: "2026-09-20T00:00:01Z",
				...receipt,
			});
			const result = await f.request("wake", {});
			expect(result.body.bootstrap).toMatchObject({
				depsReady: false,
				installStatus: status,
			});
			expect(
				f.raw.launchExecution.mock.calls.some(([request]) =>
					request.metadata?.command.includes("bun install"),
				),
			).toBe(false);
		},
	);
	it("requires matching dependency readiness before a typed test job", async () => {
		const f = nativeFixture();
		f.setReadiness(
			"packageJson=1\nnodeModules=1\nlockfile=bun.lock\nlockfileHash=" +
				"a".repeat(64) +
				"\ndepsReady=0\n",
		);
		const result = await f.request("process/start", {
			processId: "test",
			kind: "tests",
			command: "run-dangerous-test",
		});
		expect(result.status).toBe(409);
		expect(
			f.raw.launchExecution.mock.calls.some(
				([request]) => request.executionId === "test",
			),
		).toBe(false);
	});
});

describe("preflight admission readiness", () => {
	it.each([
		new CheckoutAdmissionPendingError("native-contention", "contention"),
		new CheckoutAdmissionPendingError("native-deadline", "observation"),
		new WorkstationDispatchUnknownError("native-unknown"),
	])(
		"keeps ambiguous preflight pending with its original identity: %s",
		async (failure) => {
			const f = nativeFixture();
			processMocks.ensureCleanRepoTreeForTurn.mockRejectedValue(failure);
			const response = await f.request("wake", { workItemId: "turn" });
			expect(response.body).toMatchObject({
				ok: true,
				ready: false,
				workstation: { status: "provisioning" },
				repoSync: { status: "syncing", executionId: failure.executionId },
			});
			expect(f.raw.destroy).not.toHaveBeenCalled();
		},
	);
	it.each([
		"Checkout lease authority changed",
		"Invalid native preflight marker",
		"Native prepared base does not match task authority",
	])("keeps definite preflight failures blocked: %s", async (error) => {
		const f = nativeFixture();
		processMocks.ensureCleanRepoTreeForTurn.mockRejectedValue(new Error(error));
		const response = await f.request("wake", { workItemId: "turn" });
		expect(response.body).toMatchObject({
			ok: false,
			ready: false,
			workstation: { status: "blocked" },
			repoSync: { status: "refused" },
		});
	});
});

describe("bootstrap and native preview policy", () => {
	const missing = `packageJson=1\nnodeModules=0\nlockfile=bun.lock\nlockfileHash=${"a".repeat(64)}\ndepsReady=0\n`;
	it("backs off a failed automatic dependency dispatch without a hot loop", async () => {
		const f = nativeFixture();
		f.setReadiness(missing);
		const original = f.raw.launchExecution.getMockImplementation()!;
		let installs = 0;
		f.raw.launchExecution.mockImplementation(async (request) => {
			if (request.metadata?.command.includes("bun install")) {
				installs++;
				throw new Error("dispatch unknown");
			}
			return original(request);
		});
		await f.request("wake", {});
		await Promise.all(bootstrapInstallInFlight.values());
		expect(installs).toBe(1);
		await f.request("wake", {});
		await Promise.all(bootstrapInstallInFlight.values());
		expect(installs).toBe(1);
	});
	it("refuses stale cache profiles and keeps failed native restoration outside the checkout", async () => {
		for (const stale of [true, false]) {
			const f = nativeFixture();
			f.setReadiness(missing);
			const profile = stale
				? "obsolete"
				: "cloudflare-sandbox-workstation:2026-06-28-v2-run-context:dependency-cache-v6";
			const record = {
				version: 3,
				cacheKey: `general:${profile}:bun:${"a".repeat(64)}`,
				profileId: "general",
				profileVersion: profile,
				packageManager: "bun",
				tediId: "tedi-1",
				lockfile: "bun.lock",
				lockfileHash: "a".repeat(64),
				workdir,
				nodeModulesDir: `${workdir}/node_modules`,
				backups: [
					{
						kind: "node_modules",
						dir: `${workdir}/node_modules`,
						backup: {
							id: "snapshot",
							dir: `${workdir}/node_modules`,
							localBucket: true,
						},
					},
				],
				createdAt: "2026-09-20T00:00:00Z",
			};
			f.storage.get.mockImplementation(async (key) =>
				key.includes("bootstrap-cache")
					? { text: async () => JSON.stringify(record) }
					: null,
			);
			f.raw.restoreBackup.mockRejectedValue(new Error("partial extraction"));
			await f.request("wake", {});
			await Promise.all(bootstrapInstallInFlight.values());
			if (stale) expect(f.raw.restoreBackup).not.toHaveBeenCalled();
			else {
				expect(f.raw.restoreBackup).toHaveBeenCalledTimes(1);
				expect(f.raw.restoreBackup).toHaveBeenCalledWith(
					expect.objectContaining({
						dir: expect.stringMatching(/cache-restore-[a-f0-9-]+\/0$/),
					}),
				);
				expect(
					f.raw.launchExecution.mock.calls.some(([r]) =>
						r.argv?.join(" ").includes(`rm -rf -- '${workdir}/node_modules'`),
					),
				).toBe(false);
			}
		}
	});
	it("observes an unknown cache publication by its original identity without restore replay or install fallback", async () => {
		const f = nativeFixture();
		f.setReadiness(missing);
		const profile =
			"cloudflare-sandbox-workstation:2026-06-28-v2-run-context:dependency-cache-v6";
		const record = {
			version: 3,
			cacheKey: `general:${profile}:bun:${"a".repeat(64)}`,
			profileId: "general",
			profileVersion: profile,
			packageManager: "bun",
			tediId: "tedi-1",
			lockfile: "bun.lock",
			lockfileHash: "a".repeat(64),
			workdir,
			nodeModulesDir: `${workdir}/node_modules`,
			backups: [
				{
					kind: "node_modules",
					dir: `${workdir}/node_modules`,
					backup: {
						id: "snapshot",
						dir: `${workdir}/node_modules`,
						localBucket: true,
					},
				},
			],
			createdAt: "2026-09-20T00:00:00Z",
		};
		f.storage.get.mockImplementation(async (key) =>
			key.includes("bootstrap-cache")
				? { text: async () => JSON.stringify(record) }
				: null,
		);
		const original = f.raw.exec.getMockImplementation()!;
		f.raw.exec.mockImplementation(async (argv) =>
			argv.join(" ").includes("Cache publication requires")
				? {
						...f.handle,
						output: vi.fn(async () => {
							throw new Error("lost publication response");
						}),
					}
				: original(argv),
		);
		const first = await f.request("wake", {});
		await Promise.all(bootstrapInstallInFlight.values());
		const publication = f.raw.launchExecution.mock.calls.find(
			([request]) => request.metadata?.command === "restore dependency cache",
		)?.[0];
		expect(publication?.executionId).toMatch(/^cache-restore-/);
		expect(JSON.stringify(first.body)).toContain(publication!.executionId);
		await f.request("wake", {});
		await Promise.all(bootstrapInstallInFlight.values());
		expect(f.raw.restoreBackup).toHaveBeenCalledTimes(1);
		expect(
			f.raw.launchExecution.mock.calls.filter(
				([request]) => request.metadata?.command === "restore dependency cache",
			),
		).toHaveLength(1);
		expect(
			f.raw.launchExecution.mock.calls.some(([request]) =>
				request.metadata?.command.includes("bun install"),
			),
		).toBe(false);
	});
	it("reports port readiness failure without replaying the native server", async () => {
		const f = nativeFixture();
		f.raw.containerFetch.mockRejectedValue(new Error("not listening"));
		const result = await f.request("dev-server", {
			command: "start-server",
			waitForPortMs: 1000,
		});
		expect(result.body.portReady).toBe(false);
		expect(result.body.ok).toBe(false);
		expect(
			f.raw.launchExecution.mock.calls.filter(
				([r]) => r.metadata?.command === "start-server",
			),
		).toHaveLength(1);
	});
});

it("leaves legacy and body-claimed terminal artifacts private", async () => {
	const f = nativeFixture();
	f.add("artifact-job", { kernelRunId: "child-run", workItemId: "work" });
	f.finish();
	const calls: Request[] = [];
	f.env.API_SERVICE = {
		fetch: vi.fn(async (request: Request) => {
			calls.push(request.clone());
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}),
	} as unknown as Fetcher;
	const result = await f.request("process/status", {
		processId: "artifact-job",
		conversationId: "forged:conversation",
		kernelRunId: "child-run",
	});
	expect(result.body.job.artifactRefs).toHaveLength(3);
	expect(result.body.job.artifactRowPersistence).toMatchObject({
		reason: "conversation_provenance_unavailable",
		status: "skipped",
	});
	expect(calls).toHaveLength(0);
	const legacyEvidence = result.body.job.evidence;
	f.storage.get.mockImplementation(async (key) =>
		key.endsWith("evidence.json")
			? { text: async () => JSON.stringify(legacyEvidence) }
			: { text: async () => "" },
	);
	const replay = await f.request("process/status", {
		processId: "artifact-job",
		conversationId: "forged:on-replay",
	});
	expect(replay.body.job.artifactRowPersistence).toMatchObject({
		status: "skipped",
	});
	expect(calls).toHaveLength(0);
});

it.each([
	{
		name: "verified runtime",
		headers: { "X-Service-Binding": "true", "X-Tedix-Tedi-Id": "tedi-1" },
		runId: "child-run",
		expected: true,
	},
	{
		name: "wrong tedi",
		headers: { "X-Service-Binding": "true", "X-Tedix-Tedi-Id": "other-tedi" },
		runId: "child-run",
		expected: false,
	},
	{
		name: "cross-run",
		headers: { "X-Service-Binding": "true", "X-Tedix-Tedi-Id": "tedi-1" },
		runId: "other-run",
		expected: false,
	},
])(
	"binds process conversation provenance only for $name",
	async ({ headers, runId, expected }) => {
		const f = nativeFixture();
		const started = await f.request(
			"process/start",
			{
				command: "printf test",
				kernelRunId: "child-run",
				processId: "artifact-job",
			},
			{
				...(headers as Record<string, string>),
				"X-Tedix-Workstation-Conversation-Id": "cto:home-child",
				"X-Tedix-Workstation-Run-Id": runId,
			},
		);
		expect(started.body.ok).toBe(true);
		const persisted = f.associations.get("artifact-job")?.metadata?.context;
		expect(persisted?.conversationId).toBe(expected ? "cto:home-child" : null);
		// The fixture's native process handle follows its pre-seeded association.
		// Rehydrate the exact start metadata through that handle for terminal readback.
		f.add("artifact-job", persisted ?? {});
		f.finish();
		const calls: Request[] = [];
		f.env.API_SERVICE = {
			fetch: vi.fn(async (request: Request) => {
				calls.push(request.clone());
				return new Response(JSON.stringify({ ok: true }), {
					headers: { "Content-Type": "application/json" },
				});
			}),
		} as unknown as Fetcher;
		const observed = await f.request("process/status", {
			processId: "artifact-job",
			conversationId: "forged:status",
		});
		const records = calls.filter((request) =>
			request.url.includes("cognitiveRuntime/recordArtifact"),
		);
		expect(records).toHaveLength(expected ? 3 : 0);
		expect(
			workstationSourceArtifactRefs(observed.body.job.artifactRefs),
		).toHaveLength(3);
		if (expected) {
			for (const request of records) {
				const data = (await request.json()) as {
					json: { conversationId: string; runId: string; tediId: string };
				};
				expect(data.json).toMatchObject({
					conversationId: "cto:home-child",
					runId: "child-run",
					tediId: "tedi-1",
				});
			}
		} else {
			expect(observed.body.job.artifactRowPersistence).toMatchObject({
				reason: "conversation_provenance_unavailable",
				status: "skipped",
			});
		}
	},
);

it("keeps canonical workstation source refs separate from generated artifact aliases", () => {
	const source =
		"r2://tedix-tedi-production/orgs/org/tedis/tedi/workstations/general/processes/job/terminal/stdout.log";
	expect(
		workstationSourceArtifactRefs([
			source,
			`artifact://run:artifact:workstation_process:job:stdout`,
			source,
			"https://attacker.example/log",
		]),
	).toEqual([source]);
});

it("does not register a process attributed to another tedi as the route owner", async () => {
	const f = nativeFixture();
	f.add("cross-owner", {
		conversationId: "other:conversation",
		kernelRunId: "other-run",
		participantTediId: "other-tedi",
	});
	f.finish();
	const fetch = vi.fn(async () => Response.json({ ok: true }));
	f.env.API_SERVICE = { fetch } as unknown as Fetcher;
	const result = await f.request("process/status", {
		processId: "cross-owner",
	});
	expect(result.body.job.artifactRowPersistence).toMatchObject({
		reason: "conversation_provenance_unavailable",
		status: "skipped",
	});
	expect(fetch).not.toHaveBeenCalled();
});

it("reuses fully persisted terminal artifact rows without republishing them", async () => {
	const f = nativeFixture();
	f.add("artifact-retry", {
		conversationId: "cto:home-child",
		kernelRunId: "kernel-run",
		participantTediId: "tedi-1",
	});
	f.finish();
	const calls: Request[] = [];
	f.env.API_SERVICE = {
		fetch: vi.fn(async (request: Request) => {
			calls.push(request.clone());
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}),
	} as unknown as Fetcher;
	const first = await f.request("process/status", {
		processId: "artifact-retry",
	});
	expect(calls).toHaveLength(3);
	const evidence = first.body.job.evidence;
	f.storage.get.mockImplementation(async (key) =>
		key.endsWith("evidence.json")
			? { text: async () => JSON.stringify(evidence) }
			: { text: async () => "" },
	);
	calls.length = 0;
	const retry = await f.request("process/status", {
		processId: "artifact-retry",
	});
	expect(retry.body.persistedEvidenceReadback).toBe(true);
	expect(retry.body.job.artifactRowPersistence).toEqual({
		reason: "evidence_already_persisted",
		status: "skipped",
	});
	expect(calls).toHaveLength(0);
});

it("reuses an authorized persisted cancellation without killing again", async () => {
	const f = nativeFixture();
	f.add();
	const first = await f.request("process/cancel", { processId: "job" });
	const evidence = first.body.job.evidence;
	f.storage.get.mockImplementation(async (key) =>
		key.endsWith("evidence.json")
			? { text: async () => JSON.stringify(evidence) }
			: { text: async () => "" },
	);
	f.raw.getProcess.mockClear();
	f.handle.kill.mockClear();
	const repeated = await f.request("process/cancel", { processId: "job" });
	expect(repeated.body.canceled).toBe(true);
	expect(f.raw.getProcess).not.toHaveBeenCalled();
	expect(f.handle.kill).not.toHaveBeenCalled();
});

describe("preparation egress identity", () => {
	const config = {
		id: "tedi-1",
		organizationId: "org-tedix",
		slug: "cto",
		secrets: {},
	} as AppEnv["Variables"]["tediConfig"];
	function context(
		selection: AppEnv["Variables"]["workstationRuntimeSelection"],
	) {
		const setOutboundPolicy = vi.fn(async () => {});
		const writeBodyGenerationProof = vi.fn();
		const values = {
			tediConfig: config,
			workstationRuntimeSelection: selection,
			sandbox: { setOutboundPolicy },
			runtimeBodyLauncher: { writeBodyGenerationProof },
		};
		return {
			c: {
				get: (key: string) => values[key as keyof typeof values],
				set: vi.fn(),
			} as unknown as Parameters<typeof ensureWorkstationEgressGuard>[0],
			setOutboundPolicy,
			writeBodyGenerationProof,
		};
	}
	it("keeps episode identity on repeated pre-boot policy installation", async () => {
		const selection = {
			leaseId: "wl_general_org-tedix_cto_episode_computer-123",
			workstationId: "ws_general_org-tedix_cto_episode_computer-123",
			participantTediId: "participant-tedi",
			workItemId: "work-123",
		};
		const f = context(selection);
		await ensureWorkstationEgressGuard(f.c);
		await ensureWorkstationEgressGuard(f.c);
		for (const call of f.setOutboundPolicy.mock.calls) {
			expect(call).toEqual([
				expect.objectContaining({
					leaseId: selection.leaseId,
					workstationId: selection.workstationId,
					tediId: selection.participantTediId,
					workItemId: selection.workItemId,
					tedixAllowedHosts: ["__tedix-egress-deny-all__.invalid"],
				}),
			]);
		}
		expect(f.setOutboundPolicy).toHaveBeenCalledTimes(2);
		expect(f.writeBodyGenerationProof).not.toHaveBeenCalled();
	});
	it("retains the generic fallback only when no body selection exists", async () => {
		const f = context(null);
		await ensureWorkstationEgressGuard(f.c);
		expect(f.setOutboundPolicy).toHaveBeenCalledWith(
			expect.objectContaining({
				leaseId: "wl_general_org-tedix_cto",
				workstationId: "ws_general_org-tedix_cto",
				tediId: "tedi-1",
			}),
		);
	});
});
