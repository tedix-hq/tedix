import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import * as appQueries from "@tedix/db/queries/apps";
import * as workflowQueries from "@tedix/db/queries/cognitive/skill-catalog";
import { createFact, updateFact } from "@tedix/db/queries/memory-graph/facts";
import * as tediQueries from "@tedix/db/queries/tedis";
import { memoryDomains, memoryFacts } from "@tedix/db/schema/memory-graph";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
import { KernelContextCache } from "../../../kernel/context-cache";
import {
	assembleHomeContext,
	renderHomeContextPrompt,
} from "./context-assembly";

describe("Home fact freshness with a warm context cache", () => {
	it("renders an updated fact on the next turn and withholds it after archival", async () => {
		const sqlite = new DatabaseSync(":memory:");
		// Only memory persistence is under test; inventory reads warm the cache.
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(memoryDomains, memoryFacts));
		const db = createDbClient(createD1Facade(sqlite));
		vi.spyOn(tediQueries, "getTedisByOrganization").mockResolvedValue([]);
		vi.spyOn(appQueries, "getAppsByOrganization").mockResolvedValue([]);
		vi.spyOn(workflowQueries, "listKernelWorkflowCatalog").mockResolvedValue(
			[],
		);
		const contextCache = new KernelContextCache();
		try {
			await createFact(db, {
				id: "fixture-fact",
				organizationId: "org-fixture",
				content: "The fictional depot's reference code is amber-17.",
				factType: "technical",
				confidence: 1,
				priority: "core",
				visibility: "org",
				memoryScope: "org",
				usePolicy: "can_use_as_evidence",
				reviewStatus: "confirmed",
			});
			const first = await assembleHomeContext(db, "org-fixture", {
				contextCache,
			});
			expect(renderHomeContextPrompt(first)).toContain("amber-17");

			await updateFact(db, "fixture-fact", {
				content: "The fictional depot's reference code is cobalt-42.",
			});
			const updated = await assembleHomeContext(db, "org-fixture", {
				contextCache,
			});
			const prompt = renderHomeContextPrompt(updated);
			expect(prompt).toContain("cobalt-42");
			expect(prompt).not.toContain("amber-17");
			expect(updated.cache?.hits).toEqual(
				expect.arrayContaining(["tedis", "apps", "workflows"]),
			);

			await updateFact(db, "fixture-fact", {
				archivedAt: new Date().toISOString(),
			});
			const archived = await assembleHomeContext(db, "org-fixture", {
				contextCache,
			});
			expect(renderHomeContextPrompt(archived)).not.toContain("cobalt-42");
		} finally {
			vi.restoreAllMocks();
			sqlite.close();
		}
	});
});
