import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonChild, HOOK_READ_STDOUT_LIMIT } from "./hook-io";
const run = (source: string, timeout = 1000) =>
	readJsonChild(process.execPath, ["-e", source], timeout);
describe("owning raw hook child collector", () => {
	test("streamed split UTF-8 decodes only after complete bounded raw output", async () => {
		expect(
			await run(
				`const b=Buffer.from(JSON.stringify({text:'é😀'}));process.stdout.write(b.subarray(0,11));setTimeout(()=>process.stdout.end(b.subarray(11)),10);`,
			),
		).toEqual({ text: "é😀" });
	});
	test("exact raw boundary succeeds, overflowing child refuses before publication", async () => {
		const n = HOOK_READ_STDOUT_LIMIT - 8;
		expect(
			(await run(`process.stdout.write('{"x":"'+'a'.repeat(${n})+'"}');`, 3000))
				.x.length,
		).toBe(n);
		await expect(
			run(
				`process.stdout.write(Buffer.alloc(${HOOK_READ_STDOUT_LIMIT + 1},32));setInterval(()=>{},1000);`,
				3000,
			),
		).rejects.toThrow("byte limit");
	});
	test("original deadline settles even when child ignores TERM and never closes", async () => {
		const t = performance.now();
		await expect(
			run(`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`, 60),
		).rejects.toThrow("deadline");
		expect(performance.now() - t).toBeLessThan(600);
	});
	test("nonzero, malformed UTF8, malformed JSON and nonobject outputs refuse", async () => {
		for (const source of [
			`process.stdout.write('{}');process.exitCode=2;`,
			`process.stdout.write(Buffer.from([255]));`,
			`process.stdout.write('{');`,
			`process.stdout.write('[]');`,
		])
			await expect(run(source)).rejects.toThrow();
	});
	test("late output from withdrawn child cannot settle success", async () => {
		await expect(
			run(
				`process.on('SIGTERM',()=>process.stdout.write('{}'));setInterval(()=>{},1000);`,
				60,
			),
		).rejects.toThrow("deadline");
	});
	(process.platform === "win32" ? test.skip : test)(
		"deadline kills the inherited group after the immediate parent closes",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "tedix-hook-owned-group-"));
			const pidPath = join(dir, "pid"),
				tickPath = join(dir, "tick");
			let pid: number | undefined;
			const grandchild = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>fs.writeFileSync(${JSON.stringify(tickPath)},String(Date.now())),10);`;
			const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
			try {
				const started = performance.now();
				await expect(run(parent, 200)).rejects.toThrow("deadline");
				expect(performance.now() - started).toBeLessThan(900);
				expect(existsSync(pidPath)).toBe(true);
				pid = Number(readFileSync(pidPath, "utf8"));
				expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
				await Bun.sleep(250);
				let alive = true;
				try {
					process.kill(pid, 0);
				} catch {
					alive = false;
				}
				expect(alive).toBe(false);
				const last = readFileSync(tickPath, "utf8");
				await Bun.sleep(50);
				expect(readFileSync(tickPath, "utf8")).toBe(last);
			} finally {
				if (pid) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	test("stdin stays outside argv and production stream returns its JSON", async () => {
		expect(
			await readJsonChild(
				process.execPath,
				[
					"-e",
					`let x='';process.stdin.on('data',v=>x+=v);process.stdin.on('end',()=>process.stdout.write(x));`,
				],
				1000,
				'{"ok":true}',
			),
		).toEqual({ ok: true });
	});
});
