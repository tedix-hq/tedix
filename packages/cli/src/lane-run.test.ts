import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
	chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";
import { createCodexLaneThread } from "./codex-lane-thread";
import { runLane } from "./lane";
import { runLaneProcess, codexTranscript, LANE_HEARTBEAT_MS } from "./lane-run";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "lane-wrapper-test-"));
	dirs.push(dir);
	const brief = join(dir, "brief.txt");
	writeFileSync(brief, "Fix a fictional widget");
	const out = join(dir, "child.json");
	const script = join(dir, "child.js");
	writeFileSync(
		script,
		`const fs=require('node:fs');let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{fs.writeFileSync(${codeModeLiteral(out)},JSON.stringify({text,workspace:process.env.TEDIX_WORKSPACE,organization:process.env.TEDIX_ORGANIZATION,thread:process.env.CODEX_THREAD_ID,session:process.env.CODEX_SESSION_ID,parent:process.env.TEDIX_AGENT_SESSION,lane:process.env.TEDIX_LANE_ID,label:process.env.TEDIX_LANE_LABEL,receipt:process.env.TEDIX_LANE_TELEMETRY_PATH}));setTimeout(()=>process.exit(Number(process.argv[2]||0)),60);});`,
	);
	const args = [
		"run",
		"--executor",
		"skill",
		"--project",
		"00000000-0000-4000-8000-000000000001",
		"--brief",
		brief,
		"--",
		process.execPath,
		script,
	];
	return { args, out };
}
describe("lane launcher", () => {
	it.each(["codex", "claude-code"] as const)(
		"enforces %s transcript usage without charging earlier Attempts or duplicate records",
		async (executor) => {
			const { args, out } = fixture();
			args[2] = executor;
			const path = join(out, "..", "transcript.jsonl");
			const row = (n: number) => ({
				timestamp: "2026-11-25T00:00:00Z",
				...(executor === "codex"
					? {
							type: "event_msg",
							payload: {
								type: "token_count",
								info: {
									total_token_usage: {
										input_tokens: n * 100,
										output_tokens: n * 10,
									},
								},
							},
						}
					: {
							type: "assistant",
							sessionId: "test-session",
							message: {
								id: `message-${n}`,
								role: "assistant",
								content: [],
								usage: { input_tokens: 100, output_tokens: 10 },
							},
						}),
			});
			writeFileSync(
				path,
				[
					{
						timestamp: "2026-11-25T00:00:00Z",
						type: "session_meta",
						payload: { id: "test-session" },
					},
					row(1),
				]
					.map((value) => JSON.stringify(value))
					.join("\n") + "\n",
			);
			writeFileSync(
				args.at(-1)!,
				`process.stdin.resume(); process.stdin.on('end', () => {
			require('node:fs').appendFileSync(${codeModeLiteral(path)}, ${codeModeLiteral(JSON.stringify(row(2)) + "\n" + JSON.stringify(row(2)) + "\n")});
			setInterval(() => {}, 1000);
		});`,
			);
			args.splice(args.indexOf("--"), 0, "--transcript", path);
			const state = {
				startedAt: Date.now(),
				turns: 0,
				tokens: 0,
				reason: undefined as string | undefined,
			};
			expect(
				await runLaneProcess(args, {
					sessionKey: "test-session",
					limits: { maxTurns: 1 },
					limitState: state,
					report: async () => ({}),
				}),
			).toBe(1);
			expect(state.turns).toBe(1);
			expect(state.tokens).toBe(110);
			expect(state.reason).toContain("Attempt turn limit reached");
		},
	);
	it.each([
		{ limits: { timeoutSec: 0.05 }, reason: "wall time", executor: "skill" },
		{ limits: { maxTurns: 1 }, reason: "turn", executor: "opencode" },
		{
			limits: { maxCostUsd: 0.001, usdPerMillionTokens: 10 },
			reason: "estimated cost",
			executor: "opencode",
		},
	])(
		"stops a live child at the $reason limit and retains the reason",
		async ({ limits, reason, executor }) => {
			const { args } = fixture();
			args[2] = executor;
			const script = args.at(-1)!;
			writeFileSync(
				script,
				`process.stdin.resume(); process.stdin.on('end', () => {
			console.log(JSON.stringify({type:'step_finish',sessionID:'test-session',part:{id:'step-1',tokens:{input:100,output:10}}}));
			setInterval(() => {}, 1000);
		});`,
			);
			const reports: Record<string, unknown>[] = [];
			const state = {
				startedAt: Date.now(),
				turns: 0,
				tokens: 0,
				reason: undefined as string | undefined,
			};
			expect(
				await runLaneProcess(args, {
					limits,
					limitState: state,
					sessionKey: executor === "opencode" ? "test-session" : undefined,
					report: async (input) => {
						reports.push(input);
						return {};
					},
				}),
			).toBe(1);
			expect(state.reason).toContain(`Attempt ${reason} limit reached`);
			expect(reports.at(-1)!.telemetry).toMatchObject({
				outcome: "failed",
				finalMessage: state.reason,
			});
			// The same Attempt must not gain a fresh allowance on a resumed launch.
			let spawned = false;
			expect(
				await runLaneProcess(args, {
					limits,
					limitState: JSON.parse(JSON.stringify(state)),
					sessionKey: executor === "opencode" ? "test-session" : undefined,
					onSpawn: () => {
						spawned = true;
					},
					report: async () => ({}),
				}),
			).toBe(1);
			expect(spawned).toBe(false);
		},
	);
	// Codex may announce a turn before or after it answers the start request.
	it.each(["reply", "notice"])(
		"steers the active Codex turn and keeps its server for the next turn (%s first)",
		async (first) => {
			const { args, out } = fixture();
			const codex = join(out, "..", "codex");
			const threadId = "00000000-0000-4000-8000-000000000002";
			writeFileSync(
				codex,
				`#!${process.execPath}
const send = (message) => console.log(JSON.stringify(message));
let turns = 0;
const reply = (id, result) => send({ id, result });
const finish = (threadId, turnId, text) => {
	send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", text } } });
	send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, method, params } = JSON.parse(line);
	if (method === "initialize") reply(id, {});
	if (method === "thread/start") reply(id, {
		thread: { id: ${JSON.stringify(threadId)}, path: "unused.jsonl", cliVersion: "0.170.0" },
		model: "test-model",
		modelProvider: "test-provider",
	});
	if (method === "turn/start") {
		const turnId = String(++turns);
		if (params.outputSchema.type !== "object") process.exit(2);
		const started = () => send({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
		if (process.env.FIRST === "notice") started();
		reply(id, { turn: { id: turnId } });
		if (process.env.FIRST !== "notice") started();
		if (turns === 2) finish(params.threadId, turnId, '{"text":"next turn"}');
	}
	if (method === "turn/steer") {
		if (params.expectedTurnId !== String(turns)) process.exit(3);
		reply(id, { turnId: params.expectedTurnId });
		finish(params.threadId, params.expectedTurnId, JSON.stringify({ text: params.input[0].text }));
	}
});
`,
				{ mode: 0o700 },
			);
			args[2] = "codex";
			args.splice(-2, 2, codex, "exec");
			const { codexServer } = await createCodexLaneThread(
				join(out, ".."),
				codex,
				undefined,
				undefined,
				{ FIRST: first },
			);
			const steps: string[] = [];
			const pids: number[] = [];
			const outputSchema = {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
				additionalProperties: false,
			};
			let delivery: Promise<boolean> | undefined;
			const run = (outputPath: string, onTurnStarted: () => void) =>
				runLaneProcess(args, {
					sessionKey: threadId,
					admitted: true,
					report: async () => ({}),
					onAgentStep: (step) => steps.push(step.text),
					onSpawn: (pid) => pids.push(pid),
					codex: {
						server: codexServer,
						outputPath,
						outputSchema,
						onUnavailable() {},
						onTurnStarted,
					},
				});
			try {
				expect(
					await run(out, () => {
						delivery = codexServer.steer("Use the updated brief");
					}),
				).toBe(0);
				expect(await delivery).toBe(true);
				expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
					text: "Use the updated brief",
				});
				expect(await run(`${out}.second`, () => {})).toBe(0);
				expect(pids).toEqual([pids[0]!, pids[0]!]);
				expect(steps).toEqual([
					'{"text":"Use the updated brief"}',
					'{"text":"next turn"}',
				]);
			} finally {
				codexServer.close();
			}
		},
	);
	it("gives every launch into one Attempt's folder its own output files", async () => {
		const { args, out } = fixture();
		const output = join(out, "..", "attempt");
		mkdirSync(output);
		writeFileSync(
			args.at(-1)!,
			`console.log('out ' + process.argv[2]); console.error('err ' + process.argv[2]);`,
		);
		const turn = (name: string) =>
			runLaneProcess([...args, name], {
				detachedChild: true,
				detachedOutputDirectory: output,
				forwardSignals: false,
				admitted: true,
				report: async () => ({}),
			});
		const read = (file: string) => readFileSync(join(output, file), "utf8");
		// The first turn, then a follow-up turn of the same Attempt.
		expect(await turn("first")).toBe(0);
		expect(await turn("second")).toBe(0);
		expect(read("stdout-0.log")).toBe("out first\n");
		expect(read("stderr-0.log")).toBe("err first\n");
		expect(read("stdout-1.log")).toBe("out second\n");
		expect(read("stderr-1.log")).toBe("err second\n");
		// After a restart the folder may hold a file from a turn that broke off.
		writeFileSync(join(output, "stderr-6.log"), "left by an earlier runner");
		expect(await turn("resumed")).toBe(0);
		expect(read("stdout-7.log")).toBe("out resumed\n");
		expect(read("stderr-6.log")).toBe("left by an earlier runner");
		expect(read("stdout-0.log")).toBe("out first\n");
	});

	it("detached worker keeps writing after its runner parent is killed", async () => {
		const { args, out } = fixture();
		const progress = `${out}.progress`;
		writeFileSync(
			args.at(-1)!,
			`const fs=require('node:fs'); const path=require('node:path'); fs.writeFileSync(${codeModeLiteral(out)},JSON.stringify({pid:process.pid,dir:path.dirname(process.env.TEDIX_LANE_TELEMETRY_PATH)})); let n=0; process.stdin.resume(); setInterval(()=>{fs.writeSync(1,'x'.repeat(16384));fs.writeSync(2,'y'.repeat(16384));fs.writeFileSync(${codeModeLiteral(progress)},String(++n));},10);`,
		);
		const parent = spawn(
			process.execPath,
			[
				"-e",
				`import {runLaneProcess} from ${codeModeLiteral(join(import.meta.dir, "lane-run.ts"))}; await runLaneProcess(${codeModeLiteral(args)},{detachedChild:true,forwardSignals:false,report:async()=>({})});`,
			],
			{ stdio: "ignore" },
		);
		let pid: number | undefined;
		try {
			for (let n = 0; n < 200 && !existsSync(progress); n++)
				await Bun.sleep(10);
			expect(existsSync(progress)).toBe(true);
			const worker = JSON.parse(readFileSync(out, "utf8"));
			pid = worker.pid;
			dirs.push(worker.dir);
			const before = Number(readFileSync(progress, "utf8"));
			parent.kill("SIGKILL");
			for (
				let n = 0;
				n < 200 && Number(readFileSync(progress, "utf8")) < before + 64;
				n++
			)
				await Bun.sleep(10);
			expect(Number(readFileSync(progress, "utf8"))).toBeGreaterThanOrEqual(
				before + 64,
			);
			expect(() => process.kill(pid!, 0)).not.toThrow();
		} finally {
			parent.kill("SIGKILL");
			if (pid) process.kill(-pid, "SIGTERM");
		}
	});
	it.each([true, false])(
		"signal forwarding can yield to dispatcher drain: %s",
		async (forwardSignals) => {
			const { args, out } = fixture();
			const release = `${out}.release`;
			writeFileSync(
				args.at(-1)!,
				`const fs=require('node:fs'); process.stdin.resume(); fs.writeFileSync(${codeModeLiteral(out)},'{}'); setInterval(()=>{if(fs.existsSync(${codeModeLiteral(release)}))process.exit(0)},5);`,
			);
			const previous = new Set(process.listeners("SIGTERM"));
			let draining = false;
			const stop = () => {
				draining = true;
			};
			process.on("SIGTERM", stop);
			try {
				const run = runLaneProcess(args, {
					forwardSignals,
					report: async () => ({}),
				});
				for (let n = 0; n < 200 && !existsSync(out); n++)
					await new Promise((done) => setTimeout(done, 5));
				expect(existsSync(out)).toBe(true);
				for (const listener of process.listeners("SIGTERM"))
					if (!previous.has(listener)) listener.call(process, "SIGTERM");
				expect(draining).toBe(true);
				if (!forwardSignals) writeFileSync(release, "done");
				const result = await run;
				if (forwardSignals) expect(result).not.toBe(0);
				else expect(result).toBe(0);
			} finally {
				process.off("SIGTERM", stop);
			}
		},
	);

	it("keeps the Work title in every report and child hook despite wrapper preambles", async () => {
		const { args, out } = fixture();
		writeFileSync(
			args[args.indexOf("--brief") + 1]!,
			"Your exclusive source worktree is /fictional/repo.\n\n# Lane rules",
		);
		for (const label of ["Repair widget identity", undefined]) {
			const reports: Record<string, unknown>[] = [];
			const separator = args.indexOf("--");
			expect(
				await runLaneProcess(
					[
						...args.slice(0, separator),
						"--work-item",
						"00000000-0000-4000-8000-000000000002",
						...args.slice(separator),
					],
					{
						label,
						heartbeatMs: 10,
						report: async (input) => {
							reports.push(input);
							return {};
						},
					},
				),
			).toBe(0);
			expect(reports.length).toBeGreaterThan(2);
			expect(reports.every((report) => report.label === (label ?? ""))).toBe(
				true,
			);
			expect(JSON.parse(readFileSync(out, "utf8")).label).toBe(label ?? "");
		}
	});
	it("uses the first brief heading for a standalone lane", async () => {
		const { args, out } = fixture();
		writeFileSync(
			args[args.indexOf("--brief") + 1]!,
			"Read the guide first.\n# Repair widget identity\n\n## Tests",
		);
		await runLaneProcess(args, {
			report: async (input) => {
				expect(input.label).toBe("Repair widget identity");
				return {};
			},
		});
		expect(JSON.parse(readFileSync(out, "utf8")).label).toBe(
			"Repair widget identity",
		);
	});
	it("registers before launch, heartbeats, isolates identity and preserves a nonzero exit", async () => {
		const { args, out } = fixture();
		const reports: Record<string, unknown>[] = [];
		expect(
			await runLaneProcess([...args, "7"], {
				heartbeatMs: 10,
				report: async (input) => {
					reports.push(input);
					return {};
				},
			}),
		).toBe(7);
		const child = JSON.parse(readFileSync(out, "utf8"));
		expect(child.text).toBe("Fix a fictional widget");
		expect(child.lane).toBe(reports[0]!.sessionKey);
		expect(child.thread).toBeUndefined();
		expect(child.session).toBeUndefined();
		expect(child.parent).toBeUndefined();
		expect(reports.length).toBeGreaterThan(2);
		expect(reports[0]!.state).toBe("working");
		expect(reports.at(-1)!.state).toBe("error");
		expect((reports.at(-1)!.telemetry as { outcome: string }).outcome).toBe(
			"failed",
		);
		expect(existsSync(child.receipt)).toBe(false);
	});
	it("does not launch the child when registration fails", async () => {
		const { args, out } = fixture();
		await expect(
			runLaneProcess(args, {
				report: async () => {
					throw new Error("unavailable");
				},
			}),
		).rejects.toThrow("unavailable");
		expect(existsSync(out)).toBe(false);
	});
	it("launches an admitted Attempt's child when its first observation times out", async () => {
		const { args, out } = fixture();
		const reports: Record<string, unknown>[] = [];
		let calls = 0;
		expect(
			await runLaneProcess(args, {
				admitted: true,
				heartbeatMs: 10,
				report: async (input) => {
					if (++calls === 1)
						throw new Error("Work native command deadline exceeded");
					reports.push(input);
					return {};
				},
			}),
		).toBe(0);
		expect(existsSync(out)).toBe(true);
		expect(reports.at(-1)!.state).toBe("done");
	});
	it("starts an admitted child without waiting for a pending activity report", async () => {
		const { args, out } = fixture();
		let spawned = false;
		const run = runLaneProcess(args, {
			admitted: true,
			heartbeatMs: 10,
			onSpawn: () => {
				spawned = true;
			},
			report: async (input) => {
				if (input.state === "working" && !spawned) return new Promise(() => {});
				return {};
			},
		});
		expect(await run).toBe(0);
		expect(spawned).toBe(true);
		expect(existsSync(out)).toBe(true);
	});
	it("retains a complete idempotent observation when settlement fails, then replays that same lane", async () => {
		const { args, out } = fixture();
		let calls = 0;
		expect(
			await runLaneProcess(args, {
				report: async () => {
					if (++calls > 1) throw new Error("unavailable");
					return {};
				},
			}),
		).toBe(1);
		const child = JSON.parse(readFileSync(out, "utf8"));
		const saved = JSON.parse(readFileSync(child.receipt, "utf8"));
		dirs.push(join(child.receipt, ".."));
		expect(saved.sessionKey).toBe(child.lane);
		expect(saved.telemetry.outcome).toBe("succeeded");
		let retry: Record<string, unknown> | undefined;
		expect(
			await runLaneProcess(["report", "--input-file", child.receipt], {
				report: async (input) => {
					retry = input;
					return {};
				},
			}),
		).toBe(0);
		expect(retry).toEqual(saved);
	});
	it("does not traverse for an untrusted native thread id", () => {
		expect(
			codexTranscript("../../other", { CODEX_HOME: "/not/read" }),
		).toBeUndefined();
	});
	it("finds no Codex transcript before Codex has saved any thread", () => {
		expect(
			codexTranscript("00000000-0000-4000-8000-000000000002", {
				CODEX_HOME: "/not/created",
			}),
		).toBeUndefined();
	});
});

