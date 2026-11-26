import { eq } from "drizzle-orm";
import { listGovernanceAuditEvents } from "./governance-overview";
import { listHomeOperatorDecisionAuditEvents } from "./home-reflection";
import { coreDb, withCoreStore } from "../core-store/scope";
import { organizations } from "../schema/organizations";
import { updateOrganization } from "./organizations";
import {
	drainAuditDeliveryOutbox,
	readAuditEventById,
	readAuditStores,
	auditReadColumns,
	auditReadTable,
} from "./audit-delivery";
import type { OrganizationAuditEvent } from "./durable-sqlite/organization-log-rpc";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { configureLogStore, createDbClient } from "../client";
import { auditDeliveryOutbox, auditEvents } from "../schema/audit-events";
import { auditMetadataRefs } from "../schema/audit-metadata-refs";
import { logPartition } from "../schema/logs-db";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";

import {
	buildInsertAuditEventStatement,
	getAuditEventsByResource,
	insertAuditEvent,
	insertAuditEventsBatch,
	insertMcpAuditEventsBatch,
	moveRoutineAuditEventsToLogs,
	searchAuditEvents,
} from "./audit";
import {
	copyD1RetentionRowsToLogs,
	d1RetentionPolicyCutoff,
	deleteD1RetentionRows,
	getD1RetentionTableSpec,
	isD1RetentionExpired,
	readD1RetentionPage,
	verifyD1LogsCopy,
} from "./d1-retention";
import {
	getAnalyticsAppFreshness,
	listRecentAnalyticsAuditActivity,
} from "./analytics-audit";

