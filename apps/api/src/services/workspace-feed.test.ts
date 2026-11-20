import { DatabaseSync } from "node:sqlite";
import { env } from "cloudflare:workers";
import { expect, it, onTestFinished } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import {
	osOutputs,
	osOutputRevisions,
} from "@tedix/db/tenant-store/outputs-schema";
import { workspaceOutputIndex } from "@tedix/db/schema/workspace-feed";
import { workspaceOutputFixture } from "../../test/workspace-output-fixture";
import {
	excerptFromContent,
	excerptFromValue,
	publishWorkspaceChange,
} from "./workspace-feed";

it.each(["uninitialized", "no runtime", "initialized"])(
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

it("reuses parsed content and stops when the excerpt or traversal budget is full", () => {
	const content = {
		kind: "sheet",
		columns: ["Name"],
		rows: [["Hello  world"], ["00000000-0000-4000-8000-000000000001"]],
	};
	expect(excerptFromValue(content)).toBe("Name Hello world");
	expect(excerptFromContent(JSON.stringify(content))).toBe(
		excerptFromValue(content),
	);
	expect(excerptFromContent("not JSON")).toBe("");
	const numeric = Array.from({ length: 10_000 }, () => 0);
	Object.defineProperty(numeric, 3_000, {
		get() {
			throw new Error("walked past traversal budget");
		},
	});
	expect(excerptFromValue(numeric)).toBe("");
	const text = ["x".repeat(100_000)];
	Object.defineProperty(text, 1, {
		get() {
			throw new Error("walked past excerpt budget");
		},
	});
	expect(excerptFromValue(text)).toMatch(/^x+$/);
	let deep: unknown = "unreachable";
	for (let depth = 0; depth < 1_000; depth++) deep = [deep];
	expect(excerptFromValue(deep)).toBe("");
});
