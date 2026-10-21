import { afterEach, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLaneProcess } from "./lane-run";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
it.each([0, 7])(
	"preserves Codex exit %i after a stream error and retains failed-run diagnostics",
	async (code) => {
		const dir = mkdtempSync(join(tmpdir(), "codex-stream-errors-"));
		dirs.push(dir);
		const id = "11111111-1111-4111-8111-111111111111";
		const brief = join(dir, "brief.txt"),
			transcript = join(dir, "rollout.jsonl"),
			executable = join(dir, "codex");
		writeFileSync(brief, "Inspect a fictional widget");
		writeFileSync(
			transcript,
			[
				{
					type: "session_meta",
					timestamp: "2026-10-21T10:00:00Z",
					payload: { id, cwd: dir },
				},
				{
					type: "event_msg",
					timestamp: "2026-10-21T10:00:01Z",
					payload: {
						type: "task_complete",
						last_agent_message: "Verified widget",
					},
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n") + "\n",
		);
		writeFileSync(
			executable,
			`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(id)}}));console.log(JSON.stringify({type:'error',message:'429 rate limit during retry'}));process.exit(${code});});`,
		);
		chmodSync(executable, 0o700);
		const reports: Record<string, unknown>[] = [];
		const result = await runLaneProcess(
			[
				"run",
				"--executor",
				"codex",
				"--project",
				id,
				"--brief",
				brief,
				"--transcript",
				transcript,
				"--",
				executable,
				"exec",
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
		expect(result).toBe(code);
		const telemetry = reports.at(-1)?.telemetry as {
			outcome: string;
			finalMessage: string;
		};
		expect(telemetry.outcome).toBe(code ? "failed" : "succeeded");
		expect(telemetry.finalMessage).toContain(code ? "429" : "Verified widget");
	},
);
