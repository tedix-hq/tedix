import { formatSendResult, printRunPayload } from "./commands";
import { describe, expect, spyOn, test } from "bun:test";
import {
	type CommandContext,
	exitCodeForStatus,
	findCommand,
	formatInteractiveCommandHelp,
	type HomeOps,
	interactiveSlashCommands,
	reportSendResult,
} from "./commands";
import type {
	HomeRunEventsPage,
	HomeRunSummary,
	TedixHomeClient,
} from "./home-client";

const noopOps: HomeOps = {
	childEvidence: async () => ({}),
	childTree: async () => ({}),
	inspect: async () => ({ homeRunId: "x", run: {}, summary: null }),
	send: async () => ({ assistantText: "", homeRunId: "x" }),
};

function makeContext(overrides?: Partial<CommandContext>): CommandContext {
	return {
		client: {} as TedixHomeClient,
		color: { enabled: false },
		conversationId: "home:cli:test",
		follow: false,
		includeArchived: false,
		json: true,
		ops: noopOps,
		pollIntervalMs: 5,
		...overrides,
	};
}

function captureStdout(fn: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const original = process.stdout.write;
	process.stdout.write = ((chunk: unknown) => {
		lines.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	return fn()
		.then(() => lines)
		.finally(() => {
			process.stdout.write = original;
		});
}

async function captureConsoleLogs(fn: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
	try {
		await fn();
		return lines;
	} finally {
		console.log = original;
	}
}

describe("@tedix/cli command registry", () => {
	test("exitCodeForStatus maps failures to 2 and the rest to 0", () => {
		expect(exitCodeForStatus("completed")).toBe(0);
		expect(exitCodeForStatus("requires_approval")).toBe(0);
		expect(exitCodeForStatus("running")).toBe(0);
		expect(exitCodeForStatus(undefined)).toBe(0);
		expect(exitCodeForStatus("failed")).toBe(2);
		expect(exitCodeForStatus("canceled")).toBe(2);
	});

	test("findCommand resolves registered commands and rejects unknowns", () => {
		expect(findCommand("tail")?.name).toBe("tail");
		expect(findCommand("inspect")?.name).toBe("inspect");
		expect(findCommand("approve")?.name).toBe("approve");
		expect(findCommand("goal")?.name).toBe("goal");
		expect(findCommand("goal-status")?.name).toBe("goal-status");
		expect(findCommand("nope")).toBeUndefined();
	});

	test("goal starts a bounded adversarial loop through gateway-native Code Mode", async () => {
		let source = "";
		const client = {
			runCode: async (value: string) => {
				source = value;
				return { workflowId: "goal-workflow-1" };
			},
		} as unknown as TedixHomeClient;
		const lines = await captureConsoleLogs(async () => {
			expect(
				await findCommand("goal")?.handler(
					"the answer is READY :: reply exactly READY",
					makeContext({ client, json: false }),
				),
			).toBe(0);
		});
		expect(source).toContain("kernel.start_goal_loop");
		expect(source).toContain('"maxTurns":3');
		expect(source).toContain('"budgetUsd":0.25');
		expect(source).toContain('"evaluator":"adversarial"');
		expect(lines.join("")).toContain("Goal loop started: goal-workflow-1");
	});

	test("goal honors explicit CLI ceilings and rejects unbounded shapes", async () => {
		let source = "";
		const client = {
			runCode: async (value: string) => {
				source = value;
				return { workflowId: "goal-workflow-2" };
			},
		} as unknown as TedixHomeClient;
		await captureConsoleLogs(async () => {
			await findCommand("goal")?.handler(
				"reply exactly READY",
				makeContext({
					client,
					goalBudgetUsd: 0.1,
					goalCondition: "the answer is READY",
					goalEvaluator: "deterministic",
					goalMaxTurns: 2,
					json: false,
				}),
			);
		});
		expect(source).toContain('"maxTurns":2');
		expect(source).toContain('"budgetUsd":0.1');
		expect(source).toContain('"evaluator":"deterministic"');
		await expect(
			findCommand("goal")?.handler(
				"reply exactly READY",
				makeContext({
					client,
					goalCondition: "the answer is READY",
					goalMaxTurns: 9,
				}),
			),
		).rejects.toThrow("between 1 and 8");
	});

	test("goal-status returns the workflow data without widget envelope noise", async () => {
		let source = "";
		const client = {
			runCode: async (value: string) => {
				source = value;
				return {
					executionId: "execution-1",
					result: {
						data: { id: "goal-workflow-1", status: "completed" },
						layoutSpec: { root: "widget" },
					},
				};
			},
		} as unknown as TedixHomeClient;
		const lines = await captureConsoleLogs(async () => {
			await findCommand("goal-status")?.handler(
				"goal-workflow-1",
				makeContext({ client, json: true }),
			);
		});
		expect(source).toContain("workflows.get_workflow_status");
		const parsed = JSON.parse(lines.join(""));
		expect(parsed).toEqual({ id: "goal-workflow-1", status: "completed" });
	});

	test("interactive help and typeahead use the TUI meanings for runs and rename", () => {
		const menu = interactiveSlashCommands();
		expect(menu.filter((command) => command.name === "runs")).toEqual([
			{
				argHint: "[prefix]",
				description: "List in-flight runs",
				name: "runs",
				source: "interactive",
			},
		]);
		expect(menu.filter((command) => command.name === "rename")).toEqual([
			{
				argHint: "<title>",
				description: "Rename this conversation",
				name: "rename",
				source: "interactive",
			},
		]);

		const help = formatInteractiveCommandHelp();
		expect(help).toContain("/runs [prefix]");
		expect(help).toContain("/rename <title>");
		expect(help).not.toContain("/runs [conversationId]");
		expect(help).not.toContain("/rename <conversationId> <title>");
		expect(help).toContain("/retry <workItemId>");
		expect(help).toContain("Stay here (Home)");
		expect(help).toContain("tools, skills, resources");
		expect(help).toContain(
			"discover.search({ query, limit: 1, includeParameters: true })",
		);
		expect(help).toContain("tedix flow run --file <plan.ts> --watch");
	});

	test("interactive typeahead exposes argument hints and command ownership", () => {
		const commands = interactiveSlashCommands();
		expect(
			commands.find((command) => command.name === "sessions"),
		).toMatchObject({
			argHint: "[search]",
			source: "interactive",
		});
		expect(
			commands.find((command) => command.name === "approve"),
		).toMatchObject({
			argHint: "<homeRunId> [note]",
			source: "home",
		});
	});

	test("traces with a run id reads the converged Home trace", async () => {
		let observedRunId = "";
		const client = {
			readHomeTrace: async (runId: string) => {
				observedRunId = runId;
				return { trace: { homeRunId: runId, complete: true } };
			},
		} as unknown as TedixHomeClient;
		const spec = findCommand("traces");
		await captureStdout(async () => {
			expect(await spec?.handler("run-123", makeContext({ client }))).toBe(0);
		});
		expect(observedRunId).toBe("run-123");
	});

	test("retry dispatches the blocked Work Item recovery surface", async () => {
		let observedWorkItemId = "";
		const client = {
			retryDelegation: async (workItemId: string) => {
				observedWorkItemId = workItemId;
				return { retryCount: 1 };
			},
		} as unknown as TedixHomeClient;
		const spec = findCommand("retry");
		await captureStdout(async () => {
			expect(await spec?.handler("work-123", makeContext({ client }))).toBe(0);
		});
		expect(observedWorkItemId).toBe("work-123");
	});

	test("approve follows the run it released and prints the answer", async () => {
		// The defect: an operator approved a delegation, the tedi ran three model
		// rounds and was billed for them, and the CLI printed the dispatch ack and
		// exited. `status` reports the run SET (what is in flight); the answer
		// lives in the conversation, which nothing read back.
		let reads = 0;
		const client = {
			respondHomeApproval: async () => ({ dispatched: true }),
			readHomeRun: async () => {
				reads += 1;
				return reads < 2
					? { run: { id: "run-1", status: "running" } }
					: {
							// `read_home_run` never carries assistantMessage; the answer
							// comes off the run the way the poll path reads it.
							run: {
								id: "run-1",
								status: "completed",
								metadata: {
									bodyExecutionResult: {
										summary:
											"Órdenes por estado: Facturado 101. Total: 218 órdenes.",
									},
								},
							},
						};
			},
		} as unknown as TedixHomeClient;
		const lines = await captureConsoleLogs(async () => {
			expect(
				await findCommand("approve")?.handler(
					"run-1",
					makeContext({ client, json: false, pollIntervalMs: 1 }),
				),
			).toBe(0);
		});
		expect(reads).toBeGreaterThan(1);
		expect(lines.join("\n")).toContain("218");
	});

	test("approve waits for nothing when rejecting or when told not to poll", async () => {
		// A rejection releases no work, and --no-poll is a deliberate
		// fire-and-forget. Neither should read the run back.
		let reads = 0;
		const client = {
			respondHomeApproval: async () => ({ dispatched: false }),
			readHomeRun: async () => {
				reads += 1;
				return { run: { id: "run-1", status: "completed" } };
			},
		} as unknown as TedixHomeClient;
		await captureStdout(async () => {
			expect(
				await findCommand("reject")?.handler(
					"run-1",
					makeContext({ client, json: false, pollIntervalMs: 1 }),
				),
			).toBe(0);
			expect(
				await findCommand("approve")?.handler(
					"run-1",
					makeContext({ client, json: false, poll: false, pollIntervalMs: 1 }),
				),
			).toBe(0);
		});
		expect(reads).toBe(0);
	});

	test("approve survives a follow-up read that fails", async () => {
		// The approval already succeeded. A broken read afterwards must not
		// report it as failed.
		const client = {
			respondHomeApproval: async () => ({ dispatched: true }),
			readHomeRun: async () => {
				throw new Error("gateway down");
			},
		} as unknown as TedixHomeClient;
		await captureStdout(async () => {
			expect(
				await findCommand("approve")?.handler(
					"run-1",
					makeContext({ client, json: false, pollIntervalMs: 1 }),
				),
			).toBe(0);
		});
	});

	test("cancel keeps the interactive acknowledgment calm and leaves settlement to the poller", async () => {
		const client = {
			cancelHomeRun: async () => ({
				homeRunId: "run-123",
				progressDetail: "no runtime events",
				status: "canceled",
			}),
			readHomeRun: async () => ({ homeRunId: "run-123", status: "canceled" }),
		} as unknown as TedixHomeClient;
		const lines = await captureConsoleLogs(async () => {
			expect(
				await findCommand("cancel")?.handler(
					"run-123 operator request",
					makeContext({ client, json: false }),
				),
			).toBe(0);
		});
		expect(lines).toEqual(["Cancel requested for run-123."]);
	});

	test("tail streams events as ndjson and exits 0 on a completed run", async () => {
		const page: HomeRunEventsPage = {
			events: [
				{ offset: "0", kind: "run_start" },
				{ offset: "1", kind: "run_completed" },
			],
			nextOffset: "2",
			status: "completed",
			upToDate: true,
		};
		const client = {
			readHomeRunEvents: async (): Promise<HomeRunEventsPage> => page,
			readHomeRun: async () => ({}),
		} as unknown as TedixHomeClient;
		const spec = findCommand("tail");
		expect(spec).toBeDefined();
		const ctx = makeContext({ client, follow: false, json: true });
		const lines = await captureStdout(async () => {
			const code = await spec?.handler("home-run-1", ctx);
			expect(code).toBe(0);
		});
		const parsed = lines.map((line) => JSON.parse(line));
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toMatchObject({ kind: "run_start", offset: "0" });
		expect(parsed[1]).toMatchObject({ kind: "run_completed", offset: "1" });
	});

	test("tail exits 2 when the run settles failed", async () => {
		const page: HomeRunEventsPage = {
			events: [{ offset: "0", kind: "run_failed" }],
			nextOffset: "1",
			status: "failed",
			upToDate: true,
		};
		const client = {
			readHomeRunEvents: async (): Promise<HomeRunEventsPage> => page,
			readHomeRun: async () => ({}),
		} as unknown as TedixHomeClient;
		const ctx = makeContext({ client, follow: false, json: true });
		await captureStdout(async () => {
			const code = await findCommand("tail")?.handler("home-run-2", ctx);
			expect(code).toBe(2);
		});
	});

	test("reportSendResult returns the settled exit code", () => {
		const base: HomeRunSummary = { assistantText: "done", homeRunId: "r1" };
		const completed = reportSendResult(
			{ ...base, status: "completed" },
			makeContext(),
		);
		expect(completed).toBe(0);
		const failed = reportSendResult(
			{ ...base, status: "failed" },
			makeContext(),
		);
		expect(failed).toBe(2);
	});

	test("reportSendResult does not repeat an approval after delegation resolved", async () => {
		const lines = await captureConsoleLogs(async () => {
			reportSendResult(
				{
					assistantText: "old ack",
					childRunId: "child-1",
					childRunPreview: "final result",
					delegationMode: "needs_approval",
					delegationStatus: "approved",
					homeRunId: "r-approved",
					status: "completed",
				},
				makeContext({ json: false }),
			);
		});
		const all = lines.join("\n");
		expect(all).toContain("final result");
		expect(all).not.toContain("needs your approval");
	});

	test("reportSendResult exits 3 and prints a follow-up notice for an unsettled polled run", () => {
		const base: HomeRunSummary = { assistantText: "", homeRunId: "r1" };
		const noticed: string[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) =>
			noticed.push(args.map(String).join(" "));
		try {
			const running = reportSendResult(
				{ ...base, status: "running" },
				makeContext(),
			);
			expect(running).toBe(3);
			const queued = reportSendResult(
				{ ...base, status: "queued" },
				makeContext({ poll: true }),
			);
			expect(queued).toBe(3);
		} finally {
			console.error = origError;
		}
		// json:true context routes the notice to stderr; it names the run and the
		// exact follow-up command.
		expect(noticed.join("\n")).toContain("still running");
		expect(noticed.join("\n")).toContain("tedix run r1");
		expect(noticed.join("\n")).toContain("not the final answer");
	});

	test("reportSendResult keeps exit 0 for an unsettled --no-poll dispatch", () => {
		const origError = console.error;
		console.error = () => {};
		try {
			const code = reportSendResult(
				{ assistantText: "", homeRunId: "r1", status: "running" },
				makeContext({ poll: false }),
			);
			expect(code).toBe(0);
		} finally {
			console.error = origError;
		}
	});
});

describe("send result formatting", () => {
	test("returns machine output and diagnostics separately without writing", () => {
		const log = spyOn(console, "log");
		const error = spyOn(console, "error");
		try {
			const summary = {
				homeRunId: "still-running",
				status: "running",
				assistantText: "Working",
			} as HomeRunSummary;
			const result = formatSendResult(summary, {
				json: true,
				color: { enabled: false },
				poll: true,
			});
			expect(JSON.parse(result.stdout.join("\n"))).toEqual(summary);
			expect(result.stderr.join("\n")).toContain("tedix run still-running");
			expect(result.exitCode).toBe(3);
			expect(log).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
			error.mockRestore();
		}
	});
	test("declined writes remain failures even when the Home run completed", () => {
		const result = formatSendResult(
			{
				homeRunId: "declined",
				status: "completed",
				writeDeclined: { stage: "policy", detail: "Denied" },
			} as HomeRunSummary,
			{ json: false, color: { enabled: false }, poll: true },
		);
		expect(result.exitCode).toBe(2);
		expect(result.stderr.join("\n")).toContain("Write not performed");
	});
});

describe("shared run presentation", () => {
	const payload = {
		executionId: "read-1",
		result: {
			run: { id: "run-1", status: "completed" },
			assistantMessage: { content: "Finished the task." },
		},
	};
	test("shell and explicit transcript output share the answer without a second read", async () => {
		const shell: string[] = [];
		const transcript: string[] = [];
		let reads = 0;
		const ctx = makeContext({
			json: false,
			client: {
				readHomeRun: async () => {
					reads++;
					return payload;
				},
			} as unknown as TedixHomeClient,
			output: {
				log: (line) => shell.push(line),
				error: (line) => shell.push(line),
			},
		});
		expect(await findCommand("run")!.handler("run-1", ctx)).toBe(0);
		printRunPayload(payload, {
			...ctx,
			output: {
				log: (line) => transcript.push(line),
				error: (line) => transcript.push(line),
			},
		});
		expect(reads).toBe(1);
		expect(transcript).toEqual(shell);
		expect(transcript.join("\n")).toContain("Run run-1: completed");
		expect(transcript.join("\n")).toContain("Finished the task.");
	});
	test("JSON retains the execution envelope", () => {
		const lines: string[] = [];
		printRunPayload(
			payload,
			makeContext({
				output: { log: (line) => lines.push(line), error: () => {} },
			}),
		);
		expect(JSON.parse(lines.join("\n"))).toEqual(payload);
	});
	test("truncated run previews never become a complete answer", () => {
		const lines: string[] = [];
		printRunPayload(
			{
				executionId: "read-2",
				result: { __tedix_truncated: true, preview: payload.result },
			},
			makeContext({
				json: false,
				output: {
					log: (line) => lines.push(line),
					error: (line) => lines.push(line),
				},
			}),
		);
		expect(lines.join("\n")).not.toContain("Run run-1: completed");
		expect(lines.join("\n")).toContain("truncated");
	});
});

test("chat help and completion offer one command per session action", () => {
	const names = interactiveSlashCommands().map((command) => command.name);
	expect(names).toContain("new");
	expect(names).toContain("exit");
	expect(names).not.toContain("clear");
	expect(names).not.toContain("quit");
	expect(formatInteractiveCommandHelp()).not.toContain("/clear");
	expect(formatInteractiveCommandHelp()).not.toContain("/quit");
});
