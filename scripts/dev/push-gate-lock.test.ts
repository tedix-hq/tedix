import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = new URL("./push-gate-lock.py", import.meta.url).pathname;

test("three gate runners serialize across independent checkouts and preserve failures", async () => {
	const home = mkdtempSync(join(tmpdir(), "push-gate-lock-"));
	const events = join(home, "events");
	const gate = join(home, "gate.sh");
	writeFileSync(
		gate,
		'echo "start $1" >> "$2"\nsleep 0.2\necho "end $1" >> "$2"\nexit "$1"\n',
	);
	const children = [0, 1, 2].map((id) =>
		Bun.spawn(["python3", runner, gate, String(id), events], {
			cwd: id === 0 ? home : tmpdir(),
			env: { ...process.env, HOME: home },
			stdout: "ignore",
			stderr: "ignore",
		}),
	);
	try {
		expect(await Promise.all(children.map((child) => child.exited))).toEqual([
			0, 1, 2,
		]);
		const lines = readFileSync(events, "utf8").trim().split("\n");
		expect(lines).toHaveLength(6);
		for (let i = 0; i < lines.length; i += 2) {
			expect(lines[i]).toMatch(/^start [012]$/);
			expect(lines[i + 1]).toBe(lines[i]!.replace("start", "end"));
		}
	} finally {
		for (const child of children) child.kill();
		rmSync(home, { recursive: true, force: true });
	}
});

test("killing the hook keeps the lock until its gate descendant exits", async () => {
	const home = mkdtempSync(join(tmpdir(), "push-gate-orphan-"));
	const gate = join(home, "gate.sh");
	const env = { ...process.env, HOME: home };
	writeFileSync(gate, "sleep 0.5 &\necho ready\nwait\n");
	const holder = Bun.spawn(["python3", runner, gate], { env, stdout: "pipe" });
	const reader = holder.stdout.getReader();
	await reader.read();
	holder.kill("SIGKILL");
	await holder.exited;
	const probe = Bun.spawn(
		[
			"python3",
			"-c",
			'import fcntl, os\nf=open(os.path.expanduser("~/.cache/tedix/pre-push-gates.lock"), "r+")\ntry:\n fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError:\n exit(42)',
		],
		{ env },
	);
	try {
		expect(await probe.exited).toBe(42);
		await reader.read();
		const next = Bun.spawn(["python3", runner, "-c", "exit 0"], { env });
		expect(await next.exited).toBe(0);
	} finally {
		reader.releaseLock();
		rmSync(home, { recursive: true, force: true });
	}
});
