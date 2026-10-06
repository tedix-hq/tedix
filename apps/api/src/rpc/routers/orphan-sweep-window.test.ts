/**
 * The orphan sweep's scan window.
 *
 * findOrphanRuns had an upper bound only, so every 2-minute tick re-evaluated the
 * entire history of `run.started` events — 918,036 rows read per call on
 * production, ~660M rows/day, roughly 48% of the platform's D1 read volume, to
 * return zero rows. A lower bound fixes that.
 *
 * The floor is only safe because a run can be a candidate at most ONCE: sweeping
 * it writes a terminal event, after which the NOT EXISTS permanently excludes it.
 * These pin both halves — the floor exists, and it does not drop a run that is
 * still legitimately orphaned inside the window.
 */

import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import {
	chatDispatchIdempotency,
	tediApprovalRequests,
	tediRuntimeEvents,
} from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { findOrphanRuns } from "./cognitive-runtime/recovery-artifacts";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(tediRuntimeEvents, chatDispatchIdempotency, tediApprovalRequests),
	);
	return createDbClient(createD1Facade(sqlite));
}

async function seedOrphan(
	db: ReturnType<typeof setup>,
	runId: string,
	startedAt: string,
) {
	// A `run.started` with no terminal event and no activity = an orphan.
	await db.insert(tediRuntimeEvents).values({
		id: `evt-${runId}`,
		organizationId: "org-1",
		tediId: "tedi-1",
		runId,
		kind: "run.started",
		runtimeBackend: "isolate",
		createdAt: startedAt,
	});
}

describe("findOrphanRuns scan window", () => {
	let db: ReturnType<typeof setup>;

	beforeEach(() => {
		db = setup();
	});

	it("returns an orphan inside the lookback window", async () => {
		await seedOrphan(db, "run-recent", ago(2 * HOUR));
		const found = await findOrphanRuns(db, { now: NOW });
		expect(found.map((c) => c.runId)).toContain("run-recent");
	});

	it("ignores an orphan older than the lookback window", async () => {
		// 30 days old — long since swept in reality, and re-checking it every two
		// minutes forever is what cost ~660M rows/day.
		await seedOrphan(db, "run-ancient", ago(30 * DAY));
		const found = await findOrphanRuns(db, { now: NOW });
		expect(found.map((c) => c.runId)).not.toContain("run-ancient");
	});

	it("still respects the orphan age ceiling inside the window", async () => {
		// Too recent to be considered orphaned yet — the upper bound still applies.
		await seedOrphan(db, "run-just-started", ago(60_000));
		const found = await findOrphanRuns(db, { now: NOW });
		expect(found.map((c) => c.runId)).not.toContain("run-just-started");
	});

	it("honours an explicit lookbackDays override", async () => {
		await seedOrphan(db, "run-10-days", ago(10 * DAY));
		expect(
			(await findOrphanRuns(db, { now: NOW })).map((c) => c.runId),
		).not.toContain("run-10-days");
		expect(
			(await findOrphanRuns(db, { now: NOW, lookbackDays: 14 })).map(
				(c) => c.runId,
			),
		).toContain("run-10-days");
	});
});
