import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const fixture = vi.hoisted(() => ({
	rows: new Map<string, unknown>(),
	exec: vi.fn(),
	getProcess: vi.fn(),
	failStarted: false,
}));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("@cloudflare/sandbox", () => ({
	DirectoryBackup: class {},
}));
vi.mock("@tedix/container-runtime/sandbox", () => ({
	NativeContainerSandbox: class {
		env = {};
		container = { running: false };
		ctx = {
			id: { name: "test", toString: () => "test" },
			storage: {
				get: async (key: string) => fixture.rows.get(key),
				put: async (key: string, value: { state: string }) => {
					if (fixture.failStarted && value.state === "started")
						throw new Error("storage unavailable");
					fixture.rows.set(key, value);
				},
				transaction: async (callback: (storage: unknown) => unknown) =>
					callback(this.ctx.storage),
			},
		};
		startProcess = fixture.exec;
		getProcess = fixture.getProcess;
	},
}));
vi.mock("./egress", () => ({ outboundEgressHandler: vi.fn() }));
import { TediWorkstationRuntimeSandbox } from "./index";
const request = {
	executionId: "logical",
	argv: ["echo", "hello"] as [string, ...string[]],
};
const host = () =>
	new TediWorkstationRuntimeSandbox(
		{ exports: { DirectoryBackupGateway: {} } } as never,
		{} as never,
	);
beforeEach(() => {
	fixture.rows.clear();
	fixture.exec.mockReset();
	fixture.exec.mockResolvedValue({ id: "native" });
	fixture.getProcess.mockReset();
	fixture.getProcess.mockResolvedValue({
		status: vi.fn(async () => ({ state: "running", startedAt: "start" })),
	});
	fixture.failStarted = false;
});
describe("durable native launch association", () => {
	it("persists before dispatch and resolves replay after a DO restart without relaunch", async () => {
		fixture.exec.mockImplementation(async () => {
			expect(fixture.rows.get("execution:logical")).toMatchObject({
				state: "dispatching",
			});
			return { id: "native" };
		});
		expect(await host().launchExecution(request)).toMatchObject({
			state: "started",
			nativeId: "native",
		});
		expect(await host().launchExecution(request)).toMatchObject({
			state: "started",
			nativeId: "native",
		});
		expect(fixture.exec).toHaveBeenCalledTimes(1);
	});
	it("never duplicates an in-flight launch", async () => {
		let complete!: (value: { id: string }) => void;
		fixture.exec.mockReturnValue(
			new Promise((resolve) => {
				complete = resolve;
			}),
		);
		const instance = host();
		const first = instance.launchExecution(request);
		await vi.waitFor(() => expect(fixture.exec).toHaveBeenCalledTimes(1));
		expect(await host().launchExecution(request)).toMatchObject({
			state: "unknown",
		});
		complete({ id: "native" });
		expect(await first).toMatchObject({ state: "started", nativeId: "native" });
		expect(fixture.exec).toHaveBeenCalledTimes(1);
	});

	it("retains ambiguous dispatch when native launch rejects", async () => {
		fixture.exec.mockRejectedValue(new Error("connection lost after launch"));
		expect(await host().launchExecution(request)).toMatchObject({
			state: "unknown",
		});
		expect(await host().launchExecution(request)).toMatchObject({
			state: "unknown",
		});
		expect(fixture.exec).toHaveBeenCalledTimes(1);
	});
	it("does not repeat a successful process whose native ID could not be persisted", async () => {
		fixture.failStarted = true;
		expect(await host().launchExecution(request)).toMatchObject({
			state: "unknown",
		});
		fixture.failStarted = false;
		expect(await host().launchExecution(request)).toMatchObject({
			state: "unknown",
		});
		expect(fixture.exec).toHaveBeenCalledTimes(1);
	});
	it("rejects logical ID reuse with changed input and retains authority metadata", async () => {
		const metadata = {
			command: "echo hello",
			cwd: "/workspace",
			context: { leaseId: "lease" },
			timeoutMs: null,
		};
		await host().launchExecution({ ...request, metadata });
		expect(await host().readExecutionAssociation("logical")).toMatchObject({
			metadata,
		});
		await expect(
			host().launchExecution({ ...request, argv: ["echo", "different"] }),
		).rejects.toThrow("different launch arguments");
		expect(fixture.exec).toHaveBeenCalledTimes(1);
	});
	it("durably seals a terminal observation for reads after the native process disappears", async () => {
		await host().launchExecution(request);
		fixture.getProcess.mockResolvedValue({
			status: vi.fn(async () => ({
				state: "exited",
				startedAt: "start",
				endedAt: "end",
				exit: { code: 0, timedOut: false, signal: 0 },
			})),
		});
		expect(await host().readExecutionAssociation("logical")).toMatchObject({
			state: "terminal",
			nativeId: "native",
			exitCode: 0,
			startedAt: "start",
			endedAt: "end",
			timedOut: false,
		});
		fixture.getProcess.mockRejectedValue(new Error("native process expired"));
		expect(await host().readExecutionAssociation("logical")).toMatchObject({
			state: "terminal",
			exitCode: 0,
		});
	});
	it("retains terminal failure and timeout provenance immutably", async () => {
		await host().launchExecution(request);
		fixture.getProcess.mockResolvedValue({
			status: vi.fn(async () => ({
				state: "exited",
				startedAt: "start",
				endedAt: "end",
				exit: { code: 124, timedOut: true, signal: 9 },
			})),
		});
		await expect(
			host().readExecutionAssociation("logical"),
		).resolves.toMatchObject({
			state: "terminal",
			exitCode: 124,
			timedOut: true,
			signal: 9,
		});
		fixture.getProcess.mockResolvedValue({
			status: vi.fn(async () => ({
				state: "exited",
				exit: { code: 0, timedOut: false, signal: 0 },
			})),
		});
		await expect(
			host().readExecutionAssociation("logical"),
		).resolves.toMatchObject({
			exitCode: 124,
			timedOut: true,
		});
	});
});

describe("workstation exception diagnostics", () => {
	it("retains the cause chain without logging thrown content or changing launch recovery", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			fixture.exec.mockRejectedValue(
				new Error("secret launch payload", {
					cause: new TypeError("token from container"),
				}),
			);
			expect(await host().launchExecution(request)).toMatchObject({
				state: "unknown",
				observation: "unavailable",
			});
			expect(log).toHaveBeenCalledWith({
				component: "tedi.workstation.runtime",
				event: "native_launch_unconfirmed",
				message:
					"workstation native launch outcome could not be durably confirmed",
				exception: { type: "Error", cause: { type: "TypeError" } },
			});
			expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|token|stack/);
		} finally {
			log.mockRestore();
		}
	});
});
