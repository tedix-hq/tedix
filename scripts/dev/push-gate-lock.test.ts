import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd: string, ...args: string[]) {
	const result = Bun.spawnSync(["git", ...args], { cwd });
	expect(result.exitCode).toBe(0);
}

const runner = new URL("./push-gate-lock.py", import.meta.url).pathname;

test("gate runners serialize across shared worktrees without a writable home and preserve failures", async () => {
	const home = mkdtempSync(join(tmpdir(), "push-gate-lock-"));
	git(home, "init", "--quiet");
	git(
		home,
		"-c",
		"user.name=Example",
		"-c",
		"user.email=example@example.invalid",
		"commit",
		"--quiet",
		"--allow-empty",
		"-m",
		"fixture",
	);
	const worktree = join(home, "linked");
	git(home, "worktree", "add", "--quiet", "--detach", worktree);
	const events = join(home, "events");
	const gate = join(home, "gate.sh");
	writeFileSync(
		gate,
		'echo "start $1" >> "$2"\nsleep 0.2\necho "end $1" >> "$2"\nexit "$1"\n',
	);
	const children = [0, 1, 2].map((id) =>
		Bun.spawn(["python3", runner, gate, String(id), events], {
			cwd: id === 0 ? home : worktree,
			env: { ...process.env, HOME: "/dev/null" },
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
	git(home, "init", "--quiet");
	const gate = join(home, "gate.sh");
	const env = { ...process.env, HOME: home };
	writeFileSync(gate, "sleep 0.5 &\necho ready\nwait\n");
	const holder = Bun.spawn(["python3", runner, gate], {
		cwd: home,
		env,
		stdout: "pipe",
	});
	const reader = holder.stdout.getReader();
	await reader.read();
	holder.kill("SIGKILL");
	await holder.exited;
	const probe = Bun.spawn(
		[
			"python3",
			"-c",
			'import fcntl\nf=open(".git/pre-push-gates.lock", "r+")\ntry:\n fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError:\n exit(42)',
		],
		{ cwd: home, env },
	);
	try {
		expect(await probe.exited).toBe(42);
		await reader.read();
		const next = Bun.spawn(["python3", runner, "-c", "exit 0"], {
			cwd: home,
			env,
		});
		expect(await next.exited).toBe(0);
	} finally {
		reader.releaseLock();
		rmSync(home, { recursive: true, force: true });
	}
});

for (const status of [0, 7]) {
	test(`denied lock creation runs every gate unserialized and preserves exit ${status}`, async () => {
		const repo = mkdtempSync(join(tmpdir(), "push-gate-denied-"));
		git(repo, "init", "--quiet");
		const gate = join(repo, "gate.sh");
		writeFileSync(gate, 'cat\necho gate-one\necho gate-two\nexit "$1"\n');
		// Inject the sandbox denial at the OS call, including for privileged test users.
		const sandbox = [
			"import errno, runpy, sys",
			"def deny_lock(event, args):",
			' if event == "open" and str(args[0]).endswith("pre-push-gates.lock"):',
			'  raise PermissionError(errno.EACCES, "sandbox denied")',
			"sys.addaudithook(deny_lock)",
			"sys.argv = sys.argv[1:]",
			'runpy.run_path(sys.argv[0], run_name="__main__")',
		].join("\n");
		const child = Bun.spawn(
			["python3", "-c", sandbox, runner, gate, String(status)],
			{
				cwd: repo,
				env: { ...process.env, HOME: "/dev/null" },
				stdin: new Blob(["push-ref-input\n"]),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		try {
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(status);
			expect(stdout).toBe("push-ref-input\ngate-one\ngate-two\n");
			expect(stderr).toBe(
				"pre-push: gate lock unavailable; running all gates unserialized\n",
			);
		} finally {
			child.kill();
			rmSync(repo, { recursive: true, force: true });
		}
	});
}
