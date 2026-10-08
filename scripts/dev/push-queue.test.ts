import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStale, liveTickets, STALE_MS, tryAcquire } from "./push-queue";

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
	test("orders by arrival and drops tickets of dead processes", () => {
		const dir = tmp();
		for (const name of ["300-1", `100-${DEAD}`, "200-2"])
			writeFileSync(join(dir, name), "");
		expect(liveTickets(dir, alive)).toEqual(["200-2", "300-1"]);
	});
});
