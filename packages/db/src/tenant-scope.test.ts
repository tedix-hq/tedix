import { organizations } from "./schema/organizations";
import { tedis } from "./schema/tedis";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "./client";
import { memoryDomains, memoryFacts } from "./schema/memory-graph";
import { createD1Facade } from "./test/d1-facade";
import { schemaDdl } from "./test/schema-ddl";
import { normalizeTenantScope, type TenantScope } from "./tenant-scope";
import {
	createFacts,
	getFactById,
	getFactsByIds,
	recordFactAccess,
	updateFact,
} from "./queries/memory-graph/facts";
import { recordRunArtifact } from "./queries/skill-run-artifacts";

const scope: TenantScope = {
	organizationId: "fictional-orchard",
	workspaceId: "fictional-workspace",
};

describe("tenant query scope", () => {
	it("keeps opaque IDs and the workspace while dropping storage-specific keys", () => {
		expect(
			normalizeTenantScope({ ...scope, orgId: "other" } as TenantScope),
		).toEqual(scope);
		expect(
			normalizeTenantScope({ organizationId: scope.organizationId }),
		).toEqual({ organizationId: scope.organizationId });
	});

	it.each([
		{},
		{ orgId: "other" },
		{ organizationId: "" },
		{ organizationId: " " },
		{ ...scope, workspaceId: "" },
	])(
		"rejects a missing or ambiguous routing identity before storing an artifact: %j",
		async (input) => {
			const untouched = new Proxy(
				{},
				{
					get() {
						throw new Error("database was touched");
					},
				},
			);
			await expect(
				recordRunArtifact(
					untouched as Parameters<typeof recordRunArtifact>[0],
					input as TenantScope,
					{ runId: "fictional-run", path: "result.json", value: {} },
				),
			).rejects.toThrow(/Tenant scope/);
		},
	);

	it("fences fact IDs and bulk writes to the supplied organization", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(schemaDdl(organizations, tedis, memoryDomains, memoryFacts));
			const db = createDbClient(createD1Facade(sqlite));
			await db.insert(organizations).values([
				{ id: scope.organizationId, name: "Orchard", slug: "orchard" },
				{ id: "fictional-other", name: "Other", slug: "other" },
			]);
			await db.insert(memoryFacts).values([
				{
					id: "own-fact",
					organizationId: scope.organizationId,
					content: "Own",
					factType: "technical",
					confidence: 0.5,
				},
				{
					id: "other-fact",
					organizationId: "fictional-other",
					content: "Other",
					factType: "technical",
					confidence: 0.5,
				},
			]);
			expect(await getFactById(db, scope, "other-fact")).toBeUndefined();
			expect(
				(
					await getFactsByIds(db, scope, ["own-fact", "other-fact"], {
						includeGraphAnchors: true,
					})
				).map((row) => row.id),
			).toEqual(["own-fact"]);
			await recordFactAccess(db, scope, "other-fact");
			await updateFact(db, scope, "other-fact", { confidence: 0.9 });
			expect(
				sqlite
					.prepare(
						"SELECT confidence, access_count FROM memory_facts WHERE id = 'other-fact'",
					)
					.get(),
			).toMatchObject({ confidence: 0.5, access_count: 0 });
			await expect(
				createFacts(db, scope, [
					{
						id: "wrong-fact",
						organizationId: "fictional-other",
						content: "Wrong",
						factType: "technical",
					},
				]),
			).rejects.toThrow("must belong to the tenant scope");
			expect(
				sqlite.prepare("SELECT count(*) AS n FROM memory_facts").get(),
			).toMatchObject({ n: 2 });
		} finally {
			sqlite.close();
		}
	});
});
