import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { createWorkspaceDocumentOwner } from "./workspace-document-owner";
const config = vi.hoisted(() => ({
	env: { WORKSPACE_RUNTIME: { outputQuery: vi.fn() } },
}));
vi.mock("cloudflare:workers", () => ({ env: config.env }));
afterEach(() => vi.resetAllMocks());
it("commits the directory before initialization and preserves duplicate-name rejection", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF;");
	sqlite.exec(schemaDdl(osWorkspaces));
	const db = createDbQueryClient(createD1Facade(sqlite));
	const input = {
		id: "new",
		organizationId: "org-test",
		name: "New",
		createdByKind: "user" as const,
		createdById: "owner",
	};
	config.env.WORKSPACE_RUNTIME.outputQuery.mockImplementation(
		async (scope, query) => {
			expect((await db.select().from(osWorkspaces))[0]?.id).toBe(
				scope.workspaceId,
			);
			throw new Error("initializer unavailable");
		},
	);
	await expect(createWorkspaceDocumentOwner(db, input)).rejects.toThrow(
		"initializer unavailable",
	);
	expect(await db.select().from(osWorkspaces)).toHaveLength(1);
	await expect(
		createWorkspaceDocumentOwner(db, { ...input, id: "retry" }),
	).rejects.toThrow();
	expect(await db.select().from(osWorkspaces)).toHaveLength(1);
	sqlite.close();
});
