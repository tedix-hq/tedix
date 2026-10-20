import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detachedGitEnv } from "../oss/git-env";
import {
	finishLane,
	readResult,
	recoverTrainResults,
	runTrain,
	snapshotLane,
	type TrainTicket,
} from "./push-train";
import { selectPushRangeFiles } from "../ci/push-range-selection.mjs";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const env = detachedGitEnv();
function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}
function fixture(count: number) {
	const root = mkdtempSync(join(tmpdir(), "push-train-test-"));
	roots.push(root);
	const remote = join(root, "remote.git"),
		repo = join(root, "repo");
	git(root, "init", "--bare", remote);
	git(root, "init", "-b", "main", repo);
	git(repo, "config", "user.name", "Train Test");
	git(repo, "config", "user.email", "train@example.com");
	writeFileSync(join(repo, "shared"), "base\n");
	mkdirSync(join(repo, "scripts/oss"), { recursive: true });
	writeFileSync(
		join(repo, "scripts/oss/secret-scan.ts"),
		`import { appendFileSync, existsSync } from "node:fs";
appendFileSync(${JSON.stringify(join(root, "scans"))}, process.argv.join(" ") + "\\n");
if (existsSync("secret-marker")) process.exit(1);
`,
	);
	git(repo, "add", ".");
	git(repo, "commit", "-m", "base");
	git(repo, "remote", "add", "origin", remote);
	git(repo, "push", "-u", "origin", "main");
	const common = join(repo, ".git");
	const hook = join(common, "hooks", "pre-push");
	writeFileSync(
		hook,
		`#!/bin/sh
cat >> '${root}/pushes'
pwd >> '${root}/checkouts'
printf '%s\\n' "$TEDIX_PUSH_TRAIN_RANGES" >> '${root}/ranges'
if test -f '${root}/kill'; then kill -9 "$(cat '${root}/kill')"; rm '${root}/kill'; fi
sleep 0.04
if test -f red; then exit 1; fi
`,
	);
	chmodSync(hook, 0o755);
	git(repo, "config", "core.hooksPath", join(common, "hooks"));
	const tickets: TrainTicket[] = [];
	for (let i = 0; i < count; i++) {
		const cwd = join(root, `lane-${i}`);
		git(repo, "worktree", "add", "-b", `lane-${i}`, cwd, "main");
		writeFileSync(join(cwd, `file-${i}`), `${i}\n`);
		git(cwd, "add", ".");
		git(
			cwd,
			"commit",
			"-m",
			`lane ${i}\n\nWork-Item: work-${i}\nAgent-Session: session-${i}`,
		);
		const lane = snapshotLane(cwd, false)!;
		const file = join(root, `ticket-${i}`);
		writeFileSync(file, JSON.stringify(lane));
		tickets.push({ file, result: join(root, `result-${i}`), lane });
	}
	return {
		root,
		remote,
		repo,
		common,
		tickets,
		gates: () =>
			readFileSync(join(root, "pushes"), "utf8").trim().split("\n").length,
	};
}
function amend(ticket: TrainTicket, file: string, content: string) {
	writeFileSync(join(ticket.lane.cwd, file), content);
	git(ticket.lane.cwd, "add", ".");
	git(ticket.lane.cwd, "commit", "--amend", "--no-edit");
	ticket.lane = snapshotLane(ticket.lane.cwd, false)!;
}

