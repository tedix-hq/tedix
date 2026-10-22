import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { configureLogStore, createDbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import { logPartition } from "../schema/logs-db";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { tableDdl } from "../test/schema-ddl";
import {
	getAnalyticsAppFreshness,
	listAnalyticsAuditActivityWindow,
	listAnalyticsExecutionAuditRows,
	listAnalyticsTraceActivity,
	listRecentAnalyticsAuditActivity,
} from "./analytics-audit";
import { insertAuditEvent, searchAuditEvents } from "./audit";
import { listTediObservabilityRows } from "./cognitive-runtime";

const ORG = "org-fictional-lighthouse";
const TEDI = "tedi-example";

function store(from: string, to?: string) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		[auditEvents, tediRuntimeEvents, tedis, logPartition]
			.flatMap((table) => tableDdl(table, { foreignKeys: false }))
			.join("\n"),
	);
	sqlite
		.prepare("INSERT INTO log_partition VALUES (?, ?, ?, ?, ?)")
		.run(from, to ? "sealed" : "active", from, to ?? null, from);
	const binding = createD1Facade(sqlite);
	return { sqlite, binding, db: createDbClient(binding) };
}

async function split() {
	const main = store("2026-01-01");
	const old = store("2026-01-01", "2026-01-31T23:59:59.999Z");
	const active = store("2026-02-01");
	for (const [source, id, at] of [
		[old, "old", "2026-01-01"],
		[main, "middle", "2026-01-02"],
		[active, "new", "2026-02-01"],
	] as const) {
		await insertAuditEvent(source.db, {
			id,
			organizationId: ORG,
			actorId: TEDI,
			actorType: "tedi",
			action: "mcp.tool.execute",
			resourceType: "mcp_tool",
			resourceId: id,
			occurredAt: new Date(at),
			metadata: {
				appId: "app-example",
				executionId: "execution-example",
				traceId: "trace-example",
			},
		});
		await source.db.insert(tediRuntimeEvents).values({
			id,
			organizationId: ORG,
			tediId: TEDI,
			kind: "message.completed",
			runtimeBackend: "custom",
			payload: {},
			createdAt: `${at}T00:00:00.000Z`,
		});
	}
	configureLogStore(main.db, {
		LOGS_DB: active.binding,
		LOGS_DB_1: old.binding,
	});
	return { main, old, active };
}

describe("partition-aware query callers", () => {
	it("fans unbounded analytics out to historical bindings with tenant filters", async () => {
		const { main } = await split();
		const activity = await listRecentAnalyticsAuditActivity(main.db, {
			organizationId: ORG,
			limit: 2,
		});
		expect(activity.map((row) => row.resourceId)).toEqual(["new", "middle"]);
		for (const rows of [
			await listAnalyticsExecutionAuditRows(main.db, {
				organizationId: ORG,
				executionId: "execution-example",
			}),
			await listAnalyticsTraceActivity(main.db, {
				organizationId: ORG,
				traceId: "trace-example",
			}),
		])
			expect(rows.map((row) => row.resourceId)).toEqual([
				"old",
				"middle",
				"new",
			]);
		expect(
			await listRecentAnalyticsAuditActivity(main.db, {
				organizationId: "org-other",
				limit: 5,
			}),
		).toEqual([]);
	});

	it("passes date windows to directory pruning for search and analytics", async () => {
		const { main, active } = await split();
		const prepare = vi.spyOn(active.binding, "prepare");
		const startSeconds = Date.parse("2026-01-01") / 1000;
		const endSeconds = Date.parse("2026-01-31") / 1000;
		const rows = await listAnalyticsAuditActivityWindow(main.db, {
			organizationId: ORG,
			startSeconds,
			endSeconds,
			limit: 1,
		});
		expect(rows.map((row) => row.resourceId)).toEqual(["middle"]);
		const freshness = await getAnalyticsAppFreshness(main.db, {
			organizationId: ORG,
			appId: "app-example",
			windowStartSeconds: startSeconds,
			windowEndSeconds: endSeconds,
		});
		expect(freshness.countsRow?.totalEvents).toBe(2);
		const page = await searchAuditEvents(main.db, {
			organizationId: ORG,
			startDate: "2026-01-01",
			endDate: "2026-01-31",
			offset: 1,
			limit: 1,
		});
		expect(page.data.map((row) => row.id)).toEqual(["old"]);
		expect(page.total).toBe(2);
		expect(
			prepare.mock.calls.filter(([sql]) => sql.includes('"audit_events"')),
		).toEqual([]);
	});

	it("merges observability across partitions after checking main ownership", async () => {
		const { main } = await split();
		await main.db.insert(tedis).values({
			id: TEDI,
			organizationId: ORG,
			name: "Example",
			slug: "example",
		});
		const input = {
			organizationId: ORG,
			tediId: TEDI,
			from: "2026-01-01",
			to: "2026-03-01",
			limit: 2,
		};
		const rows = await listTediObservabilityRows(main.db, input);
		expect(rows.runtimeEvents.map((row) => row.id)).toEqual(["new", "middle"]);
		expect(rows.auditEvents.map((row) => row.id)).toEqual(["new", "middle"]);
		expect(rows.runtimeTruncated).toBe(true);
		expect(rows.auditTruncated).toBe(true);
		const other = await listTediObservabilityRows(main.db, {
			...input,
			organizationId: "org-other",
		});
		expect(other.runtimeEvents).toEqual([]);
		expect(other.auditEvents).toEqual([]);
	});

	it("keeps writers on LOGS_DB and supports a legacy database without metadata", async () => {
		const { main, old, active } = await split();
		await insertAuditEvent(main.db, {
			id: "written",
			actorId: "user-example",
			organizationId: ORG,
			actorType: "user",
			action: "mcp.tool.execute",
			resourceType: "mcp_tool",
		});
		expect(
			active.sqlite
				.prepare("SELECT id FROM audit_events WHERE id = 'written'")
				.get(),
		).toEqual({ id: "written" });
		expect(
			old.sqlite
				.prepare("SELECT id FROM audit_events WHERE id = 'written'")
				.get(),
		).toBeUndefined();
		active.sqlite.exec("DROP TABLE log_partition");
		configureLogStore(main.db, { LOGS_DB: active.binding });
		expect(
			(await searchAuditEvents(main.db, { organizationId: ORG })).data.map(
				(row) => row.id,
			),
		).toContain("written");
	});
});
