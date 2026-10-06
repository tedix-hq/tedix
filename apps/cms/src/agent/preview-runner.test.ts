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
	startCmsPreview,
	readCmsPreviewStatus,
	stopCmsPreview,
} from "./preview-runner";
function previewClient(f: ReturnType<typeof fixture>) {
	return f.sandbox as Parameters<typeof startCmsPreview>[0];
}
describe("CMS native preview server", () => {
	it("launches one native process and waits for readiness", async () => {
		const f = fixture({ missing: true });
		const client = previewClient(f);
		const result = await startCmsPreview(client, {
			previewHostname: "example",
		});
		expect(result.running).toBe(true);
		expect(f.launchCmsJob).toHaveBeenCalledWith(
			"preview",
			["bunx", "astro", "dev", "--port", "4321", "--host", "0.0.0.0"],
			{ cwd: "/workspace" },
			true,
		);
		expect(f.waitForPort).toHaveBeenCalledWith(4321, { timeout: 90000 });
		expect(result).not.toHaveProperty("sessionId");
	});
	it("reuses a running process", async () => {
		const f = fixture();
		await startCmsPreview(previewClient(f), { previewHostname: "example" });
		expect(f.launchCmsJob).not.toHaveBeenCalled();
	});
	it("reads snapshots without waiting for process completion", async () => {
		const f = fixture({ stdout: "ready" });
		const result = await readCmsPreviewStatus(previewClient(f), {
			previewHostname: "example",
		});
		expect(result.logTail).toBe("ready");
		expect(f.logSnapshot).toHaveBeenCalled();
	});
	it("stops the native preview process", async () => {
		const f = fixture();
		expect((await stopCmsPreview(previewClient(f), "example")).running).toBe(
			false,
		);
		expect(f.kill).toHaveBeenCalledOnce();
	});
});