describe("push train with real repositories and hooks", () => {
	describe("batched reference", () => {
		let f: ReturnType<typeof fixture>;
		beforeAll(() => {
			f = fixture(6);
		});
		test("six green lanes use one gate and retain each lane's trailers and SHA", () => {
			const before = performance.now();
			expect(runTrain(f.repo, f.common, f.tickets)).toBe(true);
			const elapsed = performance.now() - before;
			expect(f.gates()).toBe(1);
			const checkouts = readFileSync(join(f.root, "checkouts"), "utf8")
				.trim()
				.split("\n");
			expect(checkouts.every((path) => !path.includes("/.git/"))).toBe(true);
			for (const [i, ticket] of f.tickets.entries()) {
				const result = readResult(ticket.result)!;
				expect(result.code).toBe(0);
				expect(git(f.repo, "show", "-s", "--format=%B", result.sha!)).toContain(
					`Work-Item: work-${i}\nAgent-Session: session-${i}`,
				);
				expect(finishLane(ticket.lane, result, false)).toBe(0);
				expect(git(ticket.lane.cwd, "rev-parse", "HEAD")).toBe(result.sha!);
			}
			expect(git(f.remote, "rev-parse", "main")).toBe(
				readResult(f.tickets[5]!.result)!.sha!,
			);
			expect(git(f.repo, "worktree", "list")).not.toContain(
				"/.worktrees/push-train-",
			);
			console.log(`six-lane batch fixture: ${elapsed.toFixed(0)}ms (1 gate)`);
		});
	});
	describe("serial reference", () => {
		let serial: ReturnType<typeof fixture>;
		beforeAll(() => {
			serial = fixture(6);
		});
		test("six serial lanes retain six gate invocations", () => {
			const serialStart = performance.now();
			for (const ticket of serial.tickets)
				runTrain(serial.repo, serial.common, [ticket]);
			const serialElapsed = performance.now() - serialStart;
			expect(serial.gates()).toBe(6);
			console.log(
				`six-lane serial fixture: ${serialElapsed.toFixed(0)}ms (6 gates)`,
			);
		});
	});

	test("one red lane fails individually while the others publish in order", () => {
		const f = fixture(3);
		amend(f.tickets[1]!, "red", "bad\n");
		expect(runTrain(f.repo, f.common, f.tickets)).toBe(true);
		expect(f.tickets.map((t) => readResult(t.result)!.code)).toEqual([0, 1, 0]);
		expect(f.gates()).toBe(4);
		expect(
			git(f.remote, "ls-tree", "--name-only", "main").split("\n"),
		).not.toContain("red");
	});

	test("conflicting lanes fall back without blocking a later independent lane", () => {
		const f = fixture(3);
		amend(f.tickets[0]!, "shared", "first\n");
		amend(f.tickets[1]!, "shared", "second\n");
		expect(runTrain(f.repo, f.common, f.tickets)).toBe(true);
		expect(f.tickets.map((t) => readResult(t.result)!.code)).toEqual([0, 1, 0]);
		expect(git(f.remote, "show", "main:shared")).toBe("first");
	});

	test("ranges retain selectors for a file reverted by another lane", () => {
		const f = fixture(2);
		// Lane 2 descends from lane 1 and restores its file; the net diff hides it.
		git(f.tickets[1]!.lane.cwd, "reset", "--hard", f.tickets[0]!.lane.head);
		git(f.tickets[1]!.lane.cwd, "rm", "file-0");
		git(f.tickets[1]!.lane.cwd, "commit", "-m", "restore");
		f.tickets[1]!.lane = snapshotLane(f.tickets[1]!.lane.cwd, false)!;
		expect(runTrain(f.repo, f.common, f.tickets)).toBe(true);
		const args = JSON.parse(
			readFileSync(join(f.root, "ranges"), "utf8").trim(),
		) as string[];
		const ranges = [];
		for (let i = 0; i < args.length; i += 4)
			ranges.push({ base: args[i + 1]!, head: args[i + 3]! });
		expect(selectPushRangeFiles(f.repo, ranges)).toContain("file-0");
	});

	test("per-commit scans reject a secret even when a later lane removes it", () => {
		const f = fixture(3);
		amend(f.tickets[0]!, "secret-marker", "blocked");
		const second = f.tickets[1]!;
		git(second.lane.cwd, "reset", "--hard", f.tickets[0]!.lane.head);
		git(second.lane.cwd, "rm", "secret-marker");
		git(second.lane.cwd, "commit", "-m", "remove marker");
		second.lane = snapshotLane(second.lane.cwd, false)!;
		expect(runTrain(f.repo, f.common, f.tickets)).toBe(true);
		expect(f.tickets.map((t) => readResult(t.result)!.code)).toEqual([1, 1, 0]);
		expect(
			git(f.remote, "ls-tree", "--name-only", "main").split("\n"),
		).not.toContain("file-0");
	});

	test("a stale ticket does not reapply an upstream patch that was later reverted", () => {
		const f = fixture(2);
		git(
			f.repo,
			"-c",
			"user.name=Upstream Test",
			"cherry-pick",
			f.tickets[0]!.lane.head,
		);
		git(f.repo, "revert", "--no-edit", "HEAD");
		git(f.repo, "push", "origin", "HEAD:main");
		expect(runTrain(f.repo, f.common, f.tickets)).toBe(true);
		const files = git(f.remote, "ls-tree", "--name-only", "main").split("\n");
		expect(files).not.toContain("file-0");
		expect(files).toContain("file-1");
		for (const ticket of f.tickets)
			expect(readResult(ticket.result)!.code).toBe(0);
	});

	test("holder recovery after publication does not duplicate commits", () => {
		const f = fixture(2);
		runTrain(f.repo, f.common, f.tickets);
		const published = git(f.remote, "rev-parse", "main");
		const accepted = f.tickets.map((ticket) => ({
			ticket,
			sha: readResult(ticket.result)!.sha!,
		}));
		for (const ticket of f.tickets) {
			rmSync(`${ticket.result}.json`);
			writeFileSync(ticket.file, JSON.stringify(ticket.lane));
		}
		writeFileSync(
			join(f.common, "push-train-recovery.json"),
			JSON.stringify({ head: published, accepted }),
		);
		recoverTrainResults(f.repo, f.common);
		expect(git(f.remote, "rev-parse", "main")).toBe(published);
		for (const { ticket, sha } of accepted)
			expect(readResult(ticket.result)).toMatchObject({ code: 0, sha });
		expect(f.gates()).toBe(1);
	});

	test("changed checkouts are preserved when consuming a successful receipt", () => {
		const f = fixture(2);
		runTrain(f.repo, f.common, f.tickets);
		const ticket = f.tickets[1]!;
		writeFileSync(join(ticket.lane.cwd, "new-work"), "keep");
		finishLane(ticket.lane, readResult(ticket.result)!, false);
		expect(git(ticket.lane.cwd, "rev-parse", "HEAD")).toBe(ticket.lane.head);
		expect(readFileSync(join(ticket.lane.cwd, "new-work"), "utf8")).toBe(
			"keep",
		);
	});

	test("dry runs gate once without updating remote or checkout", () => {
		const f = fixture(2),
			base = git(f.remote, "rev-parse", "main");
		for (const ticket of f.tickets) ticket.lane.dryRun = true;
		expect(runTrain(f.repo, f.common, f.tickets)).toBe(false);
		expect(f.gates()).toBe(1);
		expect(git(f.remote, "rev-parse", "main")).toBe(base);
		for (const ticket of f.tickets) {
			expect(readResult(ticket.result)!.code).toBe(0);
			expect(readResult(ticket.result)!.sha).toBeUndefined();
		}
	});

	test.each([false, true])(
		"queued processes receive individual statuses (process dies: %s)",
		async (dies) => {
			const f = fixture(3);
			if (!dies) amend(f.tickets[1]!, "red", "bad\n");
			// Hold the machine lock until every real process has queued its snapshot.
			const lock = join(f.common, "push-queue.lock");
			writeFileSync(
				lock,
				JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
			);
			writeFileSync(join(f.common, "worktree-gc.stamp"), "test");
			const bin = join(f.root, "bin");
			mkdirSync(bin);
			writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
			chmodSync(join(bin, "gh"), 0o755);
			const processes = [];
			try {
				for (const ticket of f.tickets) {
					processes.push(
						Bun.spawn(
							[process.execPath, resolve(import.meta.dirname, "push-queue.ts")],
							{
								cwd: ticket.lane.cwd,
								env: { ...env, PATH: `${bin}:${env.PATH}` },
								stdout: "pipe",
								stderr: "pipe",
							},
						),
					);
					await Bun.sleep(30);
				}
				const queue = join(f.common, "push-queue");
				const deadline = Date.now() + 10000;
				while (
					(!existsSync(queue) || readdirSync(queue).length < 3) &&
					Date.now() < deadline
				)
					await Bun.sleep(20);
				expect(readdirSync(queue).length).toBe(3);
				if (dies)
					writeFileSync(join(f.root, "kill"), String(processes[1]!.pid));
				rmSync(lock);
				const codes = await Promise.all(processes.map((p) => p.exited));
				expect(codes[0]).toBe(0);
				expect(codes[1]).not.toBe(0);
				expect(codes[2]).toBe(0);
				const outputs = await Promise.all(
					processes.map((p) => new Response(p.stdout).text()),
				);
				expect(outputs[0]).toContain("pushed SHA");
				expect(outputs[2]).toContain("pushed SHA");
				expect(f.gates()).toBe(dies ? 1 : 4);
				expect(
					git(f.remote, "ls-tree", "--name-only", "main")
						.split("\n")
						.includes("file-1"),
				).toBe(dies);
			} finally {
				for (const p of processes) p.kill();
			}
		},
		20000,
	);
});
