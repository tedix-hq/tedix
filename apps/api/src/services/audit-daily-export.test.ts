import { DatabaseSync } from "node:sqlite";
import { configureLogStore, createDbClient } from "@tedix/db/client";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { logPartition } from "@tedix/db/schema/logs-db";
import { organizations } from "@tedix/db/schema/organizations";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import {
	AUDIT_DAILY_EXPORT_PAGE_ROWS,
	auditDailyExportKeepFrom,
	auditDailyExportKey,
	runAuditDailyExport,
} from "./audit-daily-export";

const NOW = new Date("2026-10-26T03:00:00Z");
const ORG = "org-lighthouse";
const OTHER = "org-orchard";

class MemoryBucket {
	readonly objects = new Map<string, Uint8Array>();
	puts = 0;
	async head(key: string) {
		return this.objects.has(key) ? { key } : null;
	}
	async put(key: string, value: Uint8Array) {
		this.puts += 1;
		this.objects.set(key, value);
		return { key, size: value.byteLength };
	}
	async list(options: { prefix: string; cursor?: string; limit?: number }) {
		const keys = [...this.objects.keys()]
			.filter((key) => key.startsWith(options.prefix))
			.sort();
		const start = options.cursor ? Number(options.cursor) : 0;
		const end = start + (options.limit ?? 1000);
		return {
			objects: keys.slice(start, end).map((key) => ({ key })),
			truncated: end < keys.length,
			cursor: String(end),
		};
	}
	async delete(keys: string[]) {
		for (const key of keys) this.objects.delete(key);
	}
}

function store() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, auditEvents, logPartition));
	const binding = createD1Facade(sqlite);
	return { sqlite, binding, db: createDbClient(binding) };
}

function fixture() {
	const main = store();
	const logs = store();
	configureLogStore(main.db, { LOGS_DB: logs.binding });
	for (const [id, slug] of [
		[ORG, "lighthouse"],
		[OTHER, "orchard"],
	])
		main.sqlite
			.prepare("INSERT INTO organizations(id, name, slug) VALUES(?,?,?)")
			.run(id, slug, slug);
	const bucket = new MemoryBucket();
	return { db: main.db, bucket, r2: bucket as unknown as R2Bucket };
}

async function lines(bucket: MemoryBucket, key: string) {
	const body = bucket.objects.get(key);
	if (!body) throw new Error(`missing ${key}`);
	const text = await new Response(
		new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip")),
	).text();
	return text
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
}

