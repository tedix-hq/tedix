import { DatabaseSync } from "node:sqlite";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { createRouterClient } from "@orpc/server";
import { configureLogStore, createDbClient } from "@tedix/db/client";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { logPartition } from "@tedix/db/schema/logs-db";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { AUDIT_EXPORT_TRUNCATED_FILENAME } from "@tedix/api-contract/schemas/audit";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { AUDIT_EXPORT_PAGE_SIZE, auditContractRouter } from "./audit";

const ORG_ID = "org-example";

function store() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(auditEvents, logPartition));
	const binding = createD1Facade(sqlite);
	return { sqlite, binding, db: createDbClient(binding) };
}

/** Main database plus a logs store, configured the way the Worker does. */
function stores() {
	const main = store();
	const logs = store();
	configureLogStore(main.db, { LOGS_DB: logs.binding });
	return { main, logs };
}

function createContext(
	db: BaseContext["db"],
	permissions = ["analytics:read"],
): BaseContext {
	return {
		authType: "user",
		db,
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/audit/export"),
		user: {
			aud: "test",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			sub: "user-1",
			dct: "tenant-1",
			permissions,
			roles: [],
		},
	};
}

function createClient(db: BaseContext["db"], permissions?: string[]) {
	return createRouterClient(auditContractRouter, {
		context: createContext(db, permissions),
	});
}

const base = {
	organizationId: ORG_ID,
	actorId: "user-example",
	actorType: "user" as const,
	resourceType: "app",
};

function lines(text: string): string[] {
	return text.split("\r\n").filter(Boolean);
}

