import { DatabaseSync } from "node:sqlite";
import {
	PortableTediDomainSchema,
	PortableTediEdgeSchema,
	PortableTediFactSchema,
	PortableTediRationaleSchema,
	PortableTediSkillSchema,
} from "@tedix/api-contract/schemas/portable-tedi";
import { portableTediDestinationId } from "@tedix/api-contract/utils/portable-tedi";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { skillEntries } from "../../schema/cognitive";
import {
	memoryDomains,
	memoryEdges,
	memoryFacts,
} from "../../schema/memory-graph";
import { tediRationaleRecords } from "../../schema/rationale-records";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	insertPortableTediDomainsPage,
	insertPortableTediEdgesPage,
	insertPortableTediFactsPage,
	insertPortableTediRationalePage,
	insertPortableTediSkillsPage,
	linkPortableTediSkillsPage,
} from "./import";

const target = {
	organizationId: "destination-org",
	tediId: "f488a70e-cd9e-4a9a-900b-a6cf3297331d",
	tediSlug: "new-worker",
	sourceTediId: "fbff74ec-50f1-4585-a8df-0cb72f968214",
};

describe("portable tedi destination writes", () => {
	it("requires operator authority for bulk facts and stays within D1 bind limits", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys=OFF");
			sqlite.exec(schemaDdl(memoryFacts));
			const db = createDbQueryClient(createD1Facade(sqlite));
			const facts = Array.from({ length: 100 }, (_, index) =>
				PortableTediFactSchema.parse({
					id: `source-fact-${index}`,
					content: `Fact ${index}`,
					factType: "technical",
					confidence: 0.8,
					accessCount: 0,
					usageCount: 0,
				}),
			);
			await expect(
				insertPortableTediFactsPage(db, target, facts, false),
			).rejects.toThrow("bulk admission");
			await insertPortableTediFactsPage(db, target, facts, true);
			await insertPortableTediFactsPage(db, target, facts, true);
			expect(
				sqlite.prepare("SELECT COUNT(*) AS n FROM memory_facts").get(),
			).toEqual({ n: 100 });
		} finally {
			sqlite.close();
		}
	});

	it("remaps graph links and leaves source app authority unbound", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys=OFF");
			sqlite.exec(
				schemaDdl(
					memoryDomains,
					memoryFacts,
					memoryEdges,
					skillEntries,
					tediRationaleRecords,
				),
			);
			const db = createDbQueryClient(createD1Facade(sqlite));
			const domains = [
				PortableTediDomainSchema.parse({
					id: "parent",
					name: "Engineering",
					parentId: null,
				}),
				PortableTediDomainSchema.parse({
					id: "child",
					name: "Runtime",
					parentId: "parent",
				}),
			];
			const facts = [
				PortableTediFactSchema.parse({
					id: "fact-a",
					domainId: "child",
					content: "An observed fact",
					factType: "technical",
					confidence: 0.9,
					memoryScope: "org",
					visibility: "shared",
					accessCount: 1,
					usageCount: 2,
				}),
				PortableTediFactSchema.parse({
					id: "fact-b",
					domainId: "child",
					promotedFrom: "fact-a",
					content: "A refined fact",
					factType: "technical",
					confidence: 0.8,
					accessCount: 0,
					usageCount: 0,
				}),
			];
			const edges = [
				PortableTediEdgeSchema.parse({
					id: "edge",
					sourceFactId: "fact-a",
					targetFactId: "fact-b",
					relationType: "related_to",
					strength: 1.2,
				}),
			];
			const skills = [
				PortableTediSkillSchema.parse({
					id: "skill-a",
					domainId: "child",
					title: "Runbook",
					slug: "runbook",
					content: "# Runbook",
					successCount: 1,
					failureCount: 0,
					revision: 1,
					visibility: "org",
					paceLayer: "innovation",
					appId: "source-app",
					toolIds: ["source-tool"],
					proposedByTediId: target.sourceTediId,
				}),
				PortableTediSkillSchema.parse({
					id: "skill-b",
					title: "Derived runbook",
					content: "# Derived",
					sourceSkillId: "skill-a",
					successCount: 0,
					failureCount: 0,
					revision: 1,
					visibility: "private",
					paceLayer: "innovation",
				}),
			];
			const rationale = [
				PortableTediRationaleSchema.parse({
					id: "decision",
					action: "Observe",
					rationale: "Because evidence",
					category: "custom",
					confidence: 0.8,
					evidence: {},
					outcome: null,
					outcomeStatus: "pending",
					approvalRequestId: null,
					objectiveId: null,
					runId: "historical-run",
					workItemId: null,
					toolCallRefs: null,
					proofRef: null,
					createdAt: "2026-09-28T00:00:00.000Z",
					completedAt: null,
					blameChain: [
						{
							component: "brain_fact",
							id: "fact-a",
							contribution: "high",
							reason: "Historical cause",
						},
					],
				}),
			];

			await insertPortableTediDomainsPage(db, target, domains);
			await insertPortableTediFactsPage(db, target, facts, true);
			await insertPortableTediEdgesPage(db, target, edges);
			await insertPortableTediSkillsPage(db, target, skills);
			await linkPortableTediSkillsPage(db, target, skills);
			await insertPortableTediRationalePage(db, target, rationale);
			await insertPortableTediFactsPage(db, target, facts, true);

			const mappedFactA = await portableTediDestinationId(
				target.tediId,
				"memoryFacts",
				"fact-a",
			);
			const mappedSkillA = await portableTediDestinationId(
				target.tediId,
				"skills",
				"skill-a",
			);
			expect(
				sqlite.prepare("SELECT COUNT(*) AS n FROM memory_facts").get(),
			).toEqual({ n: 2 });
			expect(
				sqlite
					.prepare(
						"SELECT organization_id,tedi_id,memory_scope,visibility,embedding_id FROM memory_facts WHERE id=?",
					)
					.get(mappedFactA),
			).toEqual({
				organization_id: target.organizationId,
				tedi_id: target.tediId,
				memory_scope: "tedi",
				visibility: "private",
				embedding_id: null,
			});
			expect(
				sqlite
					.prepare(
						"SELECT slug,app_id,tool_ids,visibility,proposed_by_tedi_id FROM skill_entries WHERE id=?",
					)
					.get(mappedSkillA),
			).toEqual({
				slug: "new-worker-runbook",
				app_id: null,
				tool_ids: null,
				visibility: "private",
				proposed_by_tedi_id: target.tediId,
			});
			expect(
				sqlite
					.prepare("SELECT source_fact_id,target_fact_id FROM memory_edges")
					.get(),
			).toEqual({
				source_fact_id: mappedFactA,
				target_fact_id: await portableTediDestinationId(
					target.tediId,
					"memoryFacts",
					"fact-b",
				),
			});
			expect(
				sqlite
					.prepare(
						"SELECT source_skill_id FROM skill_entries WHERE title='Derived runbook'",
					)
					.get(),
			).toEqual({ source_skill_id: mappedSkillA });
			const restoredBlame = sqlite
				.prepare("SELECT blame_chain FROM tedi_rationale_records")
				.get() as { blame_chain: string };
			expect(JSON.parse(restoredBlame.blame_chain)[0].id).toBe(mappedFactA);
		} finally {
			sqlite.close();
		}
	});
});
