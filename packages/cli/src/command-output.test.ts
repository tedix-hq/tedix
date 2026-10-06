import { describe, expect, mock, spyOn, test } from "bun:test";
import { type CommandContext, findCommand, reportSendResult } from "./commands";
import {
	printInspectBundle,
	printReadPayload,
	type TerminalOutput,
} from "./format";
import type { TedixHomeClient } from "./home-client";
import { InkReplBridge } from "./ink-bridge";

function context(output: TerminalOutput, client: unknown): CommandContext {
	return {
		output,
		client: client as TedixHomeClient,
		json: false,
		color: { enabled: false },
		conversationId: "conversation",
		follow: false,
		includeArchived: false,
		pollIntervalMs: 1,
		ops: {
			send: async () => ({ homeRunId: "run", assistantText: "done" }),
			inspect: async () => ({ homeRunId: "run", run: {}, summary: null }),
			childEvidence: async () => ({}),
			childTree: async () => ({}),
		},
	};
}

describe("explicit command output", () => {
	test("a pending command publishes immediately without capturing unrelated logs", async () => {
		let release!: (value: unknown) => void;
		const pending = new Promise((resolve) => {
			release = resolve;
		});
		const commits: string[] = [];
		let bridge!: InkReplBridge;
		const emit = (...args: unknown[]) =>
			bridge.commitLines("output", [args.map(String).join(" ")]);
		const ctx = context(
			{ log: emit, error: emit },
			{ cancelHomeRun: async () => ({}), readHomeRun: () => pending },
		);
		bridge = new InkReplBridge({
			getRegistryCount: () => 0,
			getRegistryList: () => [],
			waitAll: async () => {},
			getPanelStates: () => [],
			cancel: async () => {},
			dispatch: async () => {
				await findCommand("cancel")!.handler("run", ctx);
				return "handled";
			},
		});
		bridge.onUpdate((state) =>
			commits.push(...state.pendingCommits.flatMap((item) => item.lines)),
		);
		const log = spyOn(console, "log").mockImplementation(() => {});
		const error = console.error;
		try {
			const dispatched = bridge.dispatch("/cancel run");
			await Promise.resolve();
			expect(commits).toContain("Cancel requested for run.");
			expect(console.log).toBe(log);
			expect(console.error).toBe(error);
			console.log("unrelated background log");
			expect(log).toHaveBeenCalledWith("unrelated background log");
			expect(commits).not.toContain("unrelated background log");
			release({ run: { id: "run", status: "canceled" } });
			await dispatched;
			expect(
				commits.filter((line) => line === "Cancel requested for run."),
			).toHaveLength(1);
		} finally {
			release({});
			bridge.stop();
			log.mockRestore();
		}
	});

	test("nested inspection printers use the supplied destination", () => {
		const sink = {
			log: mock((..._args: unknown[]) => {}),
			error: mock((..._args: unknown[]) => {}),
		};
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			printInspectBundle(
				{
					homeRunId: "run",
					run: {},
					summary: {
						homeRunId: "run",
						status: "completed",
						assistantText: "result",
					},
				},
				false,
				{},
				sink,
			);
			const lines = sink.log.mock.calls
				.map((args) => args.join(" "))
				.join("\n");
			expect(lines).toContain("result");
			expect(lines).toContain("Trace evidence is unavailable");
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	test("JSON read output stays parseable at the explicit destination", () => {
		const sink = { log: mock((line: string) => {}), error: mock(() => {}) };
		printReadPayload(
			{ messages: [{ id: "message", content: "hello" }] },
			true,
			sink,
		);
		expect(JSON.parse(sink.log.mock.calls[0]![0])).toEqual({
			messages: [{ id: "message", content: "hello" }],
		});
		expect(sink.log).toHaveBeenCalledTimes(1);
	});

	test("send diagnostics preserve stdout and stderr separation", () => {
		const sink = {
			log: mock((line: string) => {}),
			error: mock((line: string) => {}),
		};
		const code = reportSendResult(
			{
				homeRunId: "run",
				status: "completed",
				assistantText: "Done",
				writeDeclined: { stage: "approval", detail: "No" },
			},
			context(sink, {}),
		);
		expect(code).toBe(2);
		expect(sink.log.mock.calls.flat().join("\n")).toContain("Done");
		expect(sink.error.mock.calls.flat().join("\n")).toContain(
			"Write not performed",
		);
	});
	test("event tails send individual NDJSON records to the supplied destination", async () => {
		const sink = { log: mock((_line: string) => {}), error: mock(() => {}) };
		const ctx = context(sink, {
			readHomeRunEvents: async () => ({
				events: [
					{ offset: "0", kind: "run_start" },
					{ offset: "1", kind: "run_completed" },
				],
				nextOffset: "2",
				status: "completed",
				upToDate: true,
			}),
			readHomeRun: async () => ({}),
		});
		ctx.json = true;
		expect(await findCommand("tail")!.handler("run", ctx)).toBe(0);
		expect(sink.log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
			{ offset: "0", kind: "run_start" },
			{ offset: "1", kind: "run_completed" },
		]);
	});

	test("a failed dispatch leaves the console untouched and clears thinking", async () => {
		const bridge = new InkReplBridge({
			getRegistryCount: () => 0,
			getRegistryList: () => [],
			waitAll: async () => {},
			getPanelStates: () => [],
			cancel: async () => {},
			dispatch: async () => {
				throw new Error("failed command");
			},
		});
		const log = console.log;
		const error = console.error;
		let thinking: number | null = null;
		bridge.onUpdate((state) => {
			thinking = state.thinkingSince;
		});
		try {
			await expect(bridge.dispatch("/inspect run")).rejects.toThrow(
				"failed command",
			);
			expect(console.log).toBe(log);
			expect(console.error).toBe(error);
			expect(thinking).toBeNull();
		} finally {
			bridge.stop();
		}
	});
});
