import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	GC_EVERY_MS,
	gcDue,
	isStale,
	liveTickets,
	MAX_TRAIN_LANES,
	readHistory,
	readRetryHistory,
	recordTrain,
	recordRetry,
	chargeRejection,
	selectTrain,
	sharesHistoryWithMain,
	ticketKey,
	tryAcquire,
	waitNote,
} from "./push-queue";
import { splitRejected, type Lane } from "./push-train";
import {
	failedPushGate,
	formatVerdict,
	gateFailureKind,
	overallVerdict,
	parseVerdict,
	pushRejection,
	refusalSentence,
	type PushRefusal,
} from "./push-gate-failure";

const tmp = () => mkdtempSync(join(tmpdir(), "push-queue-"));
const DEAD = 99999;
const alive = (pid: number) => pid !== DEAD;

describe("push queue lock", () => {
	test("first caller takes the lock; a second is refused while the holder lives", () => {
		const file = join(tmp(), "lock");
		expect(tryAcquire(file, 1000, () => true)).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
		expect(tryAcquire(file, 2000, () => true)).toBe(false);
	});

	test("a lock held by a dead process is recovered", () => {
		const file = join(tmp(), "lock");
		writeFileSync(file, JSON.stringify({ pid: DEAD, startedAt: Date.now() }));
		expect(tryAcquire(file, Date.now(), alive)).toBe(true);
	});

	test("a living single-push holder is never evicted during long gates", () => {
		const file = join(tmp(), "lock");
		writeFileSync(file, JSON.stringify({ pid: 1, startedAt: 0 }));
		expect(tryAcquire(file, 24 * 60 * 60 * 1000, () => true)).toBe(false);
	});

	test("a live train never times out during per-lane fallback; a dead one recovers", () => {
		expect(isStale({ pid: 1, startedAt: 0, train: true }, () => true)).toBe(
			false,
		);
		expect(isStale({ pid: 1, startedAt: 0, train: true }, () => false)).toBe(
			true,
		);
	});

	test("a fresh lock still being written is left alone", () => {
		const file = join(tmp(), "lock");
		writeFileSync(file, "");
		expect(tryAcquire(file, Date.now(), () => true)).toBe(false);
	});

	test("isStale", () => {
		expect(isStale(null)).toBe(true);
		expect(isStale({ pid: 1, startedAt: 0 }, () => true)).toBe(false);
		expect(isStale({ pid: 1, startedAt: 0 }, () => false)).toBe(true);
	});
});

describe("push queue tickets", () => {
	test("priority tickets precede waiting lanes using the existing ticket reader", () => {
		const dir = tmp();
		for (const name of ["300-1", "0-2"]) writeFileSync(join(dir, name), "");
		expect(liveTickets(dir, alive)).toEqual(["0-2", "300-1"]);
	});
	test("orders by arrival and drops tickets of dead processes", () => {
		const dir = tmp();
		for (const name of ["300-1", `100-${DEAD}`, "200-2"])
			writeFileSync(join(dir, name), "");
		expect(liveTickets(dir, alive)).toEqual(["200-2", "300-1"]);
	});
});

const lane = (head: string, dryRun = false): Lane => ({
	version: 1,
	cwd: `/lanes/${head}`,
	head: head.repeat(40).slice(0, 40),
	base: "0".repeat(40),
	branch: `refs/heads/${head}`,
	dryRun,
});

describe("train selection", () => {
	test("skips incompatible tickets instead of ending the train", () => {
		const waiting = [
			{ file: "a", lane: lane("a") },
			{ file: "raw", lane: null },
			{ file: "b", lane: lane("b") },
			{ file: "dry", lane: lane("c", true) },
			{ file: "moved", lane: lane("d") },
			{ file: "e", lane: lane("e") },
			{
				file: "other-session",
				lane: { ...lane("f"), agentSession: "codex:other" },
			},
		];
		const unchanged = (l: Lane) => l.cwd !== "/lanes/d";
		expect(
			selectTrain(waiting, false, unchanged).map((entry) => entry.file),
		).toEqual(["a", "b", "e"]);
	});

	test("caps a train at MAX_TRAIN_LANES in arrival order", () => {
		const waiting = Array.from({ length: MAX_TRAIN_LANES + 5 }, (_, i) => ({
			file: String(i),
			lane: lane(String(i % 10)),
		}));
		const train = selectTrain(waiting, false, () => true);
		expect(train.map((entry) => entry.file)).toEqual(
			waiting.slice(0, MAX_TRAIN_LANES).map((entry) => entry.file),
		);
	});
});