function store() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			auditDeliveryOutbox,
			auditEvents,
			auditMetadataRefs,
			logPartition,
		),
	);
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
	it("routes policy approvals and drains atomic receipts without losing rows on failure or replay", async () => {
		const main = store();
		const logs = store();
		configureLogStore(main.db, { LOGS_DB: logs.binding });
		const policy = {
			...event,
			action: "approval.approved",
			metadata: { resolvedBy: "policy", approvalReason: "Tenant rule" },
		};
		await insertAuditEvent(main.db, { ...policy, id: "direct" });
		await insertAuditEvent(main.db, {
			...event,
			id: "human",
			action: "approval.approved",
		});
		await insertAuditEventsBatch(
			main.db,
			Array.from({ length: 20 }, (_, i) => ({
				...policy,
				id: `atomic-${i}`,
				organizationId: i % 2 ? "org-other" : event.organizationId,
			})),
		);
		await main.db.batch([
			buildInsertAuditEventStatement(main.db, {
				...event,
				id: "expiry",
				action: "interaction.expiry.run",
				metadata: { expiredIds: ["request"] },
			}).statement,
		]);
		logs.sqlite.exec(
			"CREATE TRIGGER fail_copy BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'copy failed'); END",
		);
		await expect(moveRoutineAuditEventsToLogs(main.db)).rejects.toThrow();
		expect(
			main.sqlite.prepare("SELECT count(*) n FROM audit_events").get(),
		).toEqual({ n: 22 });
		logs.sqlite.exec("DROP TRIGGER fail_copy");
		await insertAuditEvent(logs.db, {
			...policy,
			id: "atomic-0",
			metadata: { resolvedBy: "policy", approvalReason: "Wrong copy" },
		});
		await expect(moveRoutineAuditEventsToLogs(main.db)).rejects.toThrow(
			"copy mismatch",
		);
		expect(
			main.sqlite.prepare("SELECT count(*) n FROM audit_events").get(),
		).toEqual({ n: 22 });
		logs.sqlite.exec("DELETE FROM audit_events WHERE id='atomic-0'");
		main.sqlite.exec(
			"CREATE TRIGGER fail_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'delete failed'); END",
		);
		await expect(moveRoutineAuditEventsToLogs(main.db)).rejects.toThrow();
		expect(
			logs.sqlite.prepare("SELECT count(*) n FROM audit_events").get(),
		).toEqual({ n: 22 });
		main.sqlite.exec("DROP TRIGGER fail_delete");
		expect(await moveRoutineAuditEventsToLogs(main.db)).toBe(21);
		expect(await moveRoutineAuditEventsToLogs(main.db)).toBe(0);
		expect(main.sqlite.prepare("SELECT id FROM audit_events").all()).toEqual([
			{ id: "human" },
		]);
		const rows = await searchAuditEvents(main.db, {
			organizationId: event.organizationId,
			action: "approval.approved",
		});
		expect(rows.data).toHaveLength(12);
		expect(rows.data.find((row) => row.id === "atomic-0")?.metadata).toEqual(
			policy.metadata,
		);
		expect(
			await listGovernanceAuditEvents(main.db, event.organizationId, 20),
		).toHaveLength(12);
		expect(
			await listHomeOperatorDecisionAuditEvents(main.db, {
				organizationId: event.organizationId,
				since: new Date(0),
				actions: ["approval.approved"],
				limit: 20,
			}),
		).toHaveLength(12);
		main.sqlite.close();
		logs.sqlite.close();
	});

	it("moves fresh approvals and expiry receipts before either historical backlog", async () => {
		const main = store();
		const logs = store();
		configureLogStore(main.db, { LOGS_DB: logs.binding });
		const old = new Date("2026-10-27T10:00:00Z");
		const fresh = new Date("2026-11-26T09:00:00Z");
		await insertAuditEventsBatch(main.db, [
			...Array.from({ length: 501 }, (_, i) => ({
				...event,
				id: `old-expiry-${i}`,
				action: "interaction.expiry.run",
				occurredAt: old,
			})),
			...Array.from({ length: 501 }, (_, i) => ({
				...event,
				id: `old-approval-${i}`,
				action: "approval.approved",
				actorId: "policy",
				occurredAt: old,
			})),
			{
				...event,
				id: "fresh-approval",
				action: "approval.approved",
				metadata: { resolvedBy: "policy" },
				occurredAt: fresh,
			},
			{
				...event,
				id: "fresh-expiry",
				action: "interaction.expiry.run",
				occurredAt: fresh,
			},
			{ ...event, id: "human", action: "approval.approved", occurredAt: fresh },
		]);
		expect(await moveRoutineAuditEventsToLogs(main.db)).toBe(500);
		expect(
			logs.sqlite
				.prepare("SELECT id FROM audit_events WHERE timestamp = ? ORDER BY id")
				.all(fresh.getTime() / 1000),
		).toEqual([{ id: "fresh-approval" }, { id: "fresh-expiry" }]);
		expect(await moveRoutineAuditEventsToLogs(main.db)).toBe(500);
		expect(await moveRoutineAuditEventsToLogs(main.db)).toBe(4);
		expect(main.sqlite.prepare("SELECT id FROM audit_events").all()).toEqual([
			{ id: "human" },
		]);
		main.sqlite.close();
		logs.sqlite.close();
	});

	it("writes 100 telemetry rows in one batch without dictionary access and retains inline metadata", async () => {
		const main = store();
		const logs = store();
		const batch = vi.spyOn(logs.binding, "batch");
		configureLogStore(main.db, { LOGS_DB: logs.binding });
		// A missing dictionary makes any accidental read or dictionary write fail.
		logs.sqlite.exec("DROP TABLE audit_metadata_refs");
		const occurredAt = new Date("2026-11-23T15:00:00Z");
		await insertMcpAuditEventsBatch(
			main.db,
			Array.from({ length: 100 }, (_, i) => ({
				...event,
				id: `event-${i}`,
				occurredAt,
			})),
		);
		expect(batch).toHaveBeenCalledTimes(1);
		expect(
			logs.sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
		).toEqual({ n: 100 });
		expect(
			main.sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
		).toEqual({ n: 0 });
		const rows = await getAuditEventsByResource(
			main.db,
			event.organizationId,
			event.resourceType,
			event.resourceId,
		);
		expect(rows[0]!.metadata).toEqual({
			appId: "app-example",
			clientId: "client-example",
		});
		expect(rows[0]!.timestamp).toEqual(occurredAt);
		await expect(
			insertMcpAuditEventsBatch(main.db, [
				{ ...event, action: "mcp.access.denied" },
			]),
		).rejects.toThrow("Only MCP execution telemetry");
		main.sqlite.close();
		logs.sqlite.close();
	});

	it("persists access denials with full attribution when the dictionary is overloaded", async () => {
		const main = store();
		const logs = store();
		configureLogStore(main.db, { LOGS_DB: logs.binding });
		const prepare = main.binding.prepare.bind(main.binding);
		vi.spyOn(main.binding, "prepare").mockImplementation((query) => {
			if (query.includes("audit_metadata_refs"))
				throw new Error("D1_ERROR: database is overloaded");
			return prepare(query);
		});
		await insertAuditEvent(main.db, {
			...event,
			id: "denied",
			action: "mcp.access.denied",
		});
		expect(
			main.sqlite
				.prepare(
					"SELECT action, metadata FROM audit_events WHERE id = 'denied'",
				)
				.get(),
		).toEqual({
			action: "mcp.access.denied",
			metadata: JSON.stringify({
				appId: "app-example",
				clientId: "client-example",
			}),
		});
		expect(
			logs.sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
		).toEqual({ n: 0 });
		main.sqlite.close();
		logs.sqlite.close();
	});

	it("redirects execution telemetry while retaining authority, payments and batch audit in main", async () => {
		const main = store();
		const logs = store();
		const telemetry = [
			"mcp.tool.execute",
			"mcp.tool.error",
			"mcp.code.execute",
			"mcp.code.error",
			"mcp.prompt.execute",
			"mcp.prompt.error",
			"mcp.resource.read",
			"mcp.resource.error",
		];
		for (const action of telemetry) {
			await insertAuditEvent(main.db, {
				...event,
				id: `legacy:${action}`,
				action,
				occurredAt: new Date("2026-10-06T12:00:00Z"),
			});
		}
		configureLogStore(main.db, { LOGS_DB: logs.binding });
		for (const action of telemetry) {
			await insertAuditEvent(main.db, { ...event, id: action, action });
		}
		const retained = [
			"mcp.access.denied",
			"mcp.payment.required",
			"mcp.payment.rejected",
			"mcp.payment.settled",
			"mcp.future.action",
			"approval.approved",
		];
		for (const action of retained) {
			await insertAuditEvent(main.db, { ...event, id: action, action });
		}
		await main.db.batch([
			buildInsertAuditEventStatement(main.db, { ...event, id: "batch" })
				.statement,
		]);
		expect(
			main.sqlite.prepare("SELECT id FROM audit_events ORDER BY id").all(),
		).toEqual(
			[...telemetry.map((action) => `legacy:${action}`), ...retained, "batch"]
				.sort()
				.map((id) => ({ id })),
		);
		expect(
			logs.sqlite.prepare("SELECT id FROM audit_events ORDER BY id").all(),
		).toEqual([...telemetry].sort().map((id) => ({ id })));
		const table = getD1RetentionTableSpec("audit_events")!;
		const cutoff = d1RetentionPolicyCutoff(
			table,
			new Date("2026-10-21T12:00:00Z"),
			{ keepDays: 90 },
		);
		const expired = (await readD1RetentionPage(main.db, table, 0)).filter(
			(row) => isD1RetentionExpired(table, row.timestamp, cutoff, row.action),
		);
		expect(expired).toHaveLength(8);
		const copied = await copyD1RetentionRowsToLogs(logs.db, table, expired);
		const verification = verifyD1LogsCopy(table, expired, copied);
		expect(verification.missing).toEqual([]);
		expect(verification.mismatched).toEqual([]);
		expect(await deleteD1RetentionRows(main.db, table, expired, cutoff)).toBe(
			8,
		);
		expect(
			main.sqlite
				.prepare("SELECT id FROM audit_events WHERE id LIKE 'legacy:%'")
				.all(),
		).toEqual([]);
		for (const action of telemetry) {
			const result = await searchAuditEvents(main.db, {
				organizationId: event.organizationId,
				action,
			});
			expect(result.data.map((row) => row.id).sort()).toEqual(
				[
					action,
					`legacy:${action}`,
					...(action === event.action ? ["batch"] : []),
				].sort(),
			);
		}
	});

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
			action: "mcp.session.open",
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
		await insertAuditEvent(main.db, {
			...event,
			id: "security",
			action: "mcp.access.denied",
			occurredAt: new Date("2026-01-04T00:00:00Z"),
		});
		const prepare = vi.spyOn(main.binding, "prepare");
		const freshness = await getAnalyticsAppFreshness(main.db, {
			organizationId: event.organizationId,
			appId: "app-example",
			windowStartSeconds: 0,
			windowEndSeconds: 2000000000,
		});
		expect(freshness.countsRow).toEqual({
			totalEvents: 4,
			toolExecutions: 1,
			toolErrors: 1,
			codeExecutions: 0,
		});
		expect(freshness.latestRow?.action).toBe("mcp.access.denied");
		expect(
			prepare.mock.calls.some(([statement]) => statement.includes("SUM(")),
		).toBe(false);
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

