import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	retryRefusal,
	selectTrain,
	STALE_MS,
	tryAcquire,
	waitNote,
} from "./push-queue";
import { splitRejected, type Lane } from "./push-train";

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

	test("a lock older than STALE_MS is recovered even if its pid lives", () => {
		const file = join(tmp(), "lock");
		writeFileSync(file, JSON.stringify({ pid: 1, startedAt: 0 }));
		expect(tryAcquire(file, STALE_MS + 1, () => true)).toBe(true);
	});

	test("a live train never times out during per-lane fallback; a dead one recovers", () => {
		expect(
			isStale({ pid: 1, startedAt: 0, train: true }, STALE_MS + 1, () => true),
		).toBe(false);
		expect(
			isStale({ pid: 1, startedAt: 0, train: true }, STALE_MS + 1, () => false),
		).toBe(true);
	});

	test("a fresh lock still being written is left alone", () => {
		const file = join(tmp(), "lock");
		writeFileSync(file, "");
		expect(tryAcquire(file, Date.now(), () => true)).toBe(false);
	});

	test("isStale", () => {
		expect(isStale(null, 0)).toBe(true);
		expect(isStale({ pid: 1, startedAt: 0 }, 10, () => true)).toBe(false);
		expect(isStale({ pid: 1, startedAt: 0 }, 10, () => false)).toBe(true);
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

describe("gate retry budget", () => {
	test("refuses a third failure, resets on pass, and leaves another lane alone", () => {
		const file = join(tmp(), "retries.jsonl");
		const now = Date.now();
		recordRetry(file, {
			key: "lane-a|work-a",
			gate: "lint:repo",
			result: "failed",
			at: now - 1000,
		});
		recordRetry(file, {
			key: "lane-a|work-a",
			gate: "type-check",
			result: "failed",
			at: now,
		});
		expect(retryRefusal(file, "lane-a|work-a", now)).toContain(
			"lint:repo, type-check",
		);
		expect(retryRefusal(file, "lane-b|work-b", now)).toBeNull();
		recordRetry(file, {
			key: "lane-a|work-a",
			gate: "pass",
			result: "passed",
			at: now + 1,
		});
		expect(retryRefusal(file, "lane-a|work-a", now + 1)).toBeNull();
	});

	test("override bypasses the budget while priority does not", () => {
		const file = join(tmp(), "retries.jsonl");
		const now = Date.now();
		for (const gate of ["docs:public:check", "lint:repo"])
			recordRetry(file, { key: "lane|work", gate, result: "failed", at: now });
		expect(retryRefusal(file, "lane|work", now)).not.toBeNull();
		process.env.TEDIX_PUSH_RETRY_OVERRIDE = "1";
		try {
			expect(retryRefusal(file, "lane|work", now)).toBeNull();
		} finally {
			delete process.env.TEDIX_PUSH_RETRY_OVERRIDE;
		}
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

describe("weekly worktree gc", () => {
	test("is due when the stamp is missing or a week old", () => {
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