describe("rejected candidates", () => {
	test("small batches fall back lane by lane; larger ones split in arrival-ordered halves", () => {
		expect(splitRejected([1, 2, 3])).toEqual([[1], [2], [3]]);
		expect(splitRejected([1, 2, 3, 4, 5])).toEqual([
			[1, 2, 3],
			[4, 5],
		]);
	});
});

describe("wait estimate", () => {
	const minute = 60_000;
	const history = [4, 6, 5].map((m) => ({
		startedAt: 0,
		finishedAt: m * minute,
		lanes: 8,
	}));

	test("a lane inside the running train says so", () => {
		expect(
			waitNote({
				ticket: "2-b",
				tickets: ["1-a", "2-b", "3-c"],
				holder: { pid: 1, startedAt: 0, train: true, lanes: ["1-a", "2-b"] },
				history,
				now: 2 * minute,
			}),
		).toBe(
			"push: your lane is in the running train; a train of 2 lanes has run for 2 min.",
		);
	});

	test("estimates from the median hold and the trains ahead", () => {
		const tickets = Array.from(
			{ length: MAX_TRAIN_LANES + 3 },
			(_, i) => `${i}-x`,
		);
		const note = waitNote({
			ticket: tickets.at(-1)!,
			tickets,
			holder: { pid: 1, startedAt: 0, train: true, lanes: ["0-x", "1-x"] },
			history,
			now: 2 * minute,
		});
		// 3 min left in the running train, one full train ahead (5 min median).
		expect(note).toBe(
			`push: ${MAX_TRAIN_LANES} waiting ahead of you; a train of 2 lanes has run for 2 min. Estimated start in ~8 min, done in ~13 min (recent lock holds: 5 min median).`,
		);
	});

	test("no history means no estimate", () => {
		expect(
			waitNote({
				ticket: "2-b",
				tickets: ["1-a", "2-b"],
				holder: { pid: 1, startedAt: 0 },
				history: [],
				now: minute,
			}),
		).toBe("push: 1 waiting ahead of you; a push has run for 1 min.");
	});

	test("history keeps the most recent holds and ignores malformed lines", () => {
		const file = join(tmp(), "history.jsonl");
		writeFileSync(file, "not json\n");
		expect(readHistory(file)).toEqual([]);
		writeFileSync(file, '{"startedAt":1}\n');
		expect(readHistory(file)).toEqual([]);
		for (let i = 0; i < 60; i++)
			recordTrain(file, { startedAt: i, finishedAt: i + 1, lanes: 1 });
		const kept = readHistory(file);
		expect(kept).toHaveLength(50);
		expect(kept.at(-1)!.startedAt).toBe(59);
	});
});

describe("gate failure history", () => {
	test("excludes only missing-module preflight startup crashes", () => {
		const crash =
			"error: Cannot find package 'jsonc-parser' from '/repo/scripts/ci/preflight-gates.mjs'";
		expect(failedPushGate(crash)).toBeNull();
		expect(
			failedPushGate(
				"Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'oxc-parser' imported from /repo/scripts/ci/preflight-gates.mjs",
			),
		).toBeNull();
		expect(failedPushGate("pre-push: type-check (1/3)\n" + crash)).toBe(
			"pre-push gates",
		);
		expect(failedPushGate("✗ type-check (1s)\n" + crash)).toBe("type-check");
		expect(failedPushGate("remote: permission denied")).toBe("pre-push gates");
		expect(failedPushGate("Cannot find module 'app-dependency'")).toBe(
			"pre-push gates",
		);
	});
	test("records failures diagnostically and leaves a red main uncharged", () => {
		const file = join(tmp(), "retries.jsonl");
		for (let i = 0; i < 8; i++) {
			expect(
				chargeRejection(file, "lane|work", {
					kind: "change",
					gate: "type-check",
				}),
			).toContain("fix what it reports");
		}
		chargeRejection(file, "lane|work", { kind: "main", gate: "type-check" });
		expect(readRetryHistory(file)).toHaveLength(8);
	});

	test("keeps retry history trimmed to fifty entries", () => {
		const file = join(tmp(), "retries.jsonl");
		for (let i = 0; i < 60; i++)
			recordRetry(file, {
				key: "lane|work",
				gate: `gate-${i}`,
				result: "failed",
				at: i,
			});
		expect(readRetryHistory(file)).toHaveLength(50);
		expect(readRetryHistory(file).at(-1)?.gate).toBe("gate-59");
	});
});