it("applies the same tied timestamp cursor in both stores before merging", async () => {
	const main = store();
	const logs = store();
	try {
		for (const [db, ids] of [
			[main.db, ["d", "b"]],
			[logs.db, ["c", "a"]],
		] as const) {
			for (const id of ids)
				await insertAuditEvent(db, {
					...event,
					id,
					occurredAt: new Date("2026-01-01T00:00:00Z"),
				});
		}
		configureLogStore(main.db, { LOGS_DB: logs.binding });
		const result = await searchAuditEvents(main.db, {
			organizationId: event.organizationId,
			limit: 2,
			cursor: { timestamp: "2026-01-01T00:00:00Z", id: "d" },
		});
		expect(result.data.map((row) => row.id)).toEqual(["c", "b"]);
	} finally {
		main.sqlite.close();
		logs.sqlite.close();
	}
});

it("keeps atomic audit delivery pending until both stores confirm, then drains without main audit writes", async () => {
	const main = store();
	const logs = store();
	main.sqlite.exec(schemaDdl(organizations));
	await main.db
		.insert(organizations)
		.values({ id: event.organizationId, name: "Before", slug: "example" });
	const delivered = new Map<string, Map<string, OrganizationAuditEvent>>();
	let unavailable = true;
	const bindings = {
		DB: main.binding,
		LOGS_DB: logs.binding,
		WORKSPACE_RUNTIME: {
			async organizationAuditAppend(
				org: string,
				events: OrganizationAuditEvent[],
			) {
				if (unavailable) throw new Error("Store unavailable");
				const records =
					delivered.get(org) ?? new Map<string, OrganizationAuditEvent>();
				for (const item of events) records.set(item.id, structuredClone(item));
				delivered.set(org, records);
				return { status: "live" as const, value: events };
			},
		},
	};
	try {
		await withCoreStore(bindings, async () => {
			const audit = {
				...event,
				id: "atomic",
				action: "approval.approved",
				occurredAt: new Date("2026-11-26T00:00:00Z"),
			};
			main.sqlite.exec(
				"CREATE TRIGGER fail_outbox BEFORE INSERT ON audit_delivery_outbox BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END",
			);
			await expect(
				updateOrganization(
					main.db,
					event.organizationId,
					{ name: "After" },
					audit,
				),
			).rejects.toThrow();
			expect(
				main.sqlite.prepare("SELECT name FROM organizations").get(),
			).toEqual({ name: "Before" });
			main.sqlite.exec("DROP TRIGGER fail_outbox");
			await updateOrganization(
				main.db,
				event.organizationId,
				{ name: "After" },
				audit,
			);
			await insertAuditEvent(main.db, {
				...event,
				id: "denied",
				action: "mcp.access.denied",
			});
			await insertAuditEventsBatch(main.db, [
				{ ...event, id: "batch", organizationId: "org-other" },
			]);
			await insertMcpAuditEventsBatch(main.db, [{ ...event, id: "telemetry" }]);
			expect(
				await readAuditEventById(main.db, event.organizationId, "atomic"),
			).toMatchObject({ id: "atomic" });
			expect(
				await readAuditEventById(main.db, "org-other", "atomic"),
			).toBeUndefined();
			expect(
				await listGovernanceAuditEvents(main.db, event.organizationId),
			).toHaveLength(1);
			expect(
				await listHomeOperatorDecisionAuditEvents(main.db, {
					organizationId: event.organizationId,
					since: new Date(0),
					actions: [audit.action],
					limit: 10,
				}),
			).toHaveLength(1);
			await expect(drainAuditDeliveryOutbox(main.db, bindings)).rejects.toThrow(
				"pending",
			);
			expect(
				main.sqlite
					.prepare("SELECT count(*) n FROM audit_delivery_outbox")
					.get(),
			).toEqual({ n: 4 });
			unavailable = false;
			main.sqlite.exec(
				"CREATE TRIGGER fail_delete BEFORE DELETE ON audit_delivery_outbox BEGIN SELECT RAISE(ABORT,'delete unavailable'); END",
			);
			await expect(drainAuditDeliveryOutbox(main.db, bindings)).rejects.toThrow(
				"pending",
			);
			main.sqlite.exec("DROP TRIGGER fail_delete");
			expect(await drainAuditDeliveryOutbox(main.db, bindings)).toBe(4);
			await insertAuditEvent(main.db, {
				...audit,
				ignoreDuplicates: true,
				occurredAt: new Date("2026-11-27T00:00:00Z"),
			});
			expect(await drainAuditDeliveryOutbox(main.db, bindings)).toBe(1);
			expect(await drainAuditDeliveryOutbox(main.db, bindings)).toBe(0);
			expect(delivered.get(event.organizationId)?.size).toBe(3);
			expect(delivered.get("org-other")?.size).toBe(1);
			expect(delivered.get(event.organizationId)?.get("atomic")).toMatchObject({
				actorId: event.actorId,
				timestamp: 1795651200,
			});
			expect(
				(
					await searchAuditEvents(main.db, {
						organizationId: event.organizationId,
					})
				).data,
			).toHaveLength(3);
			expect(
				main.sqlite.prepare("SELECT count(*) n FROM audit_events").get(),
			).toEqual({ n: 0 });
			expect(
				main.sqlite
					.prepare("SELECT count(*) n FROM audit_delivery_outbox")
					.get(),
			).toEqual({ n: 0 });
			expect(
				logs.sqlite.prepare("SELECT count(*) n FROM audit_events").get(),
			).toEqual({ n: 4 });
			await insertAuditEvent(main.db, { ...event, id: "moving" });
			let moved = false;
			const duringDelivery = await readAuditStores(main.db, async (store) => {
				const table = auditReadTable(store);
				const rows = await store
					.select(auditReadColumns(store))
					.from(table)
					.where(eq(table.id, "moving"));
				if (!rows.length && !moved) {
					moved = true;
					await drainAuditDeliveryOutbox(main.db, bindings);
				}
				return rows;
			});
			expect(duringDelivery?.flat().some((row) => row.id === "moving")).toBe(
				true,
			);
		});
		const workflowDb = coreDb(bindings);
		await insertAuditEvent(workflowDb, { ...event, id: "workflow" });
		expect(await drainAuditDeliveryOutbox(workflowDb, bindings)).toBe(1);
		expect(
			main.sqlite.prepare("SELECT count(*) n FROM audit_events").get(),
		).toEqual({ n: 0 });
	} finally {
		main.sqlite.close();
		logs.sqlite.close();
	}
});