it("routes global workspace options to a preview without making a live call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-preview-test-"));
	dirs.push(dir);
	const path = join(dir, "session.jsonl");
	writeFileSync(
		path,
		JSON.stringify({
			timestamp: "2026-10-17T10:00:00.000Z",
			type: "session_meta",
			payload: { id: "fictional-session", cwd: "/fictional/repo" },
		}),
	);
	expect(
		await runLane([
			"-w",
			"fictional",
			"import",
			"--executor",
			"codex",
			"--project",
			"00000000-0000-4000-8000-000000000001",
			"--transcript",
			path,
		]),
	).toBe(0);
});

it("stores outcome text before truncation while preserving structured telemetry", async () => {
	const { out } = fixture();
	const path = join(out, "..", "session.jsonl");
	const finalMessage = JSON.stringify({
		workItemId: "fictional-work",
		outcomeText: "The editor is ready. ".repeat(20),
		outcome: "completed",
	});
	writeFileSync(
		path,
		[
			{
				type: "session_meta",
				timestamp: "2026-11-22T10:00:00Z",
				payload: { id: "fictional-session" },
			},
			{
				type: "event_msg",
				timestamp: "2026-11-22T10:01:00Z",
				payload: { type: "agent_message", message: finalMessage },
			},
		]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
	const reports: Record<string, unknown>[] = [];
	expect(
		await runLaneProcess(
			[
				"import",
				"--executor",
				"codex",
				"--project",
				"00000000-0000-4000-8000-000000000001",
				"--transcript",
				path,
				"--apply",
			],
			{
				report: async (input) => {
					reports.push(input);
					return {};
				},
			},
		),
	).toBe(0);
	expect(reports[0]?.summary).toBe(
		JSON.parse(finalMessage).outcomeText.slice(0, 200),
	);
	expect((reports[0]?.telemetry as { finalMessage: string }).finalMessage).toBe(
		finalMessage,
	);
});

it("pins the child's organization and workspace without inheriting a launcher Attempt", async () => {
	const { args, out } = fixture();
	expect(
		await runLaneProcess(args, {
			childScope: { workspace: "acme", organization: "org_acme" },
			report: async () => ({}),
		}),
	).toBe(0);
	const child = JSON.parse(readFileSync(out, "utf8"));
	expect(child.workspace).toBe("acme");
	expect(child.organization).toBe("org_acme");
	expect(child.parent).toBeUndefined();
});

it.each(["codex", "claude"])(
	"reports typed %s events from detached stdout",
	async (agent) => {
		const { args, out } = fixture();
		const executable = join(out, "..", agent);
		writeFileSync(
			executable,
			`#!${process.execPath}\nconsole.error('{"type":"stderr"}'); console.log('text noise\\n{}\\n{"type":"assistant"}');`,
		);
		chmodSync(executable, 0o700);
		args[2] = agent === "codex" ? "codex" : "claude-code";
		args.splice(
			args.indexOf("--") + 1,
			2,
			executable,
			...(agent === "codex" ? ["exec"] : ["--output-format", "stream-json"]),
		);
		const events: number[] = [];
		const before = Date.now();
		await runLaneProcess(args, {
			detachedChild: true,
			onAgentEvent: (observedAt) => events.push(observedAt),
			report: async () => ({}),
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toBeGreaterThanOrEqual(before);
	},
);

it.each(["codex", "claude"])(
	"summarises %s events into steps and survives a failing step listener",
	async (agent) => {
		const { args, out } = fixture();
		const executable = join(out, "..", agent);
		const lines =
			agent === "codex"
				? [
						{
							type: "item.completed",
							item: {
								type: "command_execution",
								command: "bun test",
								aggregated_output: "private output",
								exit_code: 0,
							},
						},
						{
							type: "item.completed",
							item: { type: "agent_message", text: "Tests pass." },
						},
					]
				: [
						{
							type: "assistant",
							message: {
								content: [
									{
										type: "tool_use",
										name: "Bash",
										input: { command: "bun test" },
									},
								],
							},
						},
						{
							type: "assistant",
							message: { content: [{ type: "text", text: "Tests pass." }] },
						},
					];
		writeFileSync(
			executable,
			`#!${process.execPath}\nconsole.log(${codeModeLiteral(lines.map((line) => JSON.stringify(line)).join("\n"))});`,
		);
		chmodSync(executable, 0o700);
		args[2] = agent === "codex" ? "codex" : "claude-code";
		args.splice(
			args.indexOf("--") + 1,
			2,
			executable,
			...(agent === "codex" ? ["exec"] : ["--output-format", "stream-json"]),
		);
		const steps: unknown[] = [];
		const events: number[] = [];
		await runLaneProcess(args, {
			detachedChild: true,
			onAgentEvent: (observedAt) => events.push(observedAt),
			onAgentStep: (step) => {
				steps.push(step);
				throw new Error("listener failed");
			},
			report: async () => ({}),
		});
		expect(steps).toEqual([
			agent === "codex"
				? { kind: "command", text: "bun test (exit 0)" }
				: { kind: "tool", text: "Bash: bun test" },
			{ kind: "message", text: "Tests pass." },
		]);
		expect(events).toHaveLength(2);
	},
);

it("reconciles Claude output only against the admitted native identity and transcript", async () => {
	const id = "11111111-1111-4111-8111-111111111111";
	const foreign = "22222222-2222-4222-8222-222222222222";
	for (const mode of [
		"ok",
		"foreign-init",
		"foreign-transcript",
		"missing-transcript",
	]) {
		const dir = mkdtempSync(join(tmpdir(), "claude-wrapper-test-"));
		dirs.push(dir);
		const brief = join(dir, "brief.txt");
		writeFileSync(brief, "Read the fictional widget");
		const transcript = join(dir, "session.jsonl");
		if (mode !== "missing-transcript")
			writeFileSync(
				transcript,
				JSON.stringify({
					type: "assistant",
					timestamp: "2026-10-17T10:00:00.000Z",
					sessionId: mode === "foreign-transcript" ? foreign : id,
					message: {
						id: "m1",
						model: "fictional-model",
						content: [{ type: "text", text: "Widget verified" }],
						usage: { input_tokens: 5, output_tokens: 2 },
					},
				}),
			);
		const executable = join(dir, "claude");
		writeFileSync(
			executable,
			`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',session_id:${JSON.stringify(mode === "foreign-init" ? foreign : id)}}));console.log(JSON.stringify({type:'result',usage:{input_tokens:5,output_tokens:2}}));setTimeout(()=>process.exit(0),20)});`,
		);
		chmodSync(executable, 0o700);
		const reports: Record<string, unknown>[] = [];
		const result = await runLaneProcess(
			[
				"run",
				"--executor",
				"claude-code",
				"--project",
				"00000000-0000-4000-8000-000000000001",
				"--brief",
				brief,
				"--transcript",
				transcript,
				"--",
				executable,
				"-p",
				"--output-format",
				"stream-json",
			],
			{
				cwd: dir,
				sessionKey: id,
				report: async (input) => {
					reports.push(input);
					return {};
				},
			},
		);
		expect(result).toBe(mode === "ok" ? 0 : 1);
		expect(reports.at(-1)?.sessionKey).toBe(id);
		expect(reports.at(-1)?.telemetry).toMatchObject({
			usage: { input: 5, output: 2 },
		});
		expect((reports.at(-1)?.telemetry as { outcome: string }).outcome).toBe(
			mode === "ok" ? "succeeded" : "failed",
		);
	}
});

it("uses a 120-second cadence and coalesces overlapping heartbeat ticks", async () => {
	const { args } = fixture();
	let tick!: () => void;
	let interval: number | undefined;
	const timer = spyOn(globalThis, "setInterval").mockImplementation(((
		callback: () => void,
		ms: number,
	) => {
		tick = callback;
		interval = ms;
		return setTimeout(() => {}, 1000);
	}) as typeof setInterval);
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const reports: Record<string, unknown>[] = [];
	try {
		const running = runLaneProcess(args, {
			report: async (input) => {
				reports.push(input);
				if (reports.length === 2) await pending;
				return {};
			},
		});
		while (!tick) await new Promise((resolve) => setTimeout(resolve, 1));
		expect(interval).toBe(LANE_HEARTBEAT_MS);
		expect(60_000 / interval!).toBe(0.5);
		tick();
		tick();
		tick();
		expect(reports).toHaveLength(2);
		release();
		expect(await running).toBe(0);
		expect(reports.map((r) => r.state)).toEqual(["working", "working", "done"]);
	} finally {
		release?.();
		timer.mockRestore();
	}
});
