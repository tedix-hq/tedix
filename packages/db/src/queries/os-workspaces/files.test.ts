import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { osWorkspaceResources, osWorkspaces } from "../../schema/os-workspaces";
import { confirmOsWorkspaceFile } from "./files";

describe("file resource persistence", () => {
	it("retains resource-only confirmations idempotently without document tables", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(
				"CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-1');",
			);
			sqlite.exec(schemaDdl(osWorkspaces, osWorkspaceResources));
			const db = createDbQueryClient(createD1Facade(sqlite));
			const resource = {
				id: "file-1",
				organizationId: "org-1",
				workspaceId: "ws-1",
				providerId: "tedix",
				connectionScope: "tenant" as const,
				resourceType: "file",
				providerResourceId: "file-1",
				name: "File",
				createdByKind: "user" as const,
				createdById: "u-1",
				createdAt: "2026-11-12",
				updatedAt: "2026-11-12",
			};
			await db.insert(osWorkspaces).values({
				id: "ws-1",
				organizationId: "org-1",
				name: "Files",
				createdByKind: "user",
				createdById: "u-1",
				createdAt: "2026-11-12",
				updatedAt: "2026-11-12",
			});
			await confirmOsWorkspaceFile(db, { resource });
			await confirmOsWorkspaceFile(db, { resource });
			expect(
				sqlite.prepare("SELECT count(*) AS n FROM os_workspace_resources").get()
					?.n,
			).toBe(1);
			await expect(
				confirmOsWorkspaceFile(db, {
					resource,
					output: {
						id: "output-1",
						organizationId: "org-1",
						kind: "document",
						title: "File",
						createdByKind: "user",
						createdById: "u-1",
					},
				}),
			).rejects.toThrow("workspace object service");
			expect(
				sqlite.prepare("SELECT count(*) AS n FROM os_workspace_resources").get()
					?.n,
			).toBe(1);
		} finally {
			sqlite.close();
		}
	});
});