describe("audit export", () => {
	it("requires audit read access before reading anything", async () => {
		const { main } = stores();
		await insertAuditEvent(main.db, { ...base, action: "app.created" });
		const client = createClient(main.db, ["billing:read"]);

		await expect(client.export({ format: "csv" })).rejects.toThrow(
			"Required: analytics:read",
		);
	});

	it("includes logs-store tool events and main-database events, newest first", async () => {
		const { main, logs } = stores();
		await insertAuditEvent(main.db, {
			...base,
			id: "main-event",
			action: "app.created",
			occurredAt: new Date("2026-01-01T00:00:00Z"),
		});
		await insertAuditEvent(main.db, {
			...base,
			id: "tool-event",
			action: "mcp.tool.execute",
			resourceType: "mcp_tool",
			occurredAt: new Date("2026-01-02T00:00:00Z"),
		});
		// The tool event really lives in the logs store, not the main table.
		expect(logs.sqlite.prepare("SELECT id FROM audit_events").all()).toEqual([
			{ id: "tool-event" },
		]);

		const file = await createClient(main.db).export({ format: "jsonl" });
		const rows = (await file.text())
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(rows.map((row) => row.id)).toEqual(["tool-event", "main-event"]);
	});

	it("writes one complete audit event object per JSON line", async () => {
		const { main } = stores();
		await insertAuditEvent(main.db, {
			...base,
			id: "event-1",
			action: "app.created",
			resourceId: "app-1",
			metadata: { bodyKey: "audit/org-example/event-1.json", bodyBytes: 9000 },
			occurredAt: new Date("2026-01-01T00:00:00Z"),
		});

		const file = await createClient(main.db).export({ format: "jsonl" });

		expect(file.type).toBe("application/x-ndjson; charset=utf-8");
		expect(file.name).toMatch(/^audit-events-.+\.jsonl$/);
		const text = await file.text();
		expect(text.endsWith("\n")).toBe(true);
		expect(JSON.parse(text.trimEnd())).toEqual({
			id: "event-1",
			organizationId: ORG_ID,
			actorId: "user-example",
			actorType: "user",
			action: "app.created",
			resourceType: "app",
			resourceId: "app-1",
			// A spilled body exports its stored pointer, not the hydrated body.
			metadata: { bodyKey: "audit/org-example/event-1.json", bodyBytes: 9000 },
			ipAddress: null,
			userAgent: null,
			timestamp: "2026-01-01T00:00:00.000Z",
		});
	});

	it("escapes CSV cells, neutralises formulas and flattens attribution keys", async () => {
		const { main } = stores();
		await insertAuditEvent(main.db, {
			...base,
			id: "event-1",
			action: '=HYPERLINK("x")',
			resourceId: 'name, with "quotes"',
			metadata: {
				subjectUserId: "user-subject",
				governance: { decision: "allow" },
				note: "line one\nline two",
			},
			occurredAt: new Date("2026-01-01T00:00:00Z"),
		});

		const file = await createClient(main.db).export({ format: "csv" });

		expect(file.type).toBe("text/csv; charset=utf-8");
		expect(file.name).toMatch(/^audit-events-.+\.csv$/);
		const text = await file.text();
		const [header] = lines(text);
		expect(header).toBe(
			"timestamp,id,actorType,actorId,action,resourceType,resourceId,subjectUserId,governance,metadata",
		);
		expect(text).toContain(
			`2026-01-01T00:00:00.000Z,event-1,user,user-example,"'=HYPERLINK(""x"")",app,"name, with ""quotes""",user-subject,"{""decision"":""allow""}",`,
		);
		// The metadata JSON cell keeps its escaped newline inside one quoted cell.
		expect(text).toContain('""note"":""line one\\nline two""');
		expect(lines(text)).toHaveLength(2);
	});

	it("honours the requested limit across search pages and rejects limits above the cap", async () => {
		const { main } = stores();
		const total = AUDIT_EXPORT_PAGE_SIZE + 20;
		for (let index = 0; index < total; index += 1) {
			await insertAuditEvent(main.db, {
				...base,
				id: `event-${String(index).padStart(4, "0")}`,
				action: "mcp.tool.execute",
				resourceType: "mcp_tool",
				occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
			});
		}
		const client = createClient(main.db);

		const capped = await client.export({
			format: "jsonl",
			limit: AUDIT_EXPORT_PAGE_SIZE + 10,
		});
		const cappedRows = (await capped.text())
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		// Events were left out, so the file says so: in its name and last line.
		expect(capped.name).toMatch(
			new RegExp(`-truncated-${AUDIT_EXPORT_PAGE_SIZE + 10}\\.jsonl$`),
		);
		// The OS reads the cut-off count back from the name with the shared pattern.
		expect(capped.name.match(AUDIT_EXPORT_TRUNCATED_FILENAME)?.[1]).toBe(
			String(AUDIT_EXPORT_PAGE_SIZE + 10),
		);
		expect(cappedRows.at(-1)).toEqual({
			_export: {
				truncated: true,
				events: AUDIT_EXPORT_PAGE_SIZE + 10,
				limit: AUDIT_EXPORT_PAGE_SIZE + 10,
			},
		});
		const ids = cappedRows.slice(0, -1).map((row) => row.id);
		expect(ids).toHaveLength(AUDIT_EXPORT_PAGE_SIZE + 10);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids[0]).toBe(`event-${String(total - 1).padStart(4, "0")}`);

		const all = await client.export({ format: "csv" });
		expect(all.name).not.toContain("truncated");
		expect(lines(await all.text())).toHaveLength(total + 1);

		// Exactly at the cap with nothing left out is complete, not truncated.
		const exact = await client.export({ format: "jsonl", limit: total });
		expect(exact.name).not.toContain("truncated");
		expect((await exact.text()).trimEnd().split("\n")).toHaveLength(total);

		await expect(
			client.export({ format: "csv", limit: 10_001 }),
		).rejects.toThrow();
	});

	it("answers GET /audit/export over REST with the file as the body", async () => {
		const { main } = stores();
		await insertAuditEvent(main.db, {
			...base,
			id: "event-1",
			action: "app.created",
			occurredAt: new Date("2026-01-01T00:00:00Z"),
		});
		const handler = new OpenAPIHandler(auditContractRouter);

		const { matched, response } = await handler.handle(
			new Request(
				"https://api.tedix.test/v1/audit/export?format=csv&action=app.created",
			),
			{ prefix: "/v1", context: createContext(main.db) },
		);

		expect(matched).toBe(true);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toBe(
			"text/csv; charset=utf-8",
		);
		expect(response?.headers.get("content-disposition")).toMatch(
			/filename\*?=.*audit-events-.+\.csv/,
		);
		const text = await response!.text();
		expect(lines(text)[1]).toBe(
			`2026-01-01T00:00:00.000Z,event-1,user,user-example,app.created,app,,`,
		);
	});
});
