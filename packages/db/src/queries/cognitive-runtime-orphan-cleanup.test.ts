import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	claimOrphanWorkflowCleanup,
	confirmOrphanWorkflowCleanup,
	listPendingOrphanWorkflowCleanups,
} from "./cognitive-runtime-orphan-cleanup";

const now = new Date("2026-10-31T12:00:00Z");
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(tediRuntimeEvents));
	sqlite.exec(schemaDdl(auditEvents));
	const db = createDbClient(createD1Facade(sqlite));
	const event = {
		id: "orphan-1",
		organizationId: "org-1",
		tediId: "tedi-1",
		kind: "run.failed" as const,
		runId: "tedi-1:mcp:request-1",
		runtimeBackend: "cloudflare-agents" as const,
		createdAt: "2026-10-31T11:00:00Z",
		runtimeMetadata: {
			source: "scheduled.sweepOrphanRuns",
			reason: "runtime_dropped",
		},
	};
	await db.insert(tediRuntimeEvents).values(event);
	return { db, sqlite, event };
}
it("retries unconfirmed cleanup durably, atomically claims once and never changes the failure", async () => {
	const { db, sqlite } = await fixture();
	const [item] = await listPendingOrphanWorkflowCleanups(db, now);
	if (!item) throw new Error("Expected an orphan cleanup candidate");
	expect(item).toMatchObject({
		terminalEventId: "orphan-1",
		organizationId: "org-1",
		runId: "tedi-1:mcp:request-1",
	});
	expect(
		await claimOrphanWorkflowCleanup(
			db,
			{ ...item, organizationId: "other-org" },
			now,
		),
	).toBe(false);
	expect(await claimOrphanWorkflowCleanup(db, item, now)).toBe(true);
	expect(await claimOrphanWorkflowCleanup(db, item, now)).toBe(false);
	expect(await listPendingOrphanWorkflowCleanups(db, now)).toHaveLength(0);
	const later = new Date(now.getTime() + 11 * 60_000);
	expect(await listPendingOrphanWorkflowCleanups(db, later)).toHaveLength(1);
	expect(await claimOrphanWorkflowCleanup(db, item, later)).toBe(true);
	await confirmOrphanWorkflowCleanup(db, item, "terminated");
	await confirmOrphanWorkflowCleanup(db, item, "terminated");
	expect(
		await listPendingOrphanWorkflowCleanups(
			db,
			new Date(later.getTime() + 20 * 60_000),
		),
	).toHaveLength(0);
	expect(sqlite.prepare("SELECT kind FROM tedi_runtime_events").all()).toEqual([
		{ kind: "run.failed" },
	]);
});
it("excludes unrelated failures and protects later starts and successful/canceled runs in the same tenant", async () => {
	for (const kind of [
		"run.started",
		"run.completed",
		"run.canceled",
	] as const) {
		const { db, event } = await fixture();
		await db.insert(tediRuntimeEvents).values({
			...event,
			id: "newer",
			kind,
			createdAt: "2026-10-31T11:30:00Z",
		});
		expect(await listPendingOrphanWorkflowCleanups(db, now)).toHaveLength(0);
	}
	const { db, event } = await fixture();
	await db.insert(tediRuntimeEvents).values([
		{
			...event,
			id: "other-org-start",
			organizationId: "org-2",
			kind: "run.started",
			createdAt: "2026-10-31T11:30:00Z",
		},
		{ ...event, id: "non-orphan", runtimeMetadata: { source: "other" } },
		{ ...event, id: "future", createdAt: "2026-11-01T11:00:00Z" },
	]);
	expect(
		(await listPendingOrphanWorkflowCleanups(db, now)).map(
			(x) => x.terminalEventId,
		),
	).toEqual(["orphan-1"]);
});
it("rechecks eligibility at claim time if an operator restarted after discovery", async () => {
	const { db, event } = await fixture();
	const [item] = await listPendingOrphanWorkflowCleanups(db, now);
	if (!item) throw new Error("Expected an orphan cleanup candidate");
	await db.insert(tediRuntimeEvents).values({
		...event,
		id: "new-start",
		kind: "run.started",
		createdAt: "2026-10-31T11:30:00Z",
	});
	expect(await claimOrphanWorkflowCleanup(db, item, now)).toBe(false);
});

it("does not let old unconfirmed batches starve never-attempted orphans", async () => {
	const { db, event } = await fixture();
	for (let i = 0; i < 24; i++) {
		await db.insert(tediRuntimeEvents).values({
			...event,
			id: `later-${String(i).padStart(2, "0")}`,
			runId: `tedi-1:mcp:later-${i}`,
			createdAt: "2026-10-31T11:30:00Z",
		});
	}
	const first = await listPendingOrphanWorkflowCleanups(db, now);
	expect(first).toHaveLength(20);
	for (const item of first)
		expect(await claimOrphanWorkflowCleanup(db, item, now)).toBe(true);
	const waiting = await listPendingOrphanWorkflowCleanups(db, now);
	expect(waiting).toHaveLength(5);
	const afterCooldown = await listPendingOrphanWorkflowCleanups(
		db,
		new Date(now.getTime() + 11 * 60_000),
	);
	expect(afterCooldown).toHaveLength(20);
	expect(afterCooldown.slice(0, 5)).toEqual(waiting);
	expect(
		afterCooldown
			.slice(5)
			.every((item) =>
				first.some((old) => old.terminalEventId === item.terminalEventId),
			),
	).toBe(true);
});

it("does not age unconfirmed cleanup out of its durable queue", async () => {
	const { db, event } = await fixture();
	await db
		.insert(tediRuntimeEvents)
		.values({ ...event, id: "old-orphan", createdAt: "2026-09-01T11:00:00Z" });
	expect(
		(await listPendingOrphanWorkflowCleanups(db, now)).map(
			(x) => x.terminalEventId,
		),
	).toEqual(["old-orphan", "orphan-1"]);
});
