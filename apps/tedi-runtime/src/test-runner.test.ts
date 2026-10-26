import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScriptTests } from "../scripts/run-tests";

const root = mkdtempSync(join(tmpdir(), "runtime-runner-test-"));
try {
	const events = join(root, "events.jsonl");
	const files = Array.from({ length: 5 }, (_, id) => {
		const file = join(root, `${id}.ts`);
		writeFileSync(
			file,
			`
import assert from 'node:assert/strict';
import {appendFileSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const server=Bun.serve({port:0,fetch:()=>new Response('ok')});
const dir=tmpdir();
const emit=(kind)=>appendFileSync(${JSON.stringify(events)},JSON.stringify({kind,id:${id},dir,port:server.port})+'\\n');
const overlapping=()=>{
 const log=readFileSync(${JSON.stringify(events)},'utf8').trim().split('\\n').map((line)=>JSON.parse(line));
 const starts=log.filter((e)=>e.kind==='start');
 const ended=new Set(log.filter((e)=>e.kind==='end').map((e)=>e.id));
 return starts.length===5||starts.some((e)=>e.id!==${id}&&!ended.has(e.id));
};
try {
 emit('start');
 // Wait for a live peer (or the last file) so overlap never depends on spawn speed.
 const deadline=Date.now()+10_000;
 while(!overlapping()){
  if(Date.now()>deadline) throw new Error('no concurrent peer started');
  await Bun.sleep(10);
 }
 const file=join(dir,'shared-name');
 writeFileSync(file,'${id}');
 await Bun.sleep(150);
 assert.equal(readFileSync(file,'utf8'),'${id}');
} finally {emit('end');server.stop(true);}
`,
		);
		return file;
	});
	assert.equal(await runScriptTests(files, root, 2, () => {}), 0);
	const log: { kind: string; id: number; dir: string; port: number }[] =
		readFileSync(events, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	const active = new Map<number, number>();
	let peak = 0;
	for (const event of log) {
		if (event.kind === "start") {
			assert.ok(![...active.values()].includes(event.port));
			active.set(event.id, event.port);
		} else active.delete(event.id);
		peak = Math.max(peak, active.size);
	}
	assert.equal(peak, 2);
	assert.equal(active.size, 0);
	const dirs = log.filter((e) => e.kind === "start").map((e) => e.dir);
	assert.equal(new Set(dirs).size, 5);
	for (const dir of dirs) assert.equal(existsSync(dir), false);

	const fail = join(root, "fail.ts");
	const next = join(root, "next.ts");
	const marker = join(root, "ran");
	writeFileSync(fail, "console.error('fixture failure');process.exit(7);");
	writeFileSync(
		next,
		`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'yes');`,
	);
	const output: string[] = [];
	assert.equal(
		await runScriptTests([fail, next], root, 1, (text) => {
			output.push(text);
		}),
		7,
	);
	assert.equal(existsSync(marker), false);
	assert.ok(output.join("").includes("fixture failure"));
	assert.equal(await runScriptTests([], root), 0);
	assert.equal(await runScriptTests(["missing.ts"], root, 1, () => {}), 1);
	await assert.rejects(runScriptTests([], root, 0), /positive integer/);
	console.log(
		"runtime runner: bounded concurrency, temp and port isolation, cleanup and fail-fast pass",
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
