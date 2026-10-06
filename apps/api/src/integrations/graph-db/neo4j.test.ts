import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
	GraphCapability,
	GraphCapabilityLink,
	GraphDecision,
	GraphEntity,
	GraphEntityResolution,
	GraphFact,
	GraphKnowledgeEntry,
	GraphSkill,
	GraphSyncEdge,
	GraphWorkItem,
} from "./types";
import { createNeo4jGraphClient, runCypherWithParams } from "./neo4j";

function response(fields: string[] = [], values: unknown[][] = []): Response {
	return new Response(JSON.stringify({ data: { fields, values } }), {
		status: 202,
		headers: { "content-type": "application/json" },
	});
}

function fact(id: string, orgId = "org-1"): GraphFact {
	return {
		id,
		orgId,
		tediId: null,
		domainId: null,
		content: id,
		summary: null,
		factType: "technical",
		confidence: 0.8,
		validTo: null,
		archivedAt: null,
		priority: "active",
		visibility: "org",
		accessCount: 0,
		usageCount: 0,
		createdAt: null,
		updatedAt: null,
	};
}

function edge(
	id: string,
	relationType: GraphSyncEdge["relationType"],
): GraphSyncEdge {
	return {
		id,
		orgId: "org-1",
		sourceFactId: `${id}-source`,
		targetFactId: `${id}-target`,
		relationType,
		strength: 0.7,
		context: null,
		updatedAt: null,
	};
}

