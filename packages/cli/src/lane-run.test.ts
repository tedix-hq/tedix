import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	mkdtempSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
	chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";
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
			`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',session_id:${JSON.stringify(mode === "foreign-init" ? foreign : id)}}));setTimeout(()=>process.exit(0),20)});`,
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
