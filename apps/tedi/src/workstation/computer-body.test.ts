import { describe, expect, it, vi } from "vite-plus/test";
import {
	workstationExec,
	workstationStart,
	workstationWait,
	workstationExecutionStatus,
	type WorkstationRuntimeBody,
} from "./computer-body";
vi.mock("@cloudflare/sandbox", () => ({
	ProcessWaitTimeoutError: class extends Error {},
}));
function fixture() {
	const process = {
		output: vi.fn(async () => ({
			stdout: "hello",
			stderr: "",
			exitCode: 0,
			timedOut: false,
			truncated: false,
		})),
		waitForExit: vi.fn(async () => ({ code: 0, timedOut: false })),
		status: vi.fn(async () => ({
			state: "exited",
			startedAt: "start",
			endedAt: "end",
			exit: { code: 124, timedOut: false },
		})),
	};
	const body = {
		launchExecution: vi.fn(async () => ({
			state: "started",
			executionId: "logical",
			nativeId: "native",
		})),
		readExecutionAssociation: vi.fn(async () => ({
			state: "started",
			executionId: "logical",
			nativeId: "native",
		})),
		getProcess: vi.fn(async () => process),
	};
	return { process, body, client: body as unknown as WorkstationRuntimeBody };
}
describe("native workstation execution", () => {
	it("uses associated native identity and explicit bounded output", async () => {
		const { client, body, process } = fixture();
		const result = await workstationExec(client, "echo hello", {
			executionId: "logical",
			timeout: 100,
		});
		expect(body.launchExecution).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "logical",
				argv: ["/bin/bash", "-lc", "echo hello"],
			}),
		);
		expect(body.getProcess).toHaveBeenCalledWith("native");
		expect(process.output).toHaveBeenCalledWith({
			encoding: "utf8",
			maxBytes: 16 * 1024 * 1024,
			timeout: 100,
		});
		expect(result.stdout).toBe("hello");
	});
	it("never observes or redispatches an ambiguous launch", async () => {
		const { client, body } = fixture();
		body.launchExecution.mockResolvedValue({ state: "unknown" } as never);
		await expect(
			workstationStart(client, "echo hello", { processId: "logical" }),
		).rejects.toThrow("unknown");
		expect(body.getProcess).not.toHaveBeenCalled();
		expect(body.launchExecution).toHaveBeenCalledTimes(1);
	});
	it("retains native timeout provenance rather than inferring from exit124", async () => {
		const { client } = fixture();
		expect(
			await workstationExecutionStatus(client, "logical", {
				includeLogs: false,
			}),
		).toMatchObject({
			terminal: true,
			exitCode: 124,
			timedOut: false,
			startedAt: "start",
			endedAt: "end",
		});
	});
	it("uses a durable terminal association after the native process disappears", async () => {
		const { client, body } = fixture();
		body.readExecutionAssociation.mockResolvedValue({
			state: "terminal",
			executionId: "logical",
			nativeId: "native",
			exitCode: 0,
			startedAt: "start",
			endedAt: "end",
			timedOut: false,
		} as never);
		body.getProcess.mockRejectedValue(new Error("expired"));
		await expect(
			workstationExecutionStatus(client, "logical", { includeLogs: false }),
		).resolves.toMatchObject({
			observation: "terminal",
			terminal: true,
			exitCode: 0,
		});
		expect(body.getProcess).not.toHaveBeenCalled();
	});
	it("reads bounded logs from a retained terminal process without weakening terminal status", async () => {
		const { client, body, process } = fixture();
		body.readExecutionAssociation.mockResolvedValue({
			state: "terminal",
			executionId: "logical",
			nativeId: "native",
			exitCode: 0,
			timedOut: false,
		} as never);
		await expect(
			workstationExecutionStatus(client, "logical"),
		).resolves.toMatchObject({
			terminal: true,
			exitCode: 0,
			stdout: "hello",
		});
		expect(process.output).toHaveBeenCalledWith({
			encoding: "utf8",
			maxBytes: 16 * 1024 * 1024,
			timeout: 10_000,
		});
		process.output.mockRejectedValue(new Error("logs expired"));
		await expect(
			workstationExecutionStatus(client, "logical"),
		).resolves.toMatchObject({
			terminal: true,
			exitCode: 0,
			error: "Native execution logs unavailable",
		});
	});
	it("reports missing native process as unavailable without launching", async () => {
		const { client, body } = fixture();
		body.getProcess.mockResolvedValue(null as never);
		expect(await workstationExecutionStatus(client, "logical")).toMatchObject({
			observation: "unavailable",
			terminal: false,
		});
		expect(body.launchExecution).not.toHaveBeenCalled();
	});
	it("ends an unanswered observation without killing or re-launching", async () => {
		vi.useFakeTimers();
		try {
			const { client, body, process } = fixture();
			process.waitForExit.mockReturnValue(new Promise(() => {}));
			const result = workstationWait(client, "logical", 10);
			await vi.advanceTimersByTimeAsync(10);
			expect(await result).toEqual({
				terminal: false,
				observation: "unavailable",
			});
			expect(body.launchExecution).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

it("preserves a proven terminal exit when diagnostic output is unavailable", async () => {
	const f = fixture();
	f.process.output.mockRejectedValue(new Error("logs expired"));
	expect(
		await workstationExecutionStatus(f.client, "logical", {
			includeLogs: true,
		}),
	).toMatchObject({
		terminal: true,
		exitCode: 124,
		error: "Native execution logs unavailable",
	});
});
