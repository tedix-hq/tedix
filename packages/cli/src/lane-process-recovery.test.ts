import { expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import {
	laneProcessIdentity,
	laneProcessIdentityAsync,
	reapLaneProcess,
	setLaneProcessReaders,
	waitForLaneProcessIdentity,
} from "./lane-process-recovery";
import { kernelProcessCwd, kernelProcessFacts } from "./process-facts";

/**
 * pgid, birth and cwd still come from the kernel; a sandbox that denies
 * `ps`/`lsof` and kern.procargs2 cannot read another process's argv, so the
 * test supplies the arguments it spawned the child with.
 */
function kernelReader(argv: () => string[]) {
	return (pid: number) => {
		const facts = kernelProcessFacts(pid);
		if (!facts) return;
		return {
			pgid: facts.pgid,
			start: facts.start,
			argv: facts.argv.length ? facts.argv : argv(),
		};
	};
}

it("retries Linux process identity while /proc cmdline is temporarily empty", async () => {
	const id = "33333333-3333-4333-8333-333333333333";
	const session = `codex:${id}`;
	const cwd = process.cwd();
	let reads = 0;
	setLaneProcessReaders(
		(pid) => ({
			pgid: pid,
			start: ["123"],
			argv: ++reads < 3 ? [] : [process.execPath, id],
		}),
		() => cwd,
	);
	try {
		const pending = waitForLaneProcessIdentity(123, session, cwd, {
			attempts: 3,
			delayMs: 1,
		});
		let yielded = false;
		setTimeout(() => {
			yielded = true;
		}, 0);
		expect(await pending).toMatch(/^v2:[a-f0-9]{64}$/);
		expect(yielded).toBe(true);
		expect(reads).toBe(3);

		let boundedReads = 0;
		setLaneProcessReaders(
			(pid) => {
				boundedReads++;
				return { pgid: pid, start: ["123"], argv: [] };
			},
			() => cwd,
		);
		expect(
			await waitForLaneProcessIdentity(123, session, cwd, {
				attempts: 2,
				delayMs: 1,
			}),
		).toBeUndefined();
		expect(boundedReads).toBe(2);
	} finally {
		setLaneProcessReaders();
	}
});

it("keeps a verified identity across a real exec and rejects changed birth, session, cwd and legacy argv", async () => {
	const id = "22222222-2222-4222-8222-222222222222";
	const session = `codex:${id}`;
	const cwd = process.cwd();
	let argv = [
		"/bin/sh",
		"-c",
		"printf 'ready\\n'; read -r go; exec \"$@\"",
		"wrapper",
		process.execPath,
		"-e",
		"console.log('native');setInterval(()=>{},1000)",
		id,
	];
	setLaneProcessReaders(
		kernelReader(() => argv),
		kernelProcessCwd,
	);
	const child = spawn("/bin/sh", argv.slice(1), {
		cwd,
		detached: true,
		stdio: ["pipe", "pipe", "ignore"],
	});
	try {
		await once(child.stdout!, "data");
		const identity = laneProcessIdentity(child.pid!, session, cwd)!;
		const legacy = laneProcessIdentity(child.pid!, session)!;
		expect(identity).toMatch(/^v2:[a-f0-9]{64}$/);
		const native = once(child.stdout!, "data");
		child.stdin!.end("go\n");
		await native;
		argv = [
			process.execPath,
			"-e",
			"console.log('native');setInterval(()=>{},1000)",
			id,
		];
		expect(laneProcessIdentity(child.pid!, session, cwd)).toBe(identity);
		expect(laneProcessIdentity(child.pid!, session)).not.toBe(legacy);
		expect(await reapLaneProcess(child.pid!, session, legacy, cwd)).toBe(false);
		expect(
			await reapLaneProcess(child.pid!, "codex:other", identity, cwd),
		).toBe(false);
		expect(await reapLaneProcess(child.pid!, session, identity, tmpdir())).toBe(
			false,
		);
		expect(await reapLaneProcess(child.pid!, session, identity)).toBe(false);
		expect(
			await reapLaneProcess(child.pid!, session, `v2:${"0".repeat(64)}`, cwd),
		).toBe(false);
		const exited = once(child, "exit");
		expect(await reapLaneProcess(child.pid!, session, identity, cwd)).toBe(
			true,
		);
		await exited;
	} finally {
		setLaneProcessReaders();
		try {
			process.kill(-child.pid!, "SIGTERM");
		} catch {}
	}
});
it("reaps only the original process group bound to the native session and start identity", async () => {
	const id = "11111111-1111-4111-8111-111111111111";
	const argv = [
		process.execPath,
		"-e",
		"console.log('ready');setInterval(()=>{},1000)",
		id,
	];
	setLaneProcessReaders(
		kernelReader(() => argv),
		kernelProcessCwd,
	);
	const child = spawn(process.execPath, argv.slice(1), {
		detached: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	try {
		await once(child.stdout!, "data");
		const identity = laneProcessIdentity(child.pid!, `codex:${id}`)!;
		expect(identity).toMatch(/^[a-f0-9]{64}$/);
		expect(laneProcessIdentity(child.pid!, "codex:other")).toBeUndefined();
		expect(
			await reapLaneProcess(child.pid!, `codex:${id}`, "different-start-time"),
		).toBe(false);
		const exited = once(child, "exit");
		expect(await reapLaneProcess(child.pid!, `codex:${id}`, identity)).toBe(
			true,
		);
		await exited;
	} finally {
		setLaneProcessReaders();
		try {
			process.kill(-child.pid!, "SIGTERM");
		} catch {}
	}
});

it("yields during ps/lsof fallbacks and preserves identity checks", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-async-facts-"));
	const cwd = realpathSync(dir);
	const previous = process.env.PATH;
	const pid = 99999999;
	const id = "44444444-4444-4444-8444-444444444444";
	writeFileSync(
		join(dir, "ps"),
		`#!/bin/sh\n/bin/sleep 0.1\nprintf '${pid} Thu Nov 19 12:00:00 2026 ${id}\\n'\n`,
	);
	writeFileSync(
		join(dir, "lsof"),
		`#!/bin/sh\n/bin/sleep 0.1\nprintf 'n${cwd}\\n'\n`,
	);
	chmodSync(join(dir, "ps"), 0o700);
	chmodSync(join(dir, "lsof"), 0o700);
	let heartbeats = 0;
	const timer = setInterval(() => heartbeats++, 10);
	process.env.PATH = dir;
	try {
		const identity = await laneProcessIdentityAsync(pid, `codex:${id}`, cwd);
		expect(identity).toMatch(/^v2:[a-f0-9]{64}$/);
		expect(heartbeats).toBeGreaterThan(0);
		expect(
			await laneProcessIdentityAsync(pid, "codex:other", cwd),
		).toBeUndefined();
		expect(await reapLaneProcess(pid, `codex:${id}`, "v2:wrong", cwd)).toBe(
			false,
		);
	} finally {
		clearInterval(timer);
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
