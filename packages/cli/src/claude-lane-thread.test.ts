import { afterEach, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTranscript, createClaudeLaneThread } from "./claude-lane-thread";

const directories: string[] = [];
const id = "11111111-1111-4111-8111-111111111111";
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture(mode = "ok") {
	const dir = mkdtempSync(join(tmpdir(), "claude-lane-test-"));
	directories.push(dir);
	const executable = join(dir, "claude");
	writeFileSync(
		executable,
		`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const root=process.env.CLAUDE_CONFIG_DIR;
fs.mkdirSync(path.join(root,'sessions'),{recursive:true});
const registry=path.join(root,'sessions',process.pid+'.json');
fs.writeFileSync(registry,JSON.stringify({pid:${mode === "wrong-pid" ? "process.pid+1" : "process.pid"},startedAt:${mode === "stale" ? "0" : "Date.now()"},cwd:process.cwd(),sessionId:${JSON.stringify(id)},version:'2.1.test'}));
const requests=[];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line); requests.push(frame);
 fs.writeFileSync(path.join(root,'observed.json'),JSON.stringify({args:process.argv.slice(2),requests,parent:process.env.TEDIX_AGENT_SESSION,thread:process.env.CODEX_THREAD_ID,nested:process.env.CLAUDECODE,model:process.env.ANTHROPIC_MODEL}));
 if(${JSON.stringify(mode)}==='timeout')return;
 if(${JSON.stringify(mode)}==='failed')process.exit(1);
 const response=frame.request.subtype==='initialize'?{pid:process.pid,claude_code_version:'2.1.test'}:{model:${mode === "missing-model" ? "null" : "'native-fictional-model'"}};
 console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response}}));
});
`,
	);
	chmodSync(executable, 0o700);
	return {
		dir,
		executable,
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: dir,
			TEDIX_AGENT_SESSION: "parent",
			CODEX_THREAD_ID: "parent-thread",
			CLAUDECODE: "1",
			ANTHROPIC_MODEL: "fictional-model",
		},
	};
}
it("captures native identity before the PID record disappears without choosing a model or granting permissions", async () => {
	const f = fixture();
	expect(
		await createClaudeLaneThread(f.dir, f.executable, f.env, 5000),
	).toEqual({
		thread: { id, cliVersion: "2.1.test" },
		model: "native-fictional-model",
		modelProvider: "anthropic",
	});
	expect(
		JSON.parse(readFileSync(join(f.dir, "observed.json"), "utf8")),
	).toEqual({
		args: [
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
		],
		model: "fictional-model",
		requests: [
			{
				type: "control_request",
				request_id: "1",
				request: { subtype: "initialize" },
			},
			{
				type: "control_request",
				request_id: "2",
				request: { subtype: "get_context_usage", detail: "summary" },
			},
		],
	});
});
it("runs the metadata fixture without a runtime on PATH", async () => {
	const f = fixture();
	expect(
		await createClaudeLaneThread(
			f.dir,
			f.executable,
			{ ...f.env, PATH: "" },
			5000,
		),
	).toEqual({
		thread: { id, cliVersion: "2.1.test" },
		model: "native-fictional-model",
		modelProvider: "anthropic",
	});
});
// Each child lifecycle gets its own test budget instead of sharing one deadline.
it.each([
	[
		"wrong-pid",
		"Claude did not expose a verified native PID/session record; no model turn launched",
	],
	["failed", "Claude metadata process exited before admission"],
	[
		"timeout",
		"Claude metadata initialization timed out; no model turn launched",
	],
	[
		"missing-model",
		"Claude did not return its native model; no model turn launched",
	],
	[
		"stale",
		"Claude did not expose a verified native PID/session record; no model turn launched",
	],
])("does not admit %s metadata", async (mode, message) => {
	const f = fixture(mode);
	await expect(
		createClaudeLaneThread(
			f.dir,
			f.executable,
			f.env,
			mode === "timeout" ? 20 : 5000,
		),
	).rejects.toThrow(message);
});
it("locates only an unambiguous native transcript and rejects path-shaped identities", () => {
	const f = fixture();
	const project = join(f.dir, "projects", "fictional-project");
	mkdirSync(project, { recursive: true });
	const path = join(project, `${id}.jsonl`);
	writeFileSync(path, "not read by the locator");
	expect(claudeTranscript(id, f.dir)).toBe(path);
	expect(claudeTranscript("../other", f.dir)).toBeUndefined();
	const duplicate = join(f.dir, "projects", "another-project");
	mkdirSync(duplicate);
	writeFileSync(join(duplicate, `${id}.jsonl`), "ambiguous");
	expect(claudeTranscript(id, f.dir)).toBeUndefined();
});