function requestBodies(fetchMock: ReturnType<typeof vi.fn>) {
	return fetchMock.mock.calls.map(
		([, init]) =>
			JSON.parse((init as RequestInit).body as string) as {
				statement: string;
				parameters: Record<string, unknown>;
			},
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Neo4j projection writer", () => {
	it("adopts an unowned assignee before linking a Work Item", async () => {
		const fetchMock = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});
		const item: GraphWorkItem = {
			id: "work-1",
			orgId: "org-1",
			title: "Continue work",
			workKind: "coding",
			disposition: "accepted",
			priority: "high",
			projectId: null,
			parentWorkItemId: null,
			assigneeTediId: "legacy-tedi",
			objectiveId: null,
		};

		await writer.upsertWorkItem(item);

		const [workAdoption, tediAdoption, write] = requestBodies(fetchMock);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(workAdoption?.statement).toContain(
			"OPTIONAL MATCH (legacy:WorkItem",
		);
		expect(tediAdoption?.statement).toContain("OPTIONAL MATCH (legacy:Tedi");
		expect(tediAdoption?.parameters.nodes).toEqual([
			{ id: "legacy-tedi", orgId: "org-1" },
		]);
		expect(write?.statement).toContain(
			"MERGE (t:Tedi {id: $assigneeTediId, orgId: $orgId})",
		);
	});

	it("bulk upserts one fact page with adoption, one write, and committed-state verification", async () => {
		const fetchMock = vi.fn(async (_input, init) => {
			const body = JSON.parse(String((init as RequestInit).body)) as {
				statement: string;
			};
			return body.statement.includes("RETURN count(f) AS written")
				? response(["written"], [[2]])
				: response();
		});
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await writer.upsertFacts?.([
			{ ...fact("fact-1"), projectionEpoch: "generation-1" },
			{ ...fact("fact-2"), projectionEpoch: "generation-1" },
		]);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		const [adoption, body, verification] = requestBodies(fetchMock);
		expect(adoption!.statement).toContain("legacyFact.orgId IS NULL");
		expect(body!.statement).toContain("UNWIND $facts AS row");
		expect(body!.statement).toContain(
			"MERGE (f:Fact {id: row.id, orgId: row.orgId})",
		);
		expect(body!.statement).toContain(
			"OPTIONAL MATCH (f)-[managed:IN_DOMAIN|OWNED_BY]->()",
		);
		expect(body!.statement).toContain(
			"coalesce(row.projectionRepairEpoch, f.projectionRepairEpoch)",
		);
		expect(body!.parameters.facts).toEqual([
			expect.objectContaining({
				id: "fact-1",
				orgId: "org-1",
				projectionEpoch: "generation-1",
				projectionRepairEpoch: null,
			}),
			expect.objectContaining({
				id: "fact-2",
				orgId: "org-1",
				projectionEpoch: "generation-1",
				projectionRepairEpoch: null,
			}),
		]);
		expect(verification!.statement).toContain(
			"projectionEpoch: item.projectionEpoch",
		);
	});

	it("replaces single-fact managed links and stamps repaired artifacts", async () => {
		const fetchMock = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await writer.upsertFact({
			...fact("fact-1"),
			domainId: "domain-1",
			tediId: "tedi-1",
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		});

		const body = requestBodies(fetchMock).find((request) =>
			request.statement.includes("MERGE (f:Fact {id: $id, orgId: $orgId})"),
		);
		expect(body).toBeDefined();
		expect(body!.statement).toContain(
			"OPTIONAL MATCH (f)-[managed:IN_DOMAIN|OWNED_BY]->()",
		);
		expect(body!.statement).toContain("inDomain.projectionRepairEpoch =");
		expect(body!.statement).toContain("ownedBy.projectionRepairEpoch =");
		expect(body!.statement).toContain("SET inDomain.projectionEpoch");
		expect(body!.statement).toContain("SET ownedBy.projectionEpoch");
		expect(body!.parameters.projectionEpoch).toBe("generation-1");
		expect(body!.parameters.projectionRepairEpoch).toBe("repair-7");
	});

	it("groups bulk edges by allowlisted type and scopes both endpoints", async () => {
		const fetchMock = vi.fn(async (_input, init) => {
			const body = JSON.parse(String((init as RequestInit).body)) as {
				statement: string;
				parameters: { edges?: unknown[] };
			};
			return body.statement.includes("RETURN count(r) AS written")
				? response(["written"], [[body.parameters.edges?.length ?? 0]])
				: response();
		});
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await writer.upsertEdges?.([
			{ ...edge("edge-1", "related_to"), projectionEpoch: "generation-1" },
			{ ...edge("edge-2", "requires"), projectionEpoch: "generation-1" },
			{ ...edge("edge-3", "related_to"), projectionEpoch: "generation-1" },
		]);

		expect(fetchMock).toHaveBeenCalledTimes(4);
		const bodies = requestBodies(fetchMock);
		const writes = bodies.filter((body) =>
			body.statement.includes("MERGE (source)-[r:"),
		);
		const verifications = bodies.filter((body) =>
			body.statement.includes("RETURN count(r) AS written"),
		);
		expect(writes).toHaveLength(2);
		expect(verifications).toHaveLength(2);
		for (const body of writes) {
			expect(body.statement).toContain(
				"MATCH (source:Fact {id: row.sourceFactId, orgId: row.orgId})",
			);
			expect(body.statement).toContain(
				"MATCH (target:Fact {id: row.targetFactId, orgId: row.orgId})",
			);
			expect(body.statement).toContain(
				"r.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, r.projectionRepairEpoch)",
			);
			expect(body.statement).toContain(
				"FOREACH (duplicate IN tail(existingRelationships) | DELETE duplicate)",
			);
		}
		expect(
			writes.map((body) =>
				(body.parameters.edges as GraphSyncEdge[]).map((item) => item.id),
			),
		).toEqual([["edge-1", "edge-3"], ["edge-2"]]);
		for (const body of verifications) {
			expect(body.statement).toContain("WHERE r.id = row.id");
			expect(body.statement).toContain("r.updatedAt = row.updatedAt");
			expect(body.statement).toContain(
				"r.projectionRepairEpoch = row.projectionRepairEpoch",
			);
		}
	});

	it("collapses pre-existing duplicates and exactly verifies a single edge write", async () => {
		const fetchMock = vi.fn(async (_input, init) => {
			const body = JSON.parse(String((init as RequestInit).body)) as {
				statement: string;
			};
			return body.statement.includes("RETURN count(r) AS written")
				? response(["written"], [[1]])
				: response();
		});
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await writer.upsertEdge({
			...edge("edge-1", "related_to"),
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		});

		const [write, verification] = requestBodies(fetchMock);
		expect(write!.statement).toContain(
			"OPTIONAL MATCH (source)-[existing:RELATED_TO]->(target)",
		);
		expect(write!.statement).toContain(
			"FOREACH (duplicate IN tail(existingRelationships) | DELETE duplicate)",
		);
		expect(verification!.statement).toContain("WHERE r.id = $id");
		expect(verification!.statement).toContain(
			"r.projectionRepairEpoch = $projectionRepairEpoch",
		);
	});

	it("rejects unverifiable fact and edge batches before any graph mutation", async () => {
		const fetchMock = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await expect(writer.upsertFacts?.([fact("fact-1")])).rejects.toThrow(
			"verified fact batches require a stable projectionEpoch",
		);
		await expect(
			writer.upsertEdges?.([edge("edge-1", "related_to")]),
		).rejects.toThrow("verified edge batches require a stable projectionEpoch");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("tenant-scopes edge deletion and rejects arbitrary relationship labels", async () => {
		const fetchMock = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await writer.deleteEdge("source", "target", "requires", "org-1");
		const [body] = requestBodies(fetchMock);
		expect(body!.statement).toContain(
			"MATCH (a:Fact {id: $sourceFactId, orgId: $orgId})-[r:REQUIRES]->(b:Fact {id: $targetFactId, orgId: $orgId})",
		);
		expect(body!.parameters).toEqual({
			sourceFactId: "source",
			targetFactId: "target",
			orgId: "org-1",
		});

		await expect(
			writer.deleteEdge("source", "target", "not_allowed", "org-1"),
		).rejects.toThrow("Unknown fact relation type");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("replaces managed domain, knowledge, skill, and resolution links", async () => {
		const fetchMock = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await writer.upsertDomain({
			id: "domain-1",
			orgId: "org-1",
			name: "Domain",
			parentId: null,
			description: null,
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		});
		await writer.upsertKnowledgeEntry({
			id: "knowledge-1",
			orgId: "org-1",
			tediId: null,
			domainId: null,
			title: "Entry",
			content: "Body",
			entryType: "reference",
			confidence: 0.9,
			visibility: "org",
			sourceFactIds: [],
			createdAt: "2026-07-27T00:00:00.000Z",
			updatedAt: "2026-07-27T00:00:00.000Z",
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		} satisfies GraphKnowledgeEntry);
		await writer.upsertSkill({
			id: "skill-1",
			orgId: "org-1",
			tediId: null,
			domainId: null,
			title: "Skill",
			content: "Body",
			visibility: "org",
			revision: 1,
			createdAt: "2026-07-27T00:00:00.000Z",
			updatedAt: "2026-07-27T00:00:00.000Z",
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		} satisfies GraphSkill);
		await writer.upsertEntityResolution({
			id: "resolution-1",
			orgId: "org-1",
			mentionId: "mention-1",
			factId: null,
			entityId: "entity-1",
			decisionId: "entity-decision-1",
			confidence: 0.95,
			validFrom: "2026-07-27T00:00:00.000Z",
			validTo: null,
			status: "active",
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		} satisfies GraphEntityResolution);

		const requests = requestBodies(fetchMock);
		const domain = requests.find((body) =>
			body.statement.includes("MERGE (d:Domain {id: $id, orgId: $orgId})"),
		);
		const knowledge = requests.find((body) =>
			body.statement.includes(
				"MERGE (ke:KnowledgeEntry {id: $id, orgId: $orgId})",
			),
		);
		const skill = requests.find((body) =>
			body.statement.includes("MERGE (s:Skill {id: $id, orgId: $orgId})"),
		);
		const resolution = requests.find((body) =>
			body.statement.includes(
				"MERGE (r:EntityResolution {id: $id, orgId: $orgId})",
			),
		);
		expect(domain!.statement).toContain(
			"OPTIONAL MATCH ()-[managed:PARENT_OF]->(d)",
		);
		expect(knowledge!.statement).toContain(
			"OPTIONAL MATCH (ke)-[managed:SYNTHESIZED_FROM|IN_DOMAIN]->()",
		);
		expect(skill!.statement).toContain(
			"OPTIONAL MATCH (s)-[managed:OPERATES_IN]->()",
		);
		expect(resolution!.statement).toContain(
			"OPTIONAL MATCH (r)-[managed:RESOLVES_TO|SUPPORTED_BY|DECIDED_IN]->()",
		);
		expect(resolution!.statement).toContain(
			"MERGE (d:EntityResolutionDecision",
		);
		expect(resolution!.statement).toContain("SET resolvesTo.projectionEpoch");
		expect(resolution!.statement).toContain("SET supportedBy.projectionEpoch");
		expect(resolution!.statement).toContain("SET decidedIn.projectionEpoch");
		for (const body of [domain, knowledge, skill, resolution]) {
			expect(body).toBeDefined();
			expect(body!.parameters.projectionEpoch).toBe("generation-1");
			expect(body!.parameters.projectionRepairEpoch).toBe("repair-7");
		}
	});

	it("rebuilds all decision context and precedent relationships", async () => {
		const fetchMock = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});
		const decision: GraphDecision = {
			id: "decision-1",
			tediId: "tedi-1",
			orgId: "org-1",
			action: "Ship",
			rationale: "Evidence supports it",
			category: "technical",
			confidence: 0.9,
			outcomeStatus: "success",
			evidence: JSON.stringify(["fact-1"]),
			objectiveId: "objective-1",
			approvalRequestId: null,
			createdAt: "2026-07-27T00:00:00.000Z",
			completedAt: "2026-07-27T01:00:00.000Z",
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		};

		await writer.upsertDecision(decision);

		const requests = requestBodies(fetchMock);
		const context = requests.find((body) =>
			body.statement.includes("MERGE (d:Decision {id: $id, orgId: $orgId})"),
		);
		const precedent = requests.find((body) =>
			body.statement.includes("OPTIONAL MATCH (d)-[managed:PRECEDED_BY]->()"),
		);
		expect(context).toBeDefined();
		expect(precedent).toBeDefined();
		expect(context!.statement).toContain(
			"OPTIONAL MATCH (d)-[managed:DECIDED_BY|COMPLETED_AS|SERVES_OBJECTIVE|GATED_BY|INFORMED_BY|USED|IGNORED]->()",
		);
		expect(context!.statement).toContain("informedBy.projectionRepairEpoch =");
		expect(context!.statement).toContain("SET informedBy.projectionEpoch");
		expect(context!.statement).toContain("SET decidedBy.projectionEpoch");
		expect(context!.statement).toContain("SET completedAs.projectionEpoch");
		expect(context!.statement).toContain("SET servesObjective.projectionEpoch");
		expect(context!.statement).toContain("RETURN d.id AS decisionId");
		expect(precedent!.statement).toContain(
			"OPTIONAL MATCH (d)-[managed:PRECEDED_BY]->()",
		);
		expect(precedent!.statement).toContain(
			"precededBy.projectionRepairEpoch =",
		);
		expect(precedent!.statement).toContain("SET precededBy.projectionEpoch");
		expect(context!.parameters.projectionEpoch).toBe("generation-1");
		expect(precedent!.parameters.projectionEpoch).toBe("generation-1");
		expect(context!.parameters.projectionRepairEpoch).toBe("repair-7");
		expect(precedent!.parameters.projectionRepairEpoch).toBe("repair-7");
	});

	it("bulk upserts decisions and supports a complete second predecessor pass", async () => {
		const fetchMock = vi.fn(async (_input, init) => {
			const body = JSON.parse(String((init as RequestInit).body)) as {
				statement: string;
			};
			if (
				body.statement.includes("OPTIONAL MATCH (d)-[stale:PRECEDED_BY]->()")
			) {
				return response(["written", "verified"], [[2, 2]]);
			}
			if (body.statement.includes("MATCH (d)-[decidedBy:DECIDED_BY]")) {
				return response(["verified"], [[2]]);
			}
			if (body.statement.includes("RETURN count(DISTINCT d) AS written")) {
				return response(["written"], [[2]]);
			}
			return response();
		});
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});
		const decisions: GraphDecision[] = [
			{
				id: "decision-newer",
				tediId: "tedi-1",
				orgId: "org-1",
				action: "newer",
				rationale: "newer",
				category: "technical",
				confidence: 0.9,
				outcomeStatus: "success",
				evidence: JSON.stringify({
					factIds: ["fact-1"],
					unusedRawEvidence: "x".repeat(10_000),
				}),
				objectiveId: null,
				approvalRequestId: null,
				createdAt: "2026-07-27T02:00:00.000Z",
				completedAt: null,
				projectionEpoch: "generation-1",
				projectionRepairEpoch: "repair-7",
			},
			{
				id: "decision-older",
				tediId: "tedi-1",
				orgId: "org-1",
				action: "older",
				rationale: "older",
				category: "technical",
				confidence: 0.9,
				outcomeStatus: "success",
				evidence: "[]",
				objectiveId: null,
				approvalRequestId: null,
				createdAt: "2026-07-27T01:00:00.000Z",
				completedAt: null,
				projectionEpoch: "generation-1",
				projectionRepairEpoch: "repair-7",
			},
		];

		await writer.upsertDecisionContexts?.(decisions);
		const contextOnlyRequests = requestBodies(fetchMock);
		const contextVerificationWrites = contextOnlyRequests.filter((body) =>
			body.statement.includes("MATCH (d)-[decidedBy:DECIDED_BY]"),
		);
		expect(contextVerificationWrites).toHaveLength(1);
		expect(contextVerificationWrites[0]?.statement).toContain(
			"MATCH (d)-[completedAs:COMPLETED_AS]->(o:Outcome",
		);
		expect(contextVerificationWrites[0]?.statement).toContain(
			"completedAs.projectionRepairEpoch",
		);
		const contextOnlyWrite = contextOnlyRequests.find((body) =>
			body.statement.includes("UNWIND $decisions AS item\n\t\t\t\tMERGE"),
		);
		const contextOnlyParameters = contextOnlyWrite?.parameters
			.decisions as Array<Record<string, unknown>>;
		expect(contextOnlyWrite?.statement).not.toContain("|PRECEDED_BY");
		expect(contextOnlyParameters[0]).not.toHaveProperty("evidence");
		expect(contextOnlyParameters[0]).not.toHaveProperty("unusedRawEvidence");
		expect(contextOnlyParameters[0]?.evidenceFactIds).toEqual(["fact-1"]);
		const tediAdoption = contextOnlyRequests.find((body) =>
			body.statement.includes("OPTIONAL MATCH (legacy:Tedi"),
		);
		expect(tediAdoption?.parameters.nodes).toEqual([
			{ id: "tedi-1", orgId: "org-1" },
		]);

		fetchMock.mockClear();
		await writer.upsertDecisions?.(decisions);
		await writer.rebuildDecisionPredecessors?.(decisions);

		const requests = requestBodies(fetchMock);
		const write = requests.find((body) =>
			body.statement.includes("UNWIND $decisions AS item\n\t\t\t\tMERGE"),
		);
		const predecessorWrites = requests.filter((body) =>
			body.statement.includes("OPTIONAL MATCH (d)-[stale:PRECEDED_BY]->()"),
		);
		expect(write).toBeDefined();
		expect(write!.statement).toContain("d.projectionRepairEpoch =");
		expect(write!.statement).toContain("completedAs.projectionRepairEpoch =");
		expect(predecessorWrites).toHaveLength(2);
		for (const predecessor of predecessorWrites) {
			expect(predecessor.statement).toContain(
				"ORDER BY prev.createdAt DESC, prev.id DESC",
			);
			expect(predecessor.statement).toContain("LIMIT 1");
			expect(predecessor.statement).not.toContain("collect(prev)");
			expect(predecessor.statement).toContain(
				"precededBy.projectionRepairEpoch",
			);
		}

		fetchMock.mockClear();
		fetchMock.mockImplementation(async (_input, init) => {
			const body = JSON.parse(String((init as RequestInit).body)) as {
				statement: string;
			};
			if (body.statement.includes("MATCH (d)-[decidedBy:DECIDED_BY]")) {
				return response(["verified"], [[1]]);
			}
			if (body.statement.includes("RETURN count(DISTINCT d) AS written")) {
				return response(["written"], [[2]]);
			}
			return response();
		});
		await expect(writer.upsertDecisionContexts?.(decisions)).rejects.toThrow(
			"expected 2, wrote 2, verified 1",
		);

		fetchMock.mockClear();
		await expect(
			writer.upsertDecisionContexts?.(
				[{ ...decisions[0]!, projectionEpoch: undefined }],
				{
					requireProjectionEpoch: true,
				},
			),
		).rejects.toThrow("requires a projection epoch");
		expect(fetchMock).not.toHaveBeenCalled();

		await expect(
			writer.upsertDecisionContexts?.([
				decisions[0]!,
				{
					...decisions[1]!,
					orgId: "org-2",
					tediId: decisions[0]!.tediId,
				},
			]),
		).rejects.toThrow("Tedi identity tedi-1 spans organizations");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("stamps capability, entity, and expertise artifacts during repair", async () => {
		const fetchMock = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await writer.upsertCapability({
			id: "capability-1",
			orgId: "org-1",
			parentId: "capability-parent",
			name: "Capability",
			slug: "capability",
			valueStream: null,
			paceLayer: "systems",
			maturityScore: null,
			status: "active",
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		} satisfies GraphCapability);
		await writer.upsertCapabilityLink({
			capabilityId: "capability-1",
			orgId: "org-1",
			entityKind: "skill",
			entityId: "skill-1",
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		} satisfies GraphCapabilityLink);
		await writer.upsertCapabilityLink({
			capabilityId: "capability-1",
			orgId: "org-1",
			entityKind: "external_agent",
			entityId: "external-agent-1",
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		} satisfies GraphCapabilityLink);
		await writer.upsertEntity({
			id: "entity-1",
			orgId: "org-1",
			entityType: "person",
			displayName: "A",
			normalizedName: "a",
			status: "active",
			mergedIntoEntityId: "entity-2",
			version: 1,
			updatedAt: "2026-07-27T00:00:00.000Z",
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		} satisfies GraphEntity);
		await writer.upsertTediExpertise(
			"tedi-1",
			"domain-1",
			"expert",
			0.9,
			"org-1",
			"repair-7",
			"generation-1",
		);

		const requests = requestBodies(fetchMock);
		const capability = requests.find((body) =>
			body.statement.includes("MERGE (c:Capability {id: $id, orgId: $orgId})"),
		);
		const capabilityLink = requests.find((body) =>
			body.statement.includes("MERGE (e:Skill {id: $entityId"),
		);
		const externalAgentCapabilityLink = requests.find((body) =>
			body.statement.includes("MERGE (e:ExternalAgent {id: $entityId"),
		);
		const entity = requests.find((body) =>
			body.statement.includes("MERGE (e:Entity {id: $id, orgId: $orgId})"),
		);
		const expertise = requests.find((body) =>
			body.statement.includes("MERGE (t)-[e:EXPERT_IN]->(d)"),
		);
		expect(capability!.statement).toContain(
			"OPTIONAL MATCH ()-[managed:PARENT_OF]->(c)",
		);
		expect(entity!.statement).toContain(
			"OPTIONAL MATCH (e)-[managed:MERGED_INTO]->()",
		);
		expect(entity!.statement).toContain("SET mergedInto.projectionEpoch");
		expect(capabilityLink!.statement).toContain("c.projectionEpoch");
		expect(capabilityLink!.statement).toContain("e.projectionEpoch");
		expect(externalAgentCapabilityLink).toBeDefined();
		expect(externalAgentCapabilityLink!.parameters.entityId).toBe(
			"external-agent-1",
		);
		for (const body of [capability, capabilityLink, entity, expertise]) {
			expect(body).toBeDefined();
			expect(body!.statement).toContain("projectionRepairEpoch");
			expect(body!.parameters.projectionEpoch).toBe("generation-1");
			expect(body!.parameters.projectionRepairEpoch).toBe("repair-7");
		}
	});

	it("uses the canonical D1 cutoff when revoking an entity resolution", async () => {
		const fetchMock = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});
		const validTo = "2026-07-27T04:05:06.000Z";

		await writer.revokeEntityResolution("resolution-1", "org-1", validTo);

		const [body] = requestBodies(fetchMock);
		expect(body!.statement).toContain("r.validTo = $validTo");
		expect(body!.statement).not.toContain("datetime()");
		expect(body!.parameters).toEqual({
			id: "resolution-1",
			orgId: "org-1",
			validTo,
		});
	});

	it("surfaces Cypher errors returned with Query API status 202", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					errors: [
						{
							code: "Neo.ClientError.Statement.SyntaxError",
							message: "Invalid input",
						},
					],
				}),
				{
					status: 202,
					headers: { "content-type": "application/json" },
				},
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await expect(
			writer.upsertTedi({
				id: "tedi-1",
				orgId: "org-1",
				slug: "cto",
				name: "CTO",
			}),
		).rejects.toThrow("Neo.ClientError.Statement.SyntaxError: Invalid input");
	});

	it("passes one canonical orgId and both projection epochs to tedi writes", async () => {
		const fetchMock = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetchMock);
		const { writer } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await writer.upsertTedi({
			id: "tedi-1",
			orgId: "org-1",
			slug: "cto",
			name: "CTO",
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		});

		const write = requestBodies(fetchMock).find((body) =>
			body.statement.includes("MERGE (t:Tedi {id: $id, orgId: $orgId})"),
		);
		expect(write).toBeDefined();
		expect(write!.parameters).toEqual({
			id: "tedi-1",
			orgId: "org-1",
			slug: "cto",
			name: "CTO",
			projectionEpoch: "generation-1",
			projectionRepairEpoch: "repair-7",
		});
	});
});

