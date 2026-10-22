import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { configureLogStore, createDbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import { logPartition } from "../schema/logs-db";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getAuditEventsByResource,
	insertAuditEvent,
	searchAuditEvents,
} from "./audit";
import {
	getAnalyticsAppFreshness,
	listRecentAnalyticsAuditActivity,
} from "./analytics-audit";

function store() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(auditEvents, logPartition));
	const binding = createD1Facade(sqlite);
	return { sqlite, binding, db: createDbClient(binding) };
}

const event = {
	organizationId: "org-example",
	actorId: "user-example",
	actorType: "user" as const,
	action: "mcp.tool.execute",
	resourceType: "mcp_tool",
	resourceId: "example_tool",
	metadata: {
		appId: "app-example",
		clientId: "client-example",
		oauthClientId: "client-example",
	},
};

describe("optional audit log store", () => {
	it("retains legacy behavior without a binding and security events in main with a binding", async () => {
		const main = store();
		const logs = store();
		await insertAuditEvent(main.db, { ...event, id: "legacy" });
		configureLogStore(main.db, { LOGS_DB: logs.binding });
		await insertAuditEvent(main.db, { ...event, id: "tool" });
		await insertAuditEvent(main.db, {
			...event,
			id: "denied",
			action: "mcp.access.denied",
		});
		expect(
			main.sqlite.prepare("SELECT id FROM audit_events ORDER BY id").all(),
		).toEqual([{ id: "denied" }, { id: "legacy" }]);
		expect(logs.sqlite.prepare("SELECT id FROM audit_events").all()).toEqual([
			{ id: "tool" },
		]);
		expect(
			(await searchAuditEvents(main.db, { organizationId: "org-other" })).total,
		).toBe(0);
		const resource = await getAuditEventsByResource(
			main.db,
			event.organizationId,
			event.resourceType,
			event.resourceId,
		);
		expect(resource).toHaveLength(3);
		expect(
			resource.every(
				(row) =>
					row.metadata?.clientId === "client-example" &&
					!("oauthClientId" in row.metadata),
			),
		).toBe(true);
	});

	it("paginates the merged timeline and sums analytics across the cutover", async () => {
		const main = store();
		const logs = store();
		await insertAuditEvent(main.db, {
			...event,
			id: "old",
			occurredAt: new Date("2026-01-01T00:00:00Z"),
		});
		configureLogStore(main.db, { LOGS_DB: logs.binding });
		await insertAuditEvent(main.db, {
			...event,
			id: "new",
			occurredAt: new Date("2026-01-03T00:00:00Z"),
		});
		await insertAuditEvent(main.db, {
			...event,
			id: "middle",
			action: "mcp.tool.error",
			occurredAt: new Date("2026-01-02T00:00:00Z"),
		});
		const page = await searchAuditEvents(main.db, {
			organizationId: event.organizationId,
			limit: 1,
			offset: 1,
		});
		expect(page.total).toBe(3);
		expect(page.data.map((row) => row.id)).toEqual(["middle"]);
		const activity = await listRecentAnalyticsAuditActivity(main.db, {
			organizationId: event.organizationId,
			limit: 2,
		});
		expect(activity.map((row) => row.action)).toEqual([
			"mcp.tool.execute",
			"mcp.tool.error",
		]);
		expect(activity[0]?.oauthClientId).toBe("client-example");
		const freshness = await getAnalyticsAppFreshness(main.db, {
			organizationId: event.organizationId,
			appId: "app-example",
			windowStartSeconds: 0,
			windowEndSeconds: 2000000000,
		});
		expect(freshness.countsRow).toEqual({
			totalEvents: 3,
			toolExecutions: 2,
			toolErrors: 1,
			codeExecutions: 0,
		});
	});

	it("preserves audit search across rotation with duplicates and tenant scope", async () => {
		const main = store();
		const old = store();
		const active = store();
		await insertAuditEvent(old.db, {
			...event,
			id: "old",
			occurredAt: new Date("2026-01-01"),
		});
		await insertAuditEvent(main.db, {
			...event,
			id: "duplicate",
			occurredAt: new Date("2026-01-02"),
		});
		await insertAuditEvent(old.db, {
			...event,
			id: "duplicate",
			occurredAt: new Date("2026-01-02"),
		});
		await insertAuditEvent(active.db, {
			...event,
			id: "new",
			occurredAt: new Date("2026-01-03"),
		});
		configureLogStore(main.db, {
			LOGS_DB: active.binding,
			LOGS_DB_9: old.binding,
		});
		const result = await searchAuditEvents(main.db, {
			organizationId: event.organizationId,
			limit: 2,
			offset: 1,
		});
		expect(result.data.map((row) => row.id)).toEqual(["duplicate", "old"]);
		expect(
			(
				await getAuditEventsByResource(
					main.db,
					event.organizationId,
					event.resourceType,
					event.resourceId,
				)
			).map((row) => row.id),
		).toEqual(["new", "duplicate", "old"]);
		expect(
			(await searchAuditEvents(main.db, { organizationId: "org-other" })).data,
		).toEqual([]);
	});
});