describe("audit daily export", () => {
	it("writes each organization's finished hours as gzip JSON Lines, main and logs store alike", async () => {
		const { db, bucket, r2 } = fixture();
		await insertAuditEvent(db, {
			organizationId: ORG,
			id: "app-event",
			actorId: "user-ada",
			actorType: "user",
			action: "app.created",
			resourceType: "app",
			occurredAt: new Date("2026-10-25T09:15:00Z"),
		});
		await insertAuditEvent(db, {
			organizationId: ORG,
			id: "tool-event",
			actorId: "user-ada",
			actorType: "user",
			action: "mcp.tool.execute",
			resourceType: "mcp_tool",
			metadata: { requestRunId: "run-1" },
			occurredAt: new Date("2026-10-25T09:59:59Z"),
		});
		// Today is not finished, so it waits for tomorrow's run.
		await insertAuditEvent(db, {
			organizationId: ORG,
			id: "today-event",
			actorId: "user-ada",
			actorType: "user",
			action: "app.created",
			resourceType: "app",
			occurredAt: new Date("2026-10-26T01:00:00Z"),
		});

		const result = await runAuditDailyExport({
			db,
			bucket: r2,
			now: NOW,
			budgetMs: 60_000,
		});

		const key = auditDailyExportKey(ORG, Date.parse("2026-10-25T09:00:00Z"));
		expect(key).toBe("audit-exports/v1/org-lighthouse/2026-10-25/09.jsonl.gz");
		expect([...bucket.objects.keys()]).toEqual([key]);
		const rows = await lines(bucket, key);
		expect(rows.map((row) => row.id)).toEqual(["tool-event", "app-event"]);
		expect(rows[0]).toMatchObject({
			organizationId: ORG,
			action: "mcp.tool.execute",
			metadata: { requestRunId: "run-1" },
			timestamp: "2026-10-25T09:59:59.000Z",
		});
		expect(result).toMatchObject({
			organizations: 2,
			objectsWritten: 1,
			eventsWritten: 2,
			stoppedBy: "done",
			errors: 0,
		});
	});

	it("skips hours already exported, so reruns and backfill write nothing twice", async () => {
		const { db, bucket, r2 } = fixture();
		await insertAuditEvent(db, {
			organizationId: OTHER,
			actorId: "user-bo",
			actorType: "user",
			action: "app.created",
			resourceType: "app",
			occurredAt: new Date("2026-10-20T12:00:00Z"),
		});
		await runAuditDailyExport({ db, bucket: r2, now: NOW, budgetMs: 60_000 });
		expect(bucket.puts).toBe(1);
		const again = await runAuditDailyExport({
			db,
			bucket: r2,
			now: NOW,
			budgetMs: 60_000,
		});
		expect(bucket.puts).toBe(1);
		expect(again.objectsWritten).toBe(0);
	});

	it("pages a busy hour completely", async () => {
		const { db, bucket, r2 } = fixture();
		const total = AUDIT_DAILY_EXPORT_PAGE_ROWS + 5;
		for (let index = 0; index < total; index += 1)
			await insertAuditEvent(db, {
				organizationId: ORG,
				id: `event-${index}`,
				actorId: "user-ada",
				actorType: "user",
				action: "app.created",
				resourceType: "app",
				occurredAt: new Date(Date.UTC(2026, 9, 25, 14, 0, index % 3600)),
			});
		await runAuditDailyExport({ db, bucket: r2, now: NOW, budgetMs: 60_000 });
		const rows = await lines(
			bucket,
			auditDailyExportKey(ORG, Date.parse("2026-10-25T14:00:00Z")),
		);
		expect(new Set(rows.map((row) => row.id)).size).toBe(total);
	});

	it("deletes objects older than 13 months and keeps the rest", async () => {
		const { db, bucket, r2 } = fixture();
		expect(auditDailyExportKeepFrom(NOW)).toBe("2025-09-26");
		const old = "audit-exports/v1/org-lighthouse/2025-09-25/23.jsonl.gz";
		const kept = "audit-exports/v1/org-lighthouse/2025-09-26/00.jsonl.gz";
		const otherOrg = "audit-exports/v1/org-other/2024-01-01/00.jsonl.gz";
		for (const key of [old, kept, otherOrg])
			bucket.objects.set(key, new Uint8Array([1]));

		const result = await runAuditDailyExport({
			db,
			bucket: r2,
			now: NOW,
			budgetMs: 60_000,
		});

		expect(result.objectsDeleted).toBe(1);
		expect(bucket.objects.has(old)).toBe(false);
		expect(bucket.objects.has(kept)).toBe(true);
		// Only listed organizations are swept; nothing outside them is touched.
		expect(bucket.objects.has(otherOrg)).toBe(true);
	});

	it("stops at the time budget without writing", async () => {
		const { db, bucket, r2 } = fixture();
		await insertAuditEvent(db, {
			organizationId: ORG,
			actorId: "user-ada",
			actorType: "user",
			action: "app.created",
			resourceType: "app",
			occurredAt: new Date("2026-10-25T09:00:00Z"),
		});
		let now = 0;
		const result = await runAuditDailyExport({
			db,
			bucket: r2,
			now: NOW,
			budgetMs: 10,
			clock: () => (now += 100),
		});
		expect(result.stoppedBy).toBe("time_budget");
		expect(bucket.puts).toBe(0);
	});
});