describe("Neo4j Query API transport", () => {
	it("rejects malformed success envelopes instead of treating them as empty data", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ data: { fields: ["ok"] } }), {
						status: 202,
						headers: { "content-type": "application/json" },
					}),
			),
		);

		await expect(
			runCypherWithParams(
				{
					uri: "neo4j+s://example.neo4j.io",
					user: "neo4j",
					password: "secret",
				},
				"RETURN 1 AS ok",
				{},
			),
		).rejects.toThrow("malformed query data");
	});

	it("rejects success rows whose width disagrees with the field manifest", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response(["first", "second"], [[1]])),
		);

		await expect(
			runCypherWithParams(
				{
					uri: "neo4j+s://example.neo4j.io",
					user: "neo4j",
					password: "secret",
				},
				"RETURN 1 AS first, 2 AS second",
				{},
			),
		).rejects.toThrow("malformed query data");
	});

	it("uses GQL status fields when Query API omits legacy error fields", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							errors: [
								{
									gqlStatus: "50N42",
									statusDescription: "execution failed",
								},
							],
						}),
						{
							status: 202,
							headers: { "content-type": "application/json" },
						},
					),
			),
		);

		await expect(
			runCypherWithParams(
				{
					uri: "neo4j+s://example.neo4j.io",
					user: "neo4j",
					password: "secret",
				},
				"RETURN 1 AS ok",
				{},
			),
		).rejects.toThrow("50N42: execution failed");
	});
});

