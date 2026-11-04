import { afterEach, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeLaneThread } from "./opencode-lane-thread";
import { openCodeExportHasNoToolAction, runLaneProcess } from "./lane-run";
import { resumeThenFresh } from "./lane-routing";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const id = "ses_0123456789abABCDEFGHIJKLMN";
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "opencode-lane-test-"));
	dirs.push(dir);
	return dir;
}
it("recovers a stopped backend before resuming, falls back only on missing session, and never prompts during allocation", async () => {
	const dir = fixture();
	const executable = join(dir, "opencode");
	const requests = join(dir, "requests.jsonl");
	writeFileSync(
		executable,
		`#!${process.execPath}
import { appendFileSync } from 'node:fs';
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(request) {
 const url = new URL(request.url); appendFileSync(${JSON.stringify(requests)}, JSON.stringify({path:url.pathname,method:request.method})+'\\n');
 if (!request.headers.get('authorization')?.startsWith('Basic ')) return new Response('',{status:401});
 if (url.pathname === '/global/health') return Response.json({healthy:true,version:'1.2.3'});
 if (url.pathname === '/session' || url.pathname === '/session/${id}') return Response.json({id:${JSON.stringify(id)},directory:${JSON.stringify(dir)}});
 return new Response('',{status:404});
}}); console.log('opencode server listening on '+server.url.origin);`,
	);
	chmodSync(executable, 0o700);
	const first = await createOpenCodeLaneThread(
		dir,
		"fictional/model",
		undefined,
		executable,
	);
	const recovered = await createOpenCodeLaneThread(
		dir,
		"fictional/model",
		first.thread.id,
		executable,
	);
	expect(recovered).toEqual(first);
	const fresh = await resumeThenFresh(
		() =>
			createOpenCodeLaneThread(
				dir,
				"fictional/model",
				"ses_aaaaaaaaaaaaABCDEFGHIJKLMN",
				executable,
			),
		() =>
			createOpenCodeLaneThread(dir, "fictional/model", undefined, executable),
	);
	expect(fresh.thread.id).toBe(id);
	expect(readFileSync(requests, "utf8")).not.toContain("prompt");
});
it("fails closed on backend startup failure", async () => {
	await expect(
		createOpenCodeLaneThread(
			fixture(),
			"fictional/model",
			undefined,
			"/missing/opencode",
			1000,
		),
	).rejects.toThrow();
});
it.each(["ok", "error", "foreign"])(
	"interprets OpenCode %s JSON events and verifies admitted identity",
	async (mode) => {
		const dir = fixture();
		const brief = join(dir, "brief.txt");
		const child = join(dir, "opencode");
		writeFileSync(brief, "Inspect a fictional widget");
		writeFileSync(
			child,
			`#!${process.execPath}
 process.stdin.resume();process.stdin.on('end',()=>{
 console.log(JSON.stringify({type:'text',sessionID:${JSON.stringify(mode === "foreign" ? "ses_aaaaaaaaaaaaABCDEFGHIJKLMN" : id)},part:{messageID:'one',text:'progress'}}));
 console.log(JSON.stringify({type:'text',sessionID:${JSON.stringify(id)},part:{messageID:'two',text:'final result'}}));
 ${mode === "error" ? "console.log(JSON.stringify({type:'error',error:{message:'429 rate limit'}}));" : ""}
 setTimeout(()=>process.exit(0),20);
 });`,
		);
		chmodSync(child, 0o700);
		const reports: Record<string, unknown>[] = [];
		const code = await runLaneProcess(
			[
				"run",
				"--executor",
				"opencode",
				"--model",
				"fictional/model",
				"--project",
				"11111111-1111-4111-8111-111111111111",
				"--brief",
				brief,
				"--",
				child,
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
		expect(code).toBe(mode === "ok" ? 0 : 1);
		expect(reports.at(-1)?.sessionKey).toBe(id);
		const telemetry = reports.at(-1)?.telemetry as {
			finalMessage: string;
			outcome: string;
		};
		expect(telemetry.outcome).toBe(mode === "ok" ? "succeeded" : "failed");
		if (mode === "ok") expect(telemetry.finalMessage).toBe("final result");
		if (mode === "error") expect(telemetry.finalMessage).toContain("429");
	},
);

it("interrupts provider silence before tools and records a safe recovery reason", async () => {
	const dir = fixture();
	const brief = join(dir, "brief.txt");
	const child = join(dir, "opencode");
	writeFileSync(brief, "Inspect a fictional widget");
	writeFileSync(
		child,
		`#!${process.execPath}
process.stdin.resume(); process.stdin.on('end', () => {
	 console.log(JSON.stringify({type:'step_start',sessionID:${JSON.stringify(id)},part:{messageID:'stalled-message'}}));
 setInterval(() => {}, 1000);
});`,
	);
	chmodSync(child, 0o700);
	const activities: Array<{ state: string }> = [];
	const reports: Record<string, unknown>[] = [];
	const code = await runLaneProcess(
		[
			"run",
			"--executor",
			"opencode",
			"--model",
			"fictional/model",
			"--project",
			"11111111-1111-4111-8111-111111111111",
			"--brief",
			brief,
			"--",
			child,
		],
		{
			cwd: dir,
			sessionKey: id,
			providerStallMs: 20,
			confirmProviderStallSafe: async () => true,
			onNativeActivity: (activity) => activities.push(activity),
			report: async (input) => {
				reports.push(input);
				return {};
			},
		},
	);
	expect(code).toBe(1);
	expect(activities.map((activity) => activity.state)).toEqual([
		"provider_waiting",
		"provider_stalled",
	]);
	expect(
		(reports.at(-1)?.telemetry as { finalMessage: string }).finalMessage,
	).toContain("safe fresh recovery");
});

it("requires persisted proof that the stalled assistant message has no tool part", () => {
	const session = {
		info: { id },
		messages: [
			{
				info: { id: "safe", role: "assistant" },
				parts: [{ type: "text", text: "starting" }],
			},
			{
				info: { id: "unsafe", role: "assistant" },
				parts: [
					{
						type: "tool",
						tool: "shell",
						state: { status: "running", input: {} },
					},
				],
			},
		],
	};
	expect(openCodeExportHasNoToolAction(session, id, "safe")).toBe(true);
	expect(openCodeExportHasNoToolAction(session, id, "unsafe")).toBe(false);
	expect(openCodeExportHasNoToolAction(session, id, "missing")).toBe(false);
});

it("does not turn a completed provider turn into a stall after inspection finishes", async () => {
	const dir = fixture();
	const brief = join(dir, "brief.txt");
	const child = join(dir, "opencode");
	writeFileSync(brief, "Inspect a fictional widget");
	writeFileSync(
		child,
		`#!${process.execPath}
process.stdin.resume(); process.stdin.on('end', () => {
 console.log(JSON.stringify({type:'step_start',sessionID:${JSON.stringify(id)},part:{messageID:'finished-message'}}));
 setTimeout(() => process.exit(0), 30);
});`,
	);
	chmodSync(child, 0o700);
	const activities: Array<{ state: string }> = [];
	const code = await runLaneProcess(
		[
			"run",
			"--executor",
			"opencode",
			"--model",
			"fictional/model",
			"--project",
			"11111111-1111-4111-8111-111111111111",
			"--brief",
			brief,
			"--",
			child,
		],
		{
			cwd: dir,
			sessionKey: id,
			providerStallMs: 10,
			confirmProviderStallSafe: async () => {
				await new Promise((resolve) => setTimeout(resolve, 80));
				return true;
			},
			onNativeActivity: (activity) => activities.push(activity),
			report: async () => ({}),
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(code).toBe(0);
	expect(activities.map((activity) => activity.state)).toEqual([
		"provider_waiting",
	]);
});

it("never interrupts or double-counts a turn after a tool action starts", async () => {
	const dir = fixture();
	const brief = join(dir, "brief.txt");
	const child = join(dir, "opencode");
	writeFileSync(brief, "Inspect a fictional widget");
	writeFileSync(
		child,
		`#!${process.execPath}
process.stdin.resume(); process.stdin.on('end', () => {
 console.log(JSON.stringify({type:'step_start',sessionID:${JSON.stringify(id)}}));
 const tool = {type:'tool_use',sessionID:${JSON.stringify(id)},part:{callID:'call-1',tool:'shell',state:{status:'running'}}};
 console.log(JSON.stringify(tool)); console.log(JSON.stringify(tool));
 setTimeout(() => { console.log(JSON.stringify({type:'text',sessionID:${JSON.stringify(id)},part:{messageID:'done',text:'finished'}})); process.exit(0); }, 80);
});`,
	);
	chmodSync(child, 0o700);
	const reports: Record<string, unknown>[] = [];
	const code = await runLaneProcess(
		[
			"run",
			"--executor",
			"opencode",
			"--model",
			"fictional/model",
			"--project",
			"11111111-1111-4111-8111-111111111111",
			"--brief",
			brief,
			"--",
			child,
		],
		{
			cwd: dir,
			sessionKey: id,
			providerStallMs: 20,
			report: async (input) => {
				reports.push(input);
				return {};
			},
		},
	);
	expect(code).toBe(0);
	expect(
		(reports.at(-1)?.telemetry as { tools: Record<string, number> }).tools,
	).toEqual({ shell: 1 });
});
