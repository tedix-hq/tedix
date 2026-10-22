import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { capabilityLinks, orgCapabilities } from "../schema/capabilities";
import { knowledgeEntries, skillEntries } from "../schema/cognitive";
import {
	memoryEntities,
	memoryEntityMentions,
	memoryEntityResolutions,
} from "../schema/memory-entities";
import {
	memoryDomains,
	memoryEdges,
	memoryFacts,
	tediExpertise,
} from "../schema/memory-graph";
import { projects } from "../schema/projects";
import { tediRationaleRecords } from "../schema/rationale-records";
import { tedis } from "../schema/tedis";
import { workItemSources } from "../schema/work-item-sources";
import { workItems } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getProjectionCapability,
	getProjectionCapabilityLink,
	getProjectionDecision,
	getProjectionDomain,
	getProjectionEdge,
	getProjectionExpertise,
	getProjectionFact,
	getProjectionKnowledgeEntry,
	getProjectionSkill,
	getProjectionTedi,
	listProjectionCapabilities,
	listProjectionCapabilityLinks,
	listProjectionDecisions,
	listProjectionEntities,
	listProjectionEntityResolutions,
	listProjectionExpertise,
	listProjectionKnowledgeEntries,
	listProjectionProjects,
	listProjectionSkills,
	listProjectionTedis,
	listProjectionWorkItems,
	listProjectionWorkItemSources,
} from "./graph-projection-read-model";

