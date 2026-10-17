import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { hasProjectWorkItemReference } from "./project-access";

describe("project Work reference lookup", () => {
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