describe("whose failure a failed gate is", () => {
	// Runner output as vitest 5.1 and bun 1.4 print it, captured 16 Nov 2026.
	const hookTimeout = ` ❯ src/rpc/fleet-authority-coverage.test.ts (5 tests | 5 skipped) 120014ms

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/rpc/fleet-authority-coverage.test.ts [ src/rpc/fleet-authority-coverage.test.ts ]
Error: Hook timed out in 120000ms.
If this is a long-running hook, pass a timeout value as the last argument or configure it globally with "hookTimeout".

 Test Files  1 failed | 4 passed (5)
      Tests  18 passed | 5 skipped (23)
error: script "test:unit" exited with code 1`;
	const testTimeout = ` FAIL  src/a.test.ts > slow
Error: Test timed out in 20000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
`;
	const thrown = ` FAIL  src/a.test.ts > typeerror
TypeError: Cannot read properties of undefined (reading 'x')
`;
	const assertion = ` FAIL  src/a.test.ts > assert
AssertionError: expected 1 to be 2 // Object.is equality
`;
	const bunTimeout = `(fail) slow [200.38ms]
  ^ this test timed out after 200ms.
`;

	test("only timeouts and a killed or exhausted process are the machine's", () => {
		expect(gateFailureKind({ output: hookTimeout })).toBe("infrastructure");
		expect(gateFailureKind({ output: testTimeout })).toBe("infrastructure");
		expect(gateFailureKind({ output: bunTimeout })).toBe("infrastructure");
		expect(gateFailureKind({ output: "", signal: "SIGKILL" })).toBe(
			"infrastructure",
		);
		expect(gateFailureKind({ output: "", spawnFailed: true })).toBe(
			"infrastructure",
		);
		expect(
			gateFailureKind({
				output:
					"FATAL ERROR: Reached heap limit - JavaScript heap out of memory",
			}),
		).toBe("infrastructure");
	});

	test("a failed assertion counts as the change's, even beside a timeout", () => {
		expect(gateFailureKind({ output: assertion })).toBe("change");
		expect(gateFailureKind({ output: testTimeout + assertion })).toBe("change");
		expect(gateFailureKind({ output: testTimeout + thrown })).toBe("change");
		expect(
			gateFailureKind({ output: `${bunTimeout}(fail) throws [0.43ms]\n` }),
		).toBe("change");
		expect(
			gateFailureKind({
				output: `${bunTimeout}error: expect(received).toBe(expected)\n(fail) assert [0.06ms]\n`,
			}),
		).toBe("change");
		expect(
			gateFailureKind({
				output: "src/a.ts(1,2): error TS2322: Type 'string' is not assignable",
			}),
		).toBe("change");
		// A gate that printed nothing recognizable is never excused.
		expect(gateFailureKind({ output: "lint failed" })).toBe("change");
		expect(
			gateFailureKind({ output: "ENOSPC\n FAIL  src/a.test.ts > x\n" }),
		).toBe("change");
	});

	test("one verdict per run: the change first, then a red main, then the machine", () => {
		const of = (...kinds: ("change" | "infrastructure" | "main")[]) =>
			overallVerdict(kinds.map((kind) => ({ kind, gate: `${kind} gate` })))
				?.kind;
		expect(of("infrastructure", "main", "change")).toBe("change");
		expect(of("infrastructure", "main")).toBe("main");
		expect(of("infrastructure")).toBe("infrastructure");
		expect(overallVerdict([])).toBeNull();
	});

	test("the queue reads the gate runner's verdict and treats anything else as the change's", () => {
		const verdict = {
			kind: "infrastructure",
			gate: "tests (apps/api)",
		} as const;
		const output = `✗ tests (apps/api) (4m02s)\nremote: noise\n${formatVerdict(verdict)}\nerror: failed to push some refs`;
		expect(parseVerdict(output)).toEqual(verdict);
		expect(pushRejection(output)).toEqual(verdict);
		expect(pushRejection("✗ type-check (1s)")).toEqual({
			kind: "change",
			gate: "type-check",
		});
		expect(
			pushRejection('pre-push-verdict: {"kind":"fine","gate":"x"}'),
		).toEqual({
			kind: "change",
			gate: "pre-push gates",
		});
		expect(pushRejection("pre-push-verdict: {torn")).toEqual({
			kind: "change",
			gate: "pre-push gates",
		});
		expect(
			pushRejection(
				"error: Cannot find package 'jsonc-parser' from '/repo/scripts/ci/preflight-gates.mjs'",
			),
		).toBeNull();
	});

	test("every refusal is one sentence that says what to do next", () => {
		const gate = "type-check apps/os";
		const refusals: PushRefusal[] = [
			{ reason: "gate", verdict: { kind: "change", gate } },
			{ reason: "gate", verdict: { kind: "infrastructure", gate } },
			{ reason: "gate", verdict: { kind: "main", gate } },
			{ reason: "dependencies" },
			{ reason: "fetch" },
			{ reason: "conflict" },
			{ reason: "replaced-history" },
			{ reason: "expected-main" },
			{ reason: "main-moving" },
			{ reason: "secret-scan" },
		];
		for (const refusal of refusals) {
			const sentence = refusalSentence(refusal);
			expect(sentence).toMatch(/^Push refused: [^\n]+\.$/);
			// One sentence: no full stop followed by another clause.
			expect(sentence.slice(0, -1)).not.toMatch(/\.\s/);
		}
		expect(
			refusalSentence({ reason: "gate", verdict: { kind: "main", gate } }),
		).toContain("wait for main to be fixed, then run bun run push again");
	});
});