const NOW = "2026-10-22T08:00:00.000Z";
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	// Deliberately malformed cross-tenant links below exercise defensive joins.
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			tedis,
			tediRationaleRecords,
			knowledgeEntries,
			skillEntries,
			memoryDomains,
			memoryFacts,
			memoryEdges,
			tediExpertise,
			orgCapabilities,
			capabilityLinks,
			memoryEntities,
			memoryEntityMentions,
			memoryEntityResolutions,
			projects,
			workItems,
			workItemSources,
		),
	);
	const d1 = createD1Facade(sqlite);
	const statements: D1PreparedStatement[] = [];
	const prepare = d1.prepare.bind(d1);
	d1.prepare = (query) => {
		const statement = prepare(query);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => {
			const bound = bind(...values);
			statements.push(bound);
			return bound;
		};
		return statement;
	};
	const db = createDbClient(d1);
	for (const id of ["03", "01", "04", "02"]) {
		const organizationId = id === "04" ? "org-b" : "org-a";
		const linkedId = id === "01" ? "03" : id === "03" ? "01" : id;
		await db
			.insert(tedis)
			.values({
				id,
				organizationId,
				name: `Worker ${id}`,
				slug: `worker-${id}`,
			})
			.run();
		await db
			.insert(memoryDomains)
			.values({ id, organizationId, name: `Domain ${id}` })
			.run();
		await db
			.insert(memoryFacts)
			.values({
				id,
				organizationId,
				content: `Fact ${id}`,
				factType: "observation",
			})
			.run();
		await db
			.insert(tediRationaleRecords)
			.values({
				id,
				orgId: organizationId,
				tediId: id,
				action: "inspect",
				rationale: "Fixture decision",
				createdAt: NOW,
			})
			.run();
		await db
			.insert(knowledgeEntries)
			.values({
				id,
				organizationId,
				title: `Knowledge ${id}`,
				content: "Fixture knowledge",
				entryType: "insight",
			})
			.run();
		await db
			.insert(skillEntries)
			.values({
				id,
				organizationId,
				title: `Skill ${id}`,
				content: "Fixture procedure",
			})
			.run();
		await db
			.insert(tediExpertise)
			.values({
				id,
				tediId: linkedId,
				domainId: id === "04" ? "04" : "02",
				expertiseLevel: "expert",
				avgConfidence: 0.75,
			})
			.run();
		await db
			.insert(orgCapabilities)
			.values({
				id,
				organizationId,
				name: `Capability ${id}`,
				slug: `capability-${id}`,
				paceLayer: "record",
				createdAt: NOW,
			})
			.run();
		await db
			.insert(capabilityLinks)
			.values({
				id,
				organizationId,
				capabilityId: id,
				entityKind: "tedi",
				entityId: id,
				createdAt: NOW,
			})
			.run();
		await db
			.insert(memoryEntities)
			.values({
				id,
				organizationId,
				entityType: "concept",
				displayName: `Entity ${id}`,
				normalizedName: `entity-${id}`,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		await db
			.insert(memoryEntityMentions)
			.values({
				id,
				organizationId,
				occurrenceKey: id,
				sourceFactId: id,
				surfaceForm: `Entity ${id}`,
				normalizedForm: `entity-${id}`,
				proposedType: "concept",
				extractor: "fixture",
				extractorVersion: "1",
				confidence: 0.8,
				createdAt: NOW,
			})
			.run();
		await db
			.insert(memoryEntityResolutions)
			.values({
				id,
				organizationId,
				mentionId: linkedId,
				entityId: id,
				decisionId: `decision-${id}`,
				resolutionKind: "linked",
				confidence: 0.8,
				validFrom: NOW,
				createdAt: NOW,
			})
			.run();
		await db
			.insert(memoryEdges)
			.values({
				id,
				sourceFactId: id,
				targetFactId: id === "04" ? "01" : "02",
				relationType: "related_to",
				context: `Edge ${id}`,
				strength: 0.7,
			})
			.run();
		await db
			.insert(projects)
			.values({
				id,
				orgId: organizationId,
				key: `project-${id}`,
				name: `Project ${id}`,
				createdAt: NOW,
			})
			.run();
		await db
			.insert(workItems)
			.values({
				id,
				orgId: organizationId,
				title: `Work ${id}`,
				workKind: "coding",
				createdAt: NOW,
				accountableOwnerId: `owner-${id}`,
			})
			.run();
		await db
			.insert(workItemSources)
			.values({
				id,
				orgId: organizationId,
				provider: "fixture",
				externalId: `external-${id}`,
				projectId: id,
				workItemId: id,
				createdAt: NOW,
			})
			.run();
	}
	statements.length = 0;
	return { db, d1, sqlite, statements };
}

const readers = [
	["tedis", listProjectionTedis],
	["decisions", listProjectionDecisions],
	["knowledge", listProjectionKnowledgeEntries],
	["skills", listProjectionSkills],
	["expertise", listProjectionExpertise],
	["capabilities", listProjectionCapabilities],
	["capability links", listProjectionCapabilityLinks],
	["entities", listProjectionEntities],
	["entity resolutions", listProjectionEntityResolutions],
	["projects", listProjectionProjects],
	["Work items", listProjectionWorkItems],
	["Work sources", listProjectionWorkItemSources],
] as const;
const getters = [
	["fact", getProjectionFact],
	["domain", getProjectionDomain],
	["tedi", getProjectionTedi],
	["decision", getProjectionDecision],
	["knowledge", getProjectionKnowledgeEntry],
	["skill", getProjectionSkill],
	["capability", getProjectionCapability],
	["capability link", getProjectionCapabilityLink],
	["expertise", getProjectionExpertise],
	["edge", getProjectionEdge],
] as const;

describe("graph projection read model", () => {
	it.each(readers)(
		"pages %s in stable ID order without gaps, repeats or another tenant",
		async (_name, read) => {
			const { db } = await fixture();
			const input = { organizationId: "org-a", limit: 2 };
			const first = await read(db, input);
			expect(first.map((row) => row.id)).toEqual(["01", "02"]);
			const second = await read(db, { ...input, afterId: first[1]!.id });
			expect(second.map((row) => row.id)).toEqual(["03"]);
			expect(await read(db, { ...input, afterId: "03" })).toEqual([]);
			expect(
				(await read(db, { ...input, organizationId: "org-b" })).map(
					(row) => row.id,
				),
			).toEqual(["04"]);
			expect(await read(db, { ...input, organizationId: "missing" })).toEqual(
				[],
			);
		},
	);

	it.each(getters)(
		"gets a %s only within its organization, returning null for absent or foreign IDs",
		async (_name, get) => {
			const { db } = await fixture();
			expect(
				await get(db, { organizationId: "org-a", entityId: "01" }),
			).not.toBeNull();
			expect(
				await get(db, { organizationId: "org-b", entityId: "01" }),
			).toBeNull();
			expect(
				await get(db, { organizationId: "org-a", entityId: "missing" }),
			).toBeNull();
		},
	);

	it("requires both edge endpoints to belong to the requested organization", async () => {
		const { db, sqlite } = await fixture();
		expect(
			await getProjectionEdge(db, { organizationId: "org-b", entityId: "04" }),
		).toBeNull();
		sqlite
			.prepare("UPDATE memory_edges SET target_fact_id = '04' WHERE id = '01'")
			.run();
		expect(
			await getProjectionEdge(db, { organizationId: "org-a", entityId: "01" }),
		).toBeNull();
		sqlite
			.prepare(
				"UPDATE memory_edges SET target_fact_id = 'missing' WHERE id = '02'",
			)
			.run();
		expect(
			await getProjectionEdge(db, { organizationId: "org-a", entityId: "02" }),
		).toBeNull();
	});

	it("excludes unresolved and cross-tenant mentions from resolution projection", async () => {
		const { db, sqlite } = await fixture();
		sqlite
			.prepare(
				"UPDATE memory_entity_resolutions SET entity_id = NULL, resolution_kind = 'unresolved' WHERE id = '01'",
			)
			.run();
		sqlite
			.prepare(
				"UPDATE memory_entity_mentions SET organization_id = 'org-b' WHERE id = '02'",
			)
			.run();
		expect(
			await listProjectionEntityResolutions(db, {
				organizationId: "org-a",
				limit: 10,
			}),
		).toEqual([
			expect.objectContaining({
				id: "03",
				organizationId: "org-a",
				mentionId: "01",
				entityId: "03",
				sourceFactId: "01",
				confidence: 0.8,
			}),
		]);
	});

	it("preserves joined and renamed fields through a D1 batch with unique output names", async () => {
		const { db, d1, statements } = await fixture();
		for (const [, read] of readers)
			await read(db, { organizationId: "org-a", limit: 2 });
		for (const [, get] of getters)
			await get(db, { organizationId: "org-a", entityId: "01" });
		expect(statements).toHaveLength(readers.length + getters.length);
		const rows = await d1.batch(statements);
		expect(rows.map((row) => row.results.length)).toEqual([
			...readers.map(() => 2),
			...getters.map(() => 1),
		]);
		expect(
			await getProjectionExpertise(db, {
				organizationId: "org-a",
				entityId: "01",
			}),
		).toEqual({
			tediId: "03",
			domainId: "02",
			level: "expert",
			avgConfidence: 0.75,
		});
		expect(
			await getProjectionEdge(db, { organizationId: "org-a", entityId: "01" }),
		).toMatchObject({
			id: "01",
			sourceFactId: "01",
			targetFactId: "02",
			organizationId: "org-a",
			context: "Edge 01",
			strength: 0.7,
		});
		expect(
			(
				await listProjectionWorkItems(db, { organizationId: "org-a", limit: 1 })
			)[0],
		).toMatchObject({
			id: "01",
			organizationId: "org-a",
			assigneeTediId: "owner-01",
		});
	});
});
