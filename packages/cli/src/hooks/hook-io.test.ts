import { describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	existsSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentContext, runAgentContext } from "../agent-context";
import { writeWorkspaceCredentials } from "../credential-store";
import {
	cliRead,
	readJsonChild,
	HOOK_READ_STDERR_TAIL,
	HOOK_READ_STDOUT_LIMIT,
	unattendedRun,
} from "./hook-io";
const run = (source: string, timeout = 1000) =>
	readJsonChild(process.execPath, ["-e", source], timeout);
describe("local context reads", () => {
	test("the supervisor command resolves its default and exact session without a child", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-local-read-"));
		const previous = process.env.TEDIX_CONFIG_DIR;
		const sessionId = "11111111-1111-4111-8111-111111111111";
		try {
			process.env.TEDIX_CONFIG_DIR = dir;
			writeWorkspaceCredentials(
				"fixture",
				{
					loginId: "fixture-owner",
					org: "org_fixture",
					mcpUrl: "https://fixture.example.invalid/mcp",
				},
				{ configDir: dir },
			);
			runAgentContext(
				["set-default-organization", "fixture", "--workspace", "fixture"],
				{ cwd: dir, configDir: dir, env: {} },
			);
			const expected = resolveAgentContext({
				cwd: dir,
				allowDefault: true,
				sessionId,
			});
			expect(expected.status).toBe("bound");
			// A child read rejects a zero deadline, so success proves local routing.
			expect(
				await cliRead(
					[
						"setup",
						"agents",
						"context",
						"show",
						"--json",
						"--allow-default",
						"--session",
						sessionId,
					],
					0,
					undefined,
					{ cwd: dir },
				),
			).toEqual(JSON.parse(JSON.stringify(expected)));
			expect(
				await cliRead(
					[
						"setup",
						"agents",
						"context",
						"show",
						"--json",
						"--session",
						sessionId,
					],
					0,
					undefined,
					{ cwd: dir },
				),
			).toEqual({ status: "unbound" });
			await expect(
				cliRead(
					[
						"setup",
						"agents",
						"context",
						"show",
						"--json",
						"--allow-default",
						"--unknown",
					],
					0,
				),
			).rejects.toThrow("Invalid CLI read timeout");
		} finally {
			if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
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

	test("the child runs in the given directory while this process stays put", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-read-cwd-"));
		const home = process.cwd();
		try {
			expect(
				await readJsonChild(
					process.execPath,
					["-e", `process.stdout.write(JSON.stringify({cwd:process.cwd()}))`],
					1000,
					undefined,
					{ cwd: dir },
				),
			).toEqual({ cwd: realpathSync(dir) });
			expect(process.cwd()).toBe(home);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a failing child reports its exit code and the tail of its stderr", async () => {
		await expect(
			run(
				`process.stderr.write('x'.repeat(400)+' Error: not signed in\\n');process.exit(3);`,
			),
		).rejects.toThrow(
			new RegExp(
				`^Tedix CLI read failed \\(exit 3\\): x{${HOOK_READ_STDERR_TAIL - " Error: not signed in\n".length}} Error: not signed in$`,
			),
		);
		await expect(run(`process.kill(process.pid,'SIGKILL')`)).rejects.toThrow(
			"Tedix CLI read failed (signal SIGKILL)",
		);
		await expect(
			readJsonChild(join(tmpdir(), "tedix-no-such-binary"), [], 1000),
		).rejects.toThrow(/^Tedix CLI read failed \(.*ENOENT.*\)$/);
	});

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

describe("unattendedRun", () => {
	test("claude -p and codex exec are unattended; interactive runs are not", () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-unattended-"));
		try {
			const rollout = (source: unknown) => {
				const path = join(
					dir,
					`rollout-${JSON.stringify(source).length}.jsonl`,
				);
				writeFileSync(
					path,
					`${JSON.stringify({ type: "session_meta", payload: { id: "x", originator: "codex_exec", source, base_instructions: { text: "y".repeat(20_000) } } })}\n{"type":"event"}\n`,
				);
				return path;
			};
			const codex = (transcript_path: unknown) => ({
				turn_id: "turn-1",
				transcript_path,
			});
			expect(unattendedRun({}, { CLAUDE_CODE_SESSION_ATTENDED: "0" })).toBe(
				true,
			);
			expect(unattendedRun({}, { CLAUDE_CODE_SESSION_ATTENDED: "1" })).toBe(
				false,
			);
			expect(unattendedRun(codex(rollout("exec")), {})).toBe(true);
			expect(unattendedRun(codex(rollout("cli")), {})).toBe(false);
			// A Codex side thread names no transcript, or its parent's rollout.
			expect(unattendedRun(codex(null), {})).toBe(true);
			expect(
				unattendedRun(
					{ ...codex("/h/rollout-2026-x-parent.jsonl"), session_id: "fork" },
					{},
				),
			).toBe(true);
			expect(unattendedRun(codex(rollout({ subagent: "x" })), {})).toBe(false);
			// Not Codex, missing or unreadable transcripts: attended.
			expect(unattendedRun({ transcript_path: rollout("exec") }, {})).toBe(
				false,
			);
			expect(unattendedRun(codex(join(dir, "missing.jsonl")), {})).toBe(false);
			expect(unattendedRun(codex("relative.jsonl"), {})).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
