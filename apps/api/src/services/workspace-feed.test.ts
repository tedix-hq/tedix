import { DatabaseSync } from "node:sqlite";
import { env } from "cloudflare:workers";
import { expect, it, onTestFinished } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osWorkspaces,
	osOutputs,
	osOutputRevisions,
} from "@tedix/db/schema/os-workspaces";
import { workspaceOutputIndex } from "@tedix/db/schema/workspace-feed";
import { workspaceOutputFixture } from "../../test/workspace-output-fixture";
import { publishWorkspaceChange } from "./workspace-feed";

it.each(["staged", "uninitialized", "no runtime", "initialized"])(
	"publishing keeps every indexed revision for a %s workspace",
	async (mode) => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			"CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-test');",
		);
		sqlite.exec(schemaDdl(osWorkspaces, osOutputs, osOutputRevisions));
		const db = createDbQueryClient(createD1Facade(sqlite));
		const store = workspaceOutputFixture(sqlite, { uninitialized: true });
		onTestFinished(() => sqlite.close());
		const scope = { organizationId: "org-test", workspaceId: "workspace" };
		await db.insert(osWorkspaces).values({
			id: scope.workspaceId,
			organizationId: scope.organizationId,
			name: "Example",
			createdByKind: "user",
			createdById: "owner",
		});
		if (mode === "initialized")
			await store.runtime.outputQuery(scope, { op: "initialize" });
		if (mode === "staged") store.state.importGeneration = 1;
		expect(await store.runtime.outputQuery(scope, { op: "authority" })).toBe(
			mode === "initialized" ? "object" : "shared",
		);
		if (mode === "no runtime")
			delete (env as unknown as { WORKSPACE_RUNTIME?: unknown })
				.WORKSPACE_RUNTIME;
		const now = "2026-11-01T00:00:00.000Z";
		const rows = [
			["doc", 1, 0],
			["doc", 2, 1],
			["other", 1, 1],
		].map(([id, revision, current]) => ({
			...scope,
			id: `${id}:${revision}`,
			outputId: String(id),
			revision: Number(revision),
			revisionId: `${id}-rev-${revision}`,
			isCurrent: Number(current),
			outputKind: "document" as const,
			title: String(id),
			status: "active" as const,
			outputCreatedByKind: "user" as const,
			outputCreatedById: "owner",
			outputCreatedAt: now,
			revisionCreatedByKind: "user" as const,
			revisionCreatedById: "owner",
			revisionCreatedAt: now,
			updatedAt: now,
		}));
		await db.insert(workspaceOutputIndex).values(rows);
		await publishWorkspaceChange(
			{ db },
			{
				...scope,
				kind: "output",
				id: "doc",
				revision: 3,
				actor: { kind: "user", id: "owner" },
				changeRecordId: "doc-rev-3",
				at: now,
				summary: { title: "Updated", outputKind: "document", status: "active" },
			},
		);
		const after = await db.select().from(workspaceOutputIndex);
		expect(after).toHaveLength(4);
		for (const prior of rows)
			expect(after).toContainEqual(
				expect.objectContaining({
					id: prior.id,
					outputId: prior.outputId,
					revisionId: prior.revisionId,
				}),
			);
		expect(after.find((row) => row.revisionId === "doc-rev-3")).toMatchObject({
			isCurrent: 1,
			title: "Updated",
		});
	},
);
