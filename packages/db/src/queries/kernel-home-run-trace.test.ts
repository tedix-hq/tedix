import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listHomeRunAuditReferences } from "./kernel-home-run-trace";

describe("listHomeRunAuditReferences", () => {
	it("preserves in-window matches and searches the organization/timestamp index", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(schemaDdl(auditEvents));
			const insert = sqlite.prepare(`INSERT INTO audit_events
				(id, organization_id, actor_id, actor_type, action, resource_type, metadata, timestamp)
				VALUES (?, ?, 'river', 'tedi', 'tool.invoked', 'tool', ?, ?)`);
			const from = new Date("2026-10-21T18:00:00.000Z");
			const to = new Date("2026-10-21T18:05:00.000Z");
			const start = from.getTime() / 1000;
			const end = to.getTime() / 1000;
			for (const [id, organization, traceId, timestamp] of [
				["before", "org-lighthouse", "child-one", start - 1],
				["start", "org-lighthouse", "child-one", start],
				["middle", "org-lighthouse", "child-two", start + 60],
				["end", "org-lighthouse", "child-one", end],
				["after", "org-lighthouse", "child-one", end + 1],
				["other-trace", "org-lighthouse", "child-other", start],
				["other-tenant", "org-harbor", "child-one", start],
			] as const) {
				insert.run(id, organization, JSON.stringify({ traceId }), timestamp);
			}
			let query = "";
			const db = createDbClient(
				createD1Facade(sqlite, {
					onPrepare: (statement) => {
						query = statement;
					},
				}),
			);
			const rows = await listHomeRunAuditReferences(db, {
				organizationId: "org-lighthouse",
				childRunIds: ["child-one", "child-two"],
				from,
				to,
				limit: 400,
			});
			const previous = sqlite
				.prepare(`SELECT id, json_extract(metadata, '$.traceId') AS traceId
				FROM audit_events WHERE organization_id = ?
				AND json_extract(metadata, '$.traceId') IN (?, ?) LIMIT ?`)
				.all("org-lighthouse", "child-one", "child-two", 400);
			expect(rows).toEqual(
				previous.filter(
					(event) => !["before", "after"].includes(String(event.id)),
				),
			);
			expect(rows.map((event) => event.id)).toEqual(["start", "middle", "end"]);
			const plan = sqlite
				.prepare(`EXPLAIN QUERY PLAN ${query}`)
				.all("org-lighthouse", start, end, "child-one", "child-two", 400)
				.map((step) => String(step.detail));
			expect(
				plan.some(
					(step) =>
						step.includes(
							"SEARCH audit_events USING INDEX idx_audit_events_org_timestamp",
						) &&
						step.includes("timestamp>?") &&
						step.includes("timestamp<?"),
				),
			).toBe(true);
			expect(plan.some((step) => /SCAN audit_events/.test(step))).toBe(false);
			expect(
				await listHomeRunAuditReferences(db, {
					organizationId: "org-lighthouse",
					childRunIds: [],
					from,
					to,
					limit: 400,
				}),
			).toEqual([]);
			expect(
				await listHomeRunAuditReferences(db, {
					organizationId: "org-lighthouse",
					childRunIds: Array.from(
						{ length: 96 },
						(_, index) => `noise-${index}`,
					),
					from,
					to,
					limit: 400,
				}),
			).toEqual([]);
			await expect(
				listHomeRunAuditReferences(db, {
					organizationId: "org-lighthouse",
					childRunIds: Array.from(
						{ length: 97 },
						(_, index) => `noise-${index}`,
					),
					from,
					to,
					limit: 400,
				}),
			).rejects.toThrow("at most 96 child runs");
		} finally {
			sqlite.close();
		}
	});

	it("rejects missing, invalid, or inverted bounds before preparing SQL", async () => {
		const sqlite = new DatabaseSync(":memory:");
		const db = createDbClient(
			createD1Facade(sqlite, {
				onPrepare: () => {
					throw new Error("must not prepare an unbounded query");
				},
			}),
		);
		for (const [from, to] of [
			[undefined, new Date()],
			[new Date(), undefined],
			[new Date(NaN), new Date()],
			[new Date(2000), new Date(1000)],
		]) {
			await expect(
				listHomeRunAuditReferences(db, {
					organizationId: "org-lighthouse",
					childRunIds: ["child-one"],
					limit: 400,
					from: from as Date,
					to: to as Date,
				}),
			).rejects.toThrow("valid audit time bounds");
		}
		sqlite.close();
	});
});
