import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { hasProjectWorkItemReference } from "./project-access";

describe("project Work reference lookup", () => {
	it.each([false, true])(
		"checks a discovery-sized ID set within its latency budget (private reference: %s)",
		async (includesPrivate) => {
			vi.useFakeTimers();
			const sqlite = new DatabaseSync(":memory:");
			try {
				sqlite.exec(
					"CREATE TABLE work_items (id TEXT PRIMARY KEY, org_id TEXT, project_id TEXT); CREATE INDEX work_project ON work_items(project_id)",
				);
				const privateId = `private-'\"-work`;
				sqlite
					.prepare("INSERT INTO work_items VALUES (?, ?, ?)")
					.run(privateId, "fictional-org", "private-project");
				const db = createDbClient(
					createD1Facade(sqlite, {
						onPrepare: () => {
							// Charge 250ms per D1 round trip without relying on host speed.
							vi.advanceTimersByTime(250);
						},
					}),
				);
				const ids = Array.from({ length: 1900 }, (_, index) => `tool-${index}`);
				if (includesPrivate) ids.push(privateId);
				const start = Date.now();
				expect(
					await hasProjectWorkItemReference(db, {
						orgId: "fictional-org",
						projectId: "private-project",
						ids,
					}),
				).toBe(includesPrivate);
				expect(Date.now() - start).toBeLessThan(1000);
			} finally {
				sqlite.close();
				vi.useRealTimers();
			}
		},
	);
	it("finds references beyond the D1 parameter chunk and respects both scopes", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(
				"CREATE TABLE work_items (id TEXT, org_id TEXT, project_id TEXT); INSERT INTO work_items VALUES ('private-work', 'fictional-org', 'private-project')",
			);
			const db = createDbClient(createD1Facade(sqlite));
			const ids = [
				...Array.from({ length: 105 }, (_, n) => `ordinary-${n}`),
				"private-work",
			];
			expect(
				await hasProjectWorkItemReference(db, {
					orgId: "fictional-org",
					projectId: "private-project",
					ids,
				}),
			).toBe(true);
			expect(
				await hasProjectWorkItemReference(db, {
					orgId: "another-org",
					projectId: "private-project",
					ids,
				}),
			).toBe(false);
			expect(
				await hasProjectWorkItemReference(db, {
					orgId: "fictional-org",
					projectId: "another-project",
					ids,
				}),
			).toBe(false);
			expect(
				await hasProjectWorkItemReference(db, {
					orgId: "fictional-org",
					projectId: "private-project",
					ids: [],
				}),
			).toBe(false);
		} finally {
			sqlite.close();
		}
	});
});
