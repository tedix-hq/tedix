import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLane } from "./lane";
import { runLaneProcess, codexTranscript } from "./lane-run";

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
		`const fs=require('node:fs');let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({text,thread:process.env.CODEX_THREAD_ID,session:process.env.CODEX_SESSION_ID,parent:process.env.TEDIX_AGENT_SESSION,lane:process.env.TEDIX_LANE_ID,receipt:process.env.TEDIX_LANE_TELEMETRY_PATH}));setTimeout(()=>process.exit(Number(process.argv[2]||0)),60);});`,
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
