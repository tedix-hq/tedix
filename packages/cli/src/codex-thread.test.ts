import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexThreadPath } from "./codex-thread";
import { codexDriver } from "./supervise";

const THREAD = "11111111-1111-4111-8111-111111111111";
let home: string;
let path: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codex-thread-"));
	mkdirSync(join(home, "sessions"));
	path = join(home, "sessions", `rollout-${THREAD}_fork.jsonl`);
	writeFileSync(path, "{}");
	const bin = join(home, "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "codex"),
		`#!${process.execPath}
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "queue") {
 console.log("Queued message queue-1 for thread " + args[args.indexOf("--thread")+1]);
 process.exit(0);
}
createInterface({input:process.stdin}).on("line", line => {
 const x=JSON.parse(line);
 appendFileSync(process.env.METHOD_LOG, x.method+"\\n");
 if(x.id===1) console.log(JSON.stringify({id:1,result:{}}));
 if(x.id===2) console.log(JSON.stringify({id:2,...JSON.parse(process.env.THREAD_RESULT)}));
});
`,
		{ mode: 0o700 },
	);
	env = {
		...process.env,
		CODEX_HOME: home,
		PATH: `${bin}:${process.env.PATH}`,
		METHOD_LOG: join(home, "methods"),
		THREAD_RESULT: JSON.stringify({
			result: { thread: { id: THREAD, path, ephemeral: false } },
		}),
	};
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("reads the canonical suffixed path without resuming or listing other chats", async () => {
	expect(await codexThreadPath(THREAD, env)).toBe(path);
	expect(readFileSync(env.METHOD_LOG!, "utf8")).toBe(
		"initialize\ninitialized\nthread/read\n",
	);
});

test("driver checks delivery in the canonical file rather than an older filename match", async () => {
	writeFileSync(
		join(home, "sessions", `rollout-${THREAD}.jsonl`),
		'"old reply"',
	);
	const driver = codexDriver(env);
	const queued = await driver.queue(THREAD, "fresh reply");
	expect(queued).toEqual({ id: "queue-1", offset: 2 });
	expect(driver.received(THREAD, "old reply", 0)).toBe(false);
	writeFileSync(path, '{}\n"fresh reply"');
	expect(driver.received(THREAD, "fresh reply", queued!.offset)).toBe(false);
	writeFileSync(
		path,
		"{}\n" +
			JSON.stringify({
				type: "event_msg",
				payload: { type: "user_message", message: "fresh reply" },
			}),
	);
	expect(driver.received(THREAD, "fresh reply", queued!.offset)).toBe(true);
	const restarted = codexDriver(env);
	expect(await restarted.resolveTranscript!(THREAD)).toBe(true);
	expect(restarted.received(THREAD, "fresh reply", queued!.offset)).toBe(true);
});

test("rejects a different returned chat and a host lookup failure", async () => {
	env.THREAD_RESULT = JSON.stringify({
		result: { thread: { id: "other", path } },
	});
	expect(await codexThreadPath(THREAD, env)).toBeUndefined();
	env.THREAD_RESULT = JSON.stringify({
		error: { code: -32600, message: "thread not loaded" },
	});
	expect(await codexThreadPath(THREAD, env)).toBeUndefined();
});

test("rejects ephemeral, archived, foreign and unavailable paths", async () => {
	for (const record of [
		{ id: THREAD, path, ephemeral: true },
		{ id: THREAD, path: join(home, "archived_sessions", "rollout.jsonl") },
		{ id: THREAD, path: join(home, "other.jsonl") },
		{ id: THREAD, path: join(home, "sessions", "missing.jsonl") },
	]) {
		env.THREAD_RESULT = JSON.stringify({ result: { thread: record } });
		expect(await codexThreadPath(THREAD, env)).toBeUndefined();
	}
});
