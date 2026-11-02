import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import {
	laneProcessIdentity,
	reapLaneProcess,
	setLaneProcessReaders,
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
		expect(reapLaneProcess(child.pid!, session, legacy, cwd)).toBe(false);
		expect(reapLaneProcess(child.pid!, "codex:other", identity, cwd)).toBe(
			false,
		);
		expect(reapLaneProcess(child.pid!, session, identity, tmpdir())).toBe(
			false,
		);
		expect(reapLaneProcess(child.pid!, session, identity)).toBe(false);
		expect(
			reapLaneProcess(child.pid!, session, `v2:${"0".repeat(64)}`, cwd),
		).toBe(false);
		const exited = once(child, "exit");
		expect(reapLaneProcess(child.pid!, session, identity, cwd)).toBe(true);
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
			reapLaneProcess(child.pid!, `codex:${id}`, "different-start-time"),
		).toBe(false);
		const exited = once(child, "exit");
		expect(reapLaneProcess(child.pid!, `codex:${id}`, identity)).toBe(true);
		await exited;
	} finally {
		setLaneProcessReaders();
		try {
			process.kill(-child.pid!, "SIGTERM");
		} catch {}
	}
});
