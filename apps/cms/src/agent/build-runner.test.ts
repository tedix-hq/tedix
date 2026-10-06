import type {
	NativeProcess as NativeProcess,
	NativeProcessStatus as ProcessStatus,
} from "@tedix/container-runtime/sandbox";
import { describe, it, expect, vi } from "vite-plus/test";
import type { CmsJobClient } from "../sandbox";
import { CmsUnknownProcessOutcomeError } from "./cms-restore-permit";

function fixture(
	options: {
		state?: "running" | "exited" | "error";
		code?: number;
		timedOut?: boolean;
		signal?: number;
		stdout?: string;
		stderr?: string;
		missing?: boolean;
		truncated?: boolean;
	} = {},
) {
	const base = {
		id: "native-123",
		pid: 123,
		command: ["bun", "run", "build"] as const,
		startedAt: new Date(Date.now() - 1000).toISOString(),
	};
	let state: ProcessStatus =
		options.state === "error"
			? {
					...base,
					state: "error",
					error: { code: "SPAWN", message: "failed" },
					endedAt: new Date().toISOString(),
				}
			: options.state === "exited"
				? {
						...base,
						state: "exited",
						exit: {
							code: options.code ?? 0,
							timedOut: options.timedOut ?? false,
							signal: options.signal,
						},
						endedAt: new Date().toISOString(),
					}
				: { ...base, state: "running" };
	const kill = vi.fn(async () => {
		state = {
			...base,
			state: "exited",
			exit: { code: 143, signal: 15, timedOut: false },
			endedAt: new Date().toISOString(),
		};
	});
	const logSnapshot = vi.fn(async () => ({
		stdout: options.stdout ?? "",
		stderr: options.stderr ?? "",
		truncated: options.truncated ?? false,
	}));
	const waitForPort = vi.fn(async () => {});
	const process = {
		id: base.id,
		pid: 123,
		status: async () => state,
		logSnapshot,
		kill,
		waitForPort,
		waitForExit: async () => ({ code: 143, signal: 15, timedOut: false }),
	} as unknown as NativeProcess;
	let mapped = !options.missing;
	const launchCmsJob = vi.fn(async (..._args: unknown[]) => {
		mapped = true;
		return process.id;
	});
	const sandbox = {
		getCmsJobId: async () => (mapped ? process.id : null),
		getProcess: async () => process,
		launchCmsJob,
	} satisfies CmsJobClient;
	return { sandbox, process, kill, logSnapshot, waitForPort, launchCmsJob };
}
import {
	CMS_BUILD_OBSERVATION_GRACE_MS,
	CMS_BUILD_CONTROL_RPC_TIMEOUT_MS,
	startCmsSandboxBuild,
	readCmsSandboxBuildStatus,
	cancelCmsSandboxBuild,
	runCmsSandboxBuildToCompletion,
} from "./build-runner";
describe("CMS native build processes", () => {
	it("launches argv with only public build env and the lifetime limit", async () => {
		const f = fixture();
		const launch = await startCmsSandboxBuild(f.sandbox, {
			jobId: "build-1",
			orgSlug: "acme",
			publicSiteUrl: "https://www.acme.example",
			publicPathPrefix: "/journal",
			privacyBannerEnabled: true,
		});
		expect(launch.processId).toBe("native-123");
		expect(launch).not.toHaveProperty("sessionId");
		expect(f.launchCmsJob).toHaveBeenCalledWith(
			"build:build-1",
			["bun", "run", "build"],
			{
				cwd: "/workspace",
				env: {
					ORG_SLUG: "acme",
					PRIVACY_BANNER_ENABLED: "true",
					PUBLIC_SITE_URL: "https://www.acme.example",
					PUBLIC_PATH_PREFIX: "/journal",
				},
				timeout: 480000,
			},
			false,
		);
	});
	it("rejects missing or unsafe tenant public build routes before launch", async () => {
		const f = fixture();
		for (const options of [
			{ orgSlug: "acme" },
			{ orgSlug: "acme", publicSiteUrl: "http://acme.example" },
			{ orgSlug: "acme", publicSiteUrl: "https://acme.example/path" },
			{
				orgSlug: "acme",
				publicSiteUrl: "https://acme.example",
				publicPathPrefix: "/../other",
			},
		]) {
			await expect(startCmsSandboxBuild(f.sandbox, options)).rejects.toThrow();
		}
		expect(f.launchCmsJob).not.toHaveBeenCalled();
	});
	it("does not retain a process fence for deterministic prelaunch validation", async () => {
		const f = fixture();
		const invalid = await runCmsSandboxBuildToCompletion(f.sandbox, {
			jobId: "invalid job id",
		}).catch((error: unknown) => error);
		expect(invalid).toBeInstanceOf(Error);
		expect(invalid).not.toBeInstanceOf(CmsUnknownProcessOutcomeError);
		expect(f.launchCmsJob).not.toHaveBeenCalled();
	});
	it.each([
		[0, false, undefined, "complete"],
		[1, false, undefined, "failed"],
		[124, false, undefined, "failed"],
		[124, true, undefined, "timeout"],
		[143, false, 15, "cancelled"],
	] as const)(
		"classifies native exit %s without guessing timeout",
		async (code, timedOut, signal, expected) => {
			const f = fixture({ state: "exited", code, timedOut, signal });
			expect((await readCmsSandboxBuildStatus(f.sandbox, "one")).status).toBe(
				expected,
			);
		},
	);
	it("does not kill running work when an observer supplies a shorter timeout", async () => {
		const f = fixture();
		expect(
			(await readCmsSandboxBuildStatus(f.sandbox, "one", { buildTimeoutMs: 1 }))
				.running,
		).toBe(true);
		expect(f.kill).not.toHaveBeenCalled();
	});
	it("observes a lingering Astro process without killing it or forcing exit zero", async () => {
		const f = fixture({ stdout: "[build] Complete!" });
		for (let i = 0; i < 2; i++) {
			expect(await readCmsSandboxBuildStatus(f.sandbox, "one")).toMatchObject({
				status: "running",
				running: true,
				exitCode: null,
				successMarkerDetected: true,
			});
		}
		expect(f.kill).not.toHaveBeenCalled();
	});
	it("keeps explicit cancellation terminal after an Astro completion marker", async () => {
		const f = fixture({ stdout: "[build] Complete!" });
		expect(await cancelCmsSandboxBuild(f.sandbox, "one")).toMatchObject({
			status: "cancelled",
			exitCode: 143,
			cancelled: true,
			successMarkerDetected: true,
		});
		expect((await readCmsSandboxBuildStatus(f.sandbox, "one")).status).toBe(
			"cancelled",
		);
	});
	it("owner completion preserves a natural nonzero exit after a completion marker", async () => {
		const f = fixture({ stdout: "[build] Complete!" });
		const initial = await f.process.status();
		const status = vi
			.fn()
			.mockResolvedValueOnce(initial)
			.mockResolvedValueOnce(initial)
			.mockResolvedValue({
				...initial,
				state: "exited",
				endedAt: new Date().toISOString(),
				exit: { code: 1, timedOut: false },
			});
		const sandbox = {
			...f.sandbox,
			getProcess: async () => ({ ...f.process, status }) as NativeProcess,
		};
		expect(
			await runCmsSandboxBuildToCompletion(sandbox, {
				jobId: "one",
				pollMs: 0,
			}),
		).toMatchObject({
			status: "failed",
			exitCode: 1,
			successMarkerDetected: true,
		});
		expect(f.kill).not.toHaveBeenCalled();
	});

	it("does not hide a nonzero exit behind a success marker", async () => {
		const f = fixture({
			state: "exited",
			code: 1,
			stdout: "[build] Complete!",
		});
		expect((await readCmsSandboxBuildStatus(f.sandbox, "one")).status).toBe(
			"failed",
		);
	});
	it("returns an already-exited build without a polling delay", async () => {
		const f = fixture({ state: "exited" });
		expect(
			(await runCmsSandboxBuildToCompletion(f.sandbox, { jobId: "one" }))
				.status,
		).toBe("complete");
	});
	it("reports an unobserved native process without killing it", async () => {
		vi.useFakeTimers();
		try {
			const f = fixture();
			const observation = runCmsSandboxBuildToCompletion(f.sandbox, {
				jobId: "one",
				buildTimeoutMs: 1,
				pollMs: 1000,
			});
			const failure = expect(observation).rejects.toThrow(
				"CMS build completion observation expired; process outcome remains running",
			);
			await vi.advanceTimersByTimeAsync(CMS_BUILD_OBSERVATION_GRACE_MS + 1001);
			await failure;
			expect(f.kill).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
	it("keeps a launched process fenced when its lookup fails", async () => {
		const f = fixture();
		const sandbox = {
			...f.sandbox,
			getProcess: vi.fn(async () => {
				throw new Error("Sandbox control unavailable");
			}),
		};
		await expect(
			runCmsSandboxBuildToCompletion(sandbox, { jobId: "one" }),
		).rejects.toBeInstanceOf(CmsUnknownProcessOutcomeError);
		expect(f.launchCmsJob).toHaveBeenCalledOnce();
		expect(f.kill).not.toHaveBeenCalled();
	});
	it("keeps a launched process fenced when status observation fails", async () => {
		const f = fixture();
		const initialStatus = await f.process.status();
		const process = {
			...f.process,
			status: vi
				.fn()
				.mockResolvedValueOnce(initialStatus)
				.mockRejectedValueOnce(new Error("status RPC unavailable")),
		} as NativeProcess;
		const sandbox = {
			...f.sandbox,
			getProcess: vi.fn(async () => process),
		};
		await expect(
			runCmsSandboxBuildToCompletion(sandbox, { jobId: "one" }),
		).rejects.toBeInstanceOf(CmsUnknownProcessOutcomeError);
		expect(f.kill).not.toHaveBeenCalled();
	});
	it.each(["launch", "status"])(
		"bounds an unresponsive %s control RPC without killing native work",
		async (phase) => {
			vi.useFakeTimers();
			try {
				const f = fixture();
				const sandbox =
					phase === "launch"
						? {
								...f.sandbox,
								launchCmsJob: vi.fn(
									async () => new Promise<string>(() => undefined),
								),
							}
						: {
								...f.sandbox,
								getCmsJobId: vi.fn(
									async () => new Promise<string>(() => undefined),
								),
							};
				const observation = runCmsSandboxBuildToCompletion(sandbox, {
					jobId: "one",
				});
				const failure = expect(observation).rejects.toBeInstanceOf(
					CmsUnknownProcessOutcomeError,
				);
				await vi.advanceTimersByTimeAsync(CMS_BUILD_CONTROL_RPC_TIMEOUT_MS);
				await failure;
				expect(f.kill).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		},
	);
	it("cancels a native process and observes its terminal state", async () => {
		const f = fixture();
		expect((await cancelCmsSandboxBuild(f.sandbox, "one")).cancelled).toBe(
			true,
		);
		expect(f.kill).toHaveBeenCalledOnce();
	});
	it("replays only current logs and reports truncation", async () => {
		const f = fixture({ stdout: "a".repeat(70000), truncated: true });
		const snapshot = await readCmsSandboxBuildStatus(f.sandbox, "one");
		expect(snapshot.logTail).toContain("truncated");
		expect(f.logSnapshot).toHaveBeenCalled();
	});
});

it("keeps terminal duration fixed when observed later", async () => {
	const f = fixture({ state: "exited", code: 0, stdout: '{"commit":"abc"}' });
	const state = await f.process.status();
	const now = vi
		.spyOn(Date, "now")
		.mockReturnValue(Date.parse(state.startedAt) + 600_000);
	try {
		const result = await readCmsSandboxBuildStatus(f.sandbox, "one");
		expect(result.durationMs).toBe(
			state.state === "running"
				? null
				: Date.parse(state.endedAt!) - Date.parse(state.startedAt),
		);
	} finally {
		now.mockRestore();
	}
});