describe("daily worktree gc", () => {
	test("is due when the stamp is missing or a day old", () => {
		const stamp = join(
			mkdtempSync(join(tmpdir(), "push-gc-")),
			"worktree-gc.stamp",
		);
		expect(gcDue(stamp)).toBe(true);
		writeFileSync(stamp, "x");
		const now = Date.now();
		expect(gcDue(stamp, now)).toBe(false);
		const old = (now - GC_EVERY_MS - 1000) / 1000;
		utimesSync(stamp, old, old);
		expect(gcDue(stamp, now)).toBe(true);
	});
});

describe("push ticket key", () => {
	test("prefers TEDIX_WORK_ID over the commit trailer", () => {
		const cwd = process.cwd();
		const previous = process.env.TEDIX_WORK_ID;
		process.env.TEDIX_WORK_ID = "explicit-item";
		try {
			expect(ticketKey(cwd)).toBe(`${resolve(cwd)}|explicit-item`);
		} finally {
			if (previous === undefined) delete process.env.TEDIX_WORK_ID;
			else process.env.TEDIX_WORK_ID = previous;
		}
	});
});

describe("a checkout from before main's history was replaced", () => {
	test("shares no history with main, so the push stops before any rebase", () => {
		const cwd = mkdtempSync(join(tmpdir(), "push-replaced-"));
		const git = (...args: string[]) =>
			execFileSync(
				"git",
				["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
				{ cwd, encoding: "utf8" },
			).trim();
		git("init", "--quiet");
		writeFileSync(join(cwd, "file.txt"), "old\n");
		git("add", "file.txt");
		git("commit", "--quiet", "-m", "old history");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		expect(sharesHistoryWithMain(cwd)).toBe(true);
		// The same tree as a new root commit: what a history rewrite leaves.
		const rewritten = git("commit-tree", "HEAD^{tree}", "-m", "new history");
		git("update-ref", "refs/remotes/origin/main", rewritten);
		expect(sharesHistoryWithMain(cwd)).toBe(false);
	});
});