describe("Neo4j persisted algorithm reads", () => {
	it("reads persisted PageRank without creating, running, or dropping GDS", async () => {
		const fetchMock = vi.fn(async () =>
			response(
				["factId", "pageRank", "summary", "factType"],
				[["fact-1", 0.42, "Load-bearing fact", "technical"]],
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { client } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await expect(
			client.getInfluenceScores("org-1", {
				domainId: "domain-1",
				topK: 5,
			}),
		).resolves.toEqual([
			{
				factId: "fact-1",
				pageRank: 0.42,
				summary: "Load-bearing fact",
				factType: "technical",
			},
		]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [body] = requestBodies(fetchMock);
		expect(body!.statement).toContain("f.pageRank IS NOT NULL");
		expect(body!.statement).not.toContain("gds.");
		expect(body!.statement).not.toContain("graph.project");
		expect(body!.statement).not.toContain("graph.drop");
		expect(body!.parameters).toEqual({
			orgId: "org-1",
			topK: 5,
			domainId: "domain-1",
			minFactConfidence: 0.3,
		});
	});

	it("reads persisted communities without creating, running, or dropping GDS", async () => {
		const fetchMock = vi.fn(async () =>
			response(
				["communityId", "factIds", "size", "dominantDomain"],
				[[7, ["fact-1", "fact-2"], 2, null]],
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { client } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await expect(
			client.getCommunities("org-1", {
				domainId: "domain-1",
				minSize: 2,
			}),
		).resolves.toEqual([
			{
				communityId: 7,
				factIds: ["fact-1", "fact-2"],
				size: 2,
				dominantDomain: null,
			},
		]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [body] = requestBodies(fetchMock);
		expect(body!.statement).toContain("f.communityId IS NOT NULL");
		expect(body!.statement).not.toContain("gds.");
		expect(body!.statement).not.toContain("graph.project");
		expect(body!.statement).not.toContain("graph.drop");
		expect(body!.parameters).toEqual({
			orgId: "org-1",
			domainId: "domain-1",
			minSize: 2,
			minFactConfidence: 0.3,
		});
	});

	it("returns no influence scores when the persisted property read fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchMock = vi.fn(
			async () => new Response("unavailable", { status: 503 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { client } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await expect(client.getInfluenceScores("org-1")).resolves.toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"[GraphDB] persisted PageRank read failed:",
			expect.any(Error),
		);
	});

	it("persists PageRank and communities only in the controlled refresh pipeline", async () => {
		const fetchMock = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetchMock);
		const { client } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});
		const beforeStep = vi.fn(async () => {});

		await client.refreshStructuralEmbeddings("org-1", {
			epoch: "generation-a",
			sourceWatermark: 12,
			attemptKey: "generation-a-12",
			beforeStep,
		});

		const bodies = requestBodies(fetchMock);
		const statements = bodies.map((body) => body.statement);
		expect(beforeStep).toHaveBeenCalledTimes(statements.length - 1);
		const graphNames = bodies
			.flatMap((body) => [
				body.parameters.graphName,
				body.parameters.projectionName,
			])
			.filter((value): value is string => typeof value === "string");
		expect(new Set(graphNames)).toEqual(
			new Set(["fact-refresh-org-1-generation-a-12"]),
		);
		const watermarkBody = bodies.find((body) =>
			body.statement.includes("SET f.structuralEmbeddingEpoch"),
		);
		expect(watermarkBody?.parameters).toEqual(
			expect.objectContaining({
				epoch: "generation-a",
				sourceWatermark: 12,
			}),
		);
		expect(
			statements.some((statement) => statement.includes("REMOVE f.pageRank")),
		).toBe(true);
		expect(
			statements.some((statement) => statement.includes("gds.pageRank.stream")),
		).toBe(true);
		expect(
			statements.some((statement) =>
				statement.includes("SET fact.pageRank = pageRank"),
			),
		).toBe(true);
		expect(
			statements.some((statement) => statement.includes("gds.louvain.stream")),
		).toBe(true);
		expect(
			statements.some((statement) =>
				statement.includes("SET fact.communityId = communityId"),
			),
		).toBe(true);
	});

	it("drops only bounded stale projections under the exact tenant prefix before refresh", async () => {
		const staleGraphNames = [
			"fact-refresh-org-1-old-owner-a",
			"fact-refresh-org-1-old-owner-b",
		];
		const fetchMock = vi.fn(async (_input, init) => {
			const body = JSON.parse(String((init as RequestInit).body)) as {
				statement: string;
			};
			return body.statement.includes("gds.graph.list")
				? response(
						["graphName"],
						staleGraphNames.map((name) => [name]),
					)
				: response();
		});
		vi.stubGlobal("fetch", fetchMock);
		const { client } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});
		const beforeStep = vi.fn(async () => {});

		await client.refreshStructuralEmbeddings("org-1", {
			epoch: "generation-a",
			sourceWatermark: 12,
			attemptKey: "current-owner",
			beforeStep,
		});

		const bodies = requestBodies(fetchMock);
		expect(bodies[0]?.statement).toContain("gds.graph.list");
		expect(bodies[0]?.statement).toContain(
			"graphName STARTS WITH $projectionPrefix",
		);
		expect(bodies[0]?.parameters).toEqual({
			projectionPrefix: "fact-refresh-org-1-",
			excludedProjectionName: "fact-refresh-org-1-current-owner",
			limit: 33,
		});
		expect(
			bodies.slice(1, 3).map((body) => body.parameters.projectionName),
		).toEqual(staleGraphNames);
		expect(bodies[3]?.parameters.projectionName).toBe(
			"fact-refresh-org-1-current-owner",
		);
		expect(
			bodies.some(
				(body) =>
					body.parameters.projectionName === "fact-refresh-org-10-old-owner",
			),
		).toBe(false);
		expect(beforeStep).toHaveBeenCalledTimes(bodies.length - 1);
	});

	it("makes bounded stale-cleanup progress and converges across retries", async () => {
		const staleGraphNames = new Set(
			Array.from(
				{ length: 35 },
				(_, index) => `fact-refresh-org-1-stale-${index}`,
			),
		);
		const fetchMock = vi.fn(async (_input, init) => {
			const body = JSON.parse(String((init as RequestInit).body)) as {
				statement: string;
				parameters: Record<string, unknown>;
			};
			if (body.statement.includes("gds.graph.list")) {
				const limit = body.parameters.limit as number;
				return response(
					["graphName"],
					[...staleGraphNames]
						.sort()
						.slice(0, limit)
						.map((name) => [name]),
				);
			}
			const projectionName = body.parameters.projectionName;
			if (
				body.statement.includes("gds.graph.drop") &&
				typeof projectionName === "string"
			) {
				staleGraphNames.delete(projectionName);
			}
			return response();
		});
		vi.stubGlobal("fetch", fetchMock);
		const { client } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await expect(
			client.refreshStructuralEmbeddings("org-1", {
				attemptKey: "current-owner",
			}),
		).rejects.toThrow("removed 32 graphs");

		const firstAttemptBodies = requestBodies(fetchMock);
		expect(firstAttemptBodies).toHaveLength(33);
		expect(staleGraphNames.size).toBe(3);
		expect(
			firstAttemptBodies.some((body) =>
				body.statement.includes("gds.graph.project"),
			),
		).toBe(false);

		await expect(
			client.refreshStructuralEmbeddings("org-1", {
				attemptKey: "current-owner",
			}),
		).resolves.toBeUndefined();

		expect(staleGraphNames.size).toBe(0);
		expect(
			requestBodies(fetchMock).some((body) =>
				body.statement.includes("gds.graph.project"),
			),
		).toBe(true);
	});

	it("validates the overflow row before making bounded cleanup progress", async () => {
		const staleGraphNames = Array.from(
			{ length: 32 },
			(_, index) => `fact-refresh-org-1-stale-${index}`,
		);
		const fetchMock = vi.fn(async () =>
			response(
				["graphName"],
				[
					...staleGraphNames.map((name) => [name]),
					["fact-refresh-org-10-unsafe-overflow-row"],
				],
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { client } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await expect(
			client.refreshStructuralEmbeddings("org-1", {
				attemptKey: "current-owner",
			}),
		).rejects.toThrow("unsafe stale projection");

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects an out-of-prefix stale projection before dropping anything", async () => {
		const fetchMock = vi.fn(async () =>
			response(["graphName"], [["fact-refresh-org-10-other-owner"]]),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { client } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await expect(
			client.refreshStructuralEmbeddings("org-1", {
				attemptKey: "current-owner",
			}),
		).rejects.toThrow("unsafe stale projection");

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("stops before the current refresh when a stale projection drop fails", async () => {
		let call = 0;
		const fetchMock = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return response(["graphName"], [["fact-refresh-org-1-old-owner"]]);
			}
			return new Response("catalog unavailable", { status: 503 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const { client } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await expect(
			client.refreshStructuralEmbeddings("org-1", {
				attemptKey: "current-owner",
			}),
		).rejects.toThrow("503");

		const bodies = requestBodies(fetchMock);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]?.parameters.projectionName).toBe(
			"fact-refresh-org-1-old-owner",
		);
		expect(
			bodies.some((body) => body.statement.includes("gds.graph.project")),
		).toBe(false);
	});

	it("drops the attempt-scoped projection when a refresh step fails", async () => {
		const fetchMock = vi.fn(async (_input, init) => {
			const body = JSON.parse(String((init as RequestInit).body)) as {
				statement: string;
			};
			if (body.statement.includes("gds.fastRP.mutate")) {
				return new Response("GDS failed", { status: 503 });
			}
			return response();
		});
		vi.stubGlobal("fetch", fetchMock);
		const { client } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await expect(
			client.refreshStructuralEmbeddings("org-1", {
				epoch: "generation-a",
				sourceWatermark: 12,
				attemptKey: "retry/key",
			}),
		).rejects.toThrow();

		const bodies = requestBodies(fetchMock);
		const last = bodies.at(-1);
		expect(last?.statement).toContain("gds.graph.drop");
		expect(last?.parameters.projectionName).toBe(
			"fact-refresh-org-1-retry-key",
		);
	});

	it("does not suppress an initial GDS catalog cleanup failure", async () => {
		let currentGraphDrop = 0;
		const fetchMock = vi.fn(async (_input, init) => {
			const body = JSON.parse(String((init as RequestInit).body)) as {
				statement: string;
				parameters: Record<string, unknown>;
			};
			if (
				body.statement.includes("gds.graph.drop") &&
				body.parameters.projectionName === "fact-refresh-org-1-generation-a-12"
			) {
				currentGraphDrop += 1;
				if (currentGraphDrop === 1) {
					return new Response("catalog unavailable", { status: 503 });
				}
			}
			return response();
		});
		vi.stubGlobal("fetch", fetchMock);
		const { client } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});

		await expect(
			client.refreshStructuralEmbeddings("org-1", {
				epoch: "generation-a",
				sourceWatermark: 12,
				attemptKey: "generation-a-12",
			}),
		).rejects.toThrow("503");

		const bodies = requestBodies(fetchMock);
		expect(bodies).toHaveLength(3);
		expect(bodies[0]?.statement).toContain("gds.graph.list");
		expect(bodies[1]?.statement).toContain("gds.graph.drop");
		expect(bodies[2]?.statement).toContain("gds.graph.drop");
		expect(bodies[1]?.parameters.projectionName).toBe(
			"fact-refresh-org-1-generation-a-12",
		);
	});

	it("drops its uniquely owned graph even when the lease is lost after projection", async () => {
		const fetchMock = vi.fn(async () => response());
		vi.stubGlobal("fetch", fetchMock);
		const { client } = createNeo4jGraphClient({
			uri: "neo4j+s://example.neo4j.io",
			user: "neo4j",
			password: "secret",
		});
		let assertion = 0;
		const beforeStep = vi.fn(async () => {
			assertion += 1;
			if (assertion === 5) throw new Error("projection lease lost");
		});

		await expect(
			client.refreshStructuralEmbeddings("org-1", {
				epoch: "generation-a",
				sourceWatermark: 12,
				attemptKey: "lease-owner-7",
				beforeStep,
			}),
		).rejects.toThrow("projection lease lost");

		const bodies = requestBodies(fetchMock);
		expect(bodies.at(-1)?.statement).toContain("gds.graph.drop");
		expect(bodies.at(-1)?.parameters.projectionName).toBe(
			"fact-refresh-org-1-lease-owner-7",
		);
		expect(beforeStep).toHaveBeenCalledTimes(5);
	});
});
