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
	startCmsPreviewExec,
	readCmsPreviewExecStatus,
	cancelCmsPreviewExec,
} from "./preview-exec-runner";
describe("CMS native preview command", () => {
	it("uses explicit shell argv and lifetime timeout", async () => {
		const f = fixture();
		await startCmsPreviewExec(f.sandbox, {
			jobId: "one",
			command: "printf ok",
			timeoutMs: 3000,
		});
		expect(f.launchCmsJob).toHaveBeenCalledWith(
			"preview-exec:one",
			["bash", "-lc", "printf ok"],
			{ cwd: "/workspace", timeout: 3000 },
			false,
		);
	});
	it("keeps running work running despite an expired local observation threshold", async () => {
		const f = fixture();
		expect(
			(await readCmsPreviewExecStatus(f.sandbox, "one", { timeoutMs: 1 }))
				.running,
		).toBe(true);
		expect(f.kill).not.toHaveBeenCalled();
	});
	it.each([
		[124, false, "failed"],
		[124, true, "timeout"],
		[0, false, "complete"],
	] as const)(
		"classifies exit %s with native timeout %s",
		async (code, timedOut, status) => {
			const f = fixture({ state: "exited", code, timedOut });
			expect((await readCmsPreviewExecStatus(f.sandbox, "one")).status).toBe(
				status,
			);
		},
	);
	it("cancels through the handle", async () => {
		const f = fixture();
		expect((await cancelCmsPreviewExec(f.sandbox, "one")).status).toBe(
			"cancelled",
		);
		expect(f.kill).toHaveBeenCalledOnce();
	});
	it("rejects an empty command before dispatch", async () => {
		const f = fixture();
		await expect(
			startCmsPreviewExec(f.sandbox, { command: " " }),
		).rejects.toThrow("required");
		expect(f.launchCmsJob).not.toHaveBeenCalled();
	});
});

it("keeps terminal duration fixed when observed later", async () => {
	const f = fixture({ state: "exited", code: 0, stdout: '{"commit":"abc"}' });
	const state = await f.process.status();
	const now = vi
		.spyOn(Date, "now")
		.mockReturnValue(Date.parse(state.startedAt) + 600_000);
	try {
		const result = await readCmsPreviewExecStatus(f.sandbox, "one");
		expect(result.durationMs).toBe(
			state.state === "running"
				? null
				: Date.parse(state.endedAt!) - Date.parse(state.startedAt),
		);
	} finally {
		now.mockRestore();
	}
});