it("delivers older expiry receipts before newer events with smaller IDs", async () => {
	const main = store();
	const logs = store();
	const append = vi.fn(
		async (_org: string, events: OrganizationAuditEvent[]) => ({
			status: "live" as const,
			value: events,
		}),
	);
	const bindings = {
		DB: main.binding,
		LOGS_DB: logs.binding,
		WORKSPACE_RUNTIME: { organizationAuditAppend: append },
	};
	try {
		await withCoreStore(bindings, async () => {
			await insertAuditEvent(main.db, {
				...event,
				id: "z-expiry",
				action: "interaction.expiry.run",
			});
			for (let index = 0; index < 500; index++) {
				await insertAuditEvent(main.db, {
					...event,
					id: `a-newer-${index}`,
				});
			}
			expect(await drainAuditDeliveryOutbox(main.db, bindings)).toBe(500);
			expect(append.mock.calls[0]![1][0]?.id).toBe("z-expiry");
			expect(
				logs.sqlite
					.prepare("SELECT id FROM audit_events WHERE id = 'z-expiry'")
					.get(),
			).toEqual({ id: "z-expiry" });
			expect(
				main.sqlite.prepare("SELECT id FROM audit_delivery_outbox").all(),
			).toEqual([{ id: "a-newer-499" }]);
			expect(await drainAuditDeliveryOutbox(main.db, bindings)).toBe(1);
		});
	} finally {
		main.sqlite.close();
		logs.sqlite.close();
	}
});
