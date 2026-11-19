import type {
	NativeProcess as NativeProcess,
	NativeProcessStatus as ProcessStatus,
} from "@tedix/container-runtime/sandbox";
import { describe, it, expect, vi } from "vite-plus/test";
import type { CmsJobClient } from "../sandbox";

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
	startThemeArtifactRepoSeed,
	readThemeArtifactRepoSeedStatus,
	cancelThemeArtifactRepoSeed,
	themeArtifactCommitSandbox,
	type ThemeArtifactSeedContext,
} from "./theme-artifacts";
function context(f: ReturnType<typeof fixture>) {
	const writeFile = vi.fn(async () => undefined);
	const ctx = {
		orgSlug: "acme",
		sandbox: { ...f.sandbox, writeFile },
		artifactCommitSandbox: () => ctx.sandbox,
	};
	return {
		ctx: ctx as unknown as ThemeArtifactSeedContext,
		writeFile,
	};
}
describe("CMS native artifact seed", () => {
	it("keeps old commit jobs on their original disk", () => {
		const f = fixture();
		const { ctx } = context(f);
		expect(themeArtifactCommitSandbox(ctx, "tas-old-job")).toBe(ctx.sandbox);
	});

	it("keeps tokens and remote credentials out of argv", async () => {
		const f = fixture();
		const { ctx, writeFile } = context(f);
		const result = await startThemeArtifactRepoSeed(ctx, {
			jobId: "seed",
			branch: "main",
			forceSeed: false,
			token: "secret-token",
			remote: "https://private.example/repo",
		});
		expect(result.processId).toBe("native-123");
		expect(result).not.toHaveProperty("sessionId");
		expect(writeFile).toHaveBeenCalledTimes(3);
		expect(JSON.stringify(f.launchCmsJob.mock.calls)).not.toContain(
			"secret-token",
		);
		expect(JSON.stringify(f.launchCmsJob.mock.calls)).not.toContain(
			"private.example",
		);
		expect(JSON.stringify(writeFile.mock.calls)).toContain(
			"--exclude 'node_modules'",
		);
	});
	it("requires both native success and seed JSON", async () => {
		const f = fixture({ state: "exited", stdout: '{"commit":"abc"}' });
		expect(
			(await readThemeArtifactRepoSeedStatus(context(f).ctx.sandbox, "seed"))
				.status,
		).toBe("complete");
		const bad = fixture({ state: "exited", stdout: "not json" });
		expect(
			(await readThemeArtifactRepoSeedStatus(context(bad).ctx.sandbox, "seed"))
				.status,
		).toBe("failed");
	});
	it("honors native lifetime timeout", async () => {
		const f = fixture({ state: "exited", code: 124, timedOut: true });
		expect(
			(await readThemeArtifactRepoSeedStatus(context(f).ctx.sandbox, "seed"))
				.status,
		).toBe("timeout");
	});
	it("does not kill slow running seeds based on a read clock", async () => {
		const f = fixture();
		expect(
			(await readThemeArtifactRepoSeedStatus(context(f).ctx.sandbox, "seed"))
				.running,
		).toBe(true);
		expect(f.kill).not.toHaveBeenCalled();
	});
	it("cancels explicitly", async () => {
		const f = fixture();
		expect(
			(await cancelThemeArtifactRepoSeed(context(f).ctx.sandbox, "seed"))
				.cancelled,
		).toBe(true);
	});
});

it("keeps terminal duration fixed when observed later", async () => {
	const f = fixture({ state: "exited", code: 0, stdout: '{"commit":"abc"}' });
	const state = await f.process.status();
	const now = vi
		.spyOn(Date, "now")
		.mockReturnValue(Date.parse(state.startedAt) + 600_000);
	try {
		const result = await readThemeArtifactRepoSeedStatus(
			context(f).ctx.sandbox,
			"one",
		);
		expect(result.durationMs).toBe(
			state.state === "running"
				? null
				: Date.parse(state.endedAt!) - Date.parse(state.startedAt),
		);
	} finally {
		now.mockRestore();
	}
});
