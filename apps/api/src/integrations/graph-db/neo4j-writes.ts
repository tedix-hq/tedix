import { runQuery, type HttpClient } from "./neo4j-http";
import {
	capabilityLinkLabel,
	factRelationshipType,
	graphEdgeParams,
	graphFactParams,
	toNumber,
} from "./neo4j-params";
import type { GraphWriter } from "./sync";
import type { GraphSyncEdge } from "./types";
import type { AdoptUnownedLegacyNodes } from "./neo4j-params";

type DecisionWriter = Pick<
	GraphWriter,
	| "upsertDecisionContexts"
	| "upsertDecisions"
	| "rebuildDecisionPredecessors"
	| "upsertDecision"
	| "upsertEntity"
	| "upsertEntityResolution"
	| "upsertDecisionGraphEdges"
	| "deleteDecision"
	| "deleteEntity"
	| "revokeEntityResolution"
	| "deleteDecisionGraphEdges"
>;
export function createNeo4jWrites(
	http: HttpClient,
	adoptUnownedLegacyNodes: AdoptUnownedLegacyNodes,
	decisions: DecisionWriter,
): GraphWriter {
	return {
		...decisions,
		async upsertFact(fact) {
			await adoptUnownedLegacyNodes([
				{ label: "Fact", id: fact.id, orgId: fact.orgId },
				{ label: "Domain", id: fact.domainId, orgId: fact.orgId },
				{ label: "Tedi", id: fact.tediId, orgId: fact.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (f:Fact {id: $id, orgId: $orgId})
				SET f.tediId = $tediId,
					f.domainId = $domainId,
					f.content = $content,
					f.summary = $summary,
					f.factType = $factType,
					f.confidence = $confidence,
					f.validTo = $validTo,
					f.archivedAt = $archivedAt,
					f.priority = $priority,
					f.visibility = $visibility,
					f.accessCount = $accessCount,
					f.usageCount = $usageCount,
					f.createdAt = $createdAt,
					f.updatedAt = $updatedAt,
					f.projectionEpoch = coalesce($projectionEpoch, f.projectionEpoch),
					f.projectionRepairEpoch = coalesce($projectionRepairEpoch, f.projectionRepairEpoch)
				WITH f
				OPTIONAL MATCH (f)-[managed:IN_DOMAIN|OWNED_BY]->()
				DELETE managed
				WITH DISTINCT f
				// Link to domain
				FOREACH (_ IN CASE WHEN $domainId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (d:Domain {id: $domainId, orgId: $orgId})
					SET d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
						d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
					MERGE (f)-[inDomain:IN_DOMAIN]->(d)
					SET inDomain.projectionEpoch = coalesce($projectionEpoch, inDomain.projectionEpoch),
						inDomain.projectionRepairEpoch = coalesce($projectionRepairEpoch, inDomain.projectionRepairEpoch))
				// Link to tedi
				FOREACH (_ IN CASE WHEN $tediId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (t:Tedi {id: $tediId, orgId: $orgId})
					SET t.projectionEpoch = coalesce($projectionEpoch, t.projectionEpoch),
						t.projectionRepairEpoch = coalesce($projectionRepairEpoch, t.projectionRepairEpoch)
					MERGE (f)-[ownedBy:OWNED_BY]->(t)
					SET ownedBy.projectionEpoch = coalesce($projectionEpoch, ownedBy.projectionEpoch),
						ownedBy.projectionRepairEpoch = coalesce($projectionRepairEpoch, ownedBy.projectionRepairEpoch))
				`,
				graphFactParams(fact),
			);
		},

		async upsertFacts(facts) {
			if (facts.length === 0) return;
			const projectedFacts = facts.map(graphFactParams);
			if (
				projectedFacts.some(
					(fact) =>
						typeof fact.projectionEpoch !== "string" ||
						fact.projectionEpoch.length === 0,
				)
			) {
				throw new Error(
					"Neo4j verified fact batches require a stable projectionEpoch",
				);
			}
			await runQuery(
				http,
				`
				UNWIND $facts AS item
				OPTIONAL MATCH (legacyFact:Fact {id: item.id})
				WHERE legacyFact.orgId IS NULL
				SET legacyFact.orgId = item.orgId
				WITH item
				OPTIONAL MATCH (legacyDomain:Domain {id: item.domainId})
				WHERE item.domainId IS NOT NULL AND legacyDomain.orgId IS NULL
				SET legacyDomain.orgId = item.orgId
				WITH item
				OPTIONAL MATCH (legacyTedi:Tedi {id: item.tediId})
				WHERE item.tediId IS NOT NULL AND legacyTedi.orgId IS NULL
				SET legacyTedi.orgId = item.orgId
				`,
				{ facts: projectedFacts },
			);
			await runQuery(
				http,
				`
				UNWIND $facts AS row
				MERGE (f:Fact {id: row.id, orgId: row.orgId})
				SET f.tediId = row.tediId,
					f.domainId = row.domainId,
					f.content = row.content,
					f.summary = row.summary,
					f.factType = row.factType,
					f.confidence = row.confidence,
					f.validTo = row.validTo,
					f.archivedAt = row.archivedAt,
					f.priority = row.priority,
					f.visibility = row.visibility,
					f.accessCount = row.accessCount,
					f.usageCount = row.usageCount,
					f.createdAt = row.createdAt,
					f.updatedAt = row.updatedAt,
					f.projectionEpoch = coalesce(row.projectionEpoch, f.projectionEpoch),
					f.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, f.projectionRepairEpoch)
				WITH row, f
				OPTIONAL MATCH (f)-[managed:IN_DOMAIN|OWNED_BY]->()
				DELETE managed
				WITH DISTINCT row, f
				FOREACH (_ IN CASE WHEN row.domainId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (d:Domain {id: row.domainId, orgId: row.orgId})
					SET d.projectionEpoch = coalesce(row.projectionEpoch, d.projectionEpoch),
						d.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, d.projectionRepairEpoch)
					MERGE (f)-[inDomain:IN_DOMAIN]->(d)
					SET inDomain.projectionEpoch = coalesce(row.projectionEpoch, inDomain.projectionEpoch),
						inDomain.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, inDomain.projectionRepairEpoch))
				FOREACH (_ IN CASE WHEN row.tediId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (t:Tedi {id: row.tediId, orgId: row.orgId})
					SET t.projectionEpoch = coalesce(row.projectionEpoch, t.projectionEpoch),
						t.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, t.projectionRepairEpoch)
					MERGE (f)-[ownedBy:OWNED_BY]->(t)
					SET ownedBy.projectionEpoch = coalesce(row.projectionEpoch, ownedBy.projectionEpoch),
						ownedBy.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, ownedBy.projectionRepairEpoch))
				`,
				{ facts: projectedFacts },
			);
			const records = await runQuery(
				http,
				`
				UNWIND $facts AS item
				MATCH (f:Fact {
					id: item.id,
					orgId: item.orgId,
					projectionEpoch: item.projectionEpoch
				})
				RETURN count(f) AS written
				`,
				{ facts: projectedFacts },
			);
			const written = toNumber(records[0]?.written);
			if (written !== facts.length) {
				throw new Error(
					`Neo4j fact batch verification failed: expected ${facts.length}, wrote ${written}`,
				);
			}
		},

		async upsertEdge(edge) {
			const relType = factRelationshipType(edge.relationType);
			const params = graphEdgeParams(edge);
			await runQuery(
				http,
				`
				MATCH (source:Fact {id: $sourceFactId, orgId: $orgId})
				MATCH (target:Fact {id: $targetFactId, orgId: $orgId})
				OPTIONAL MATCH (source)-[existing:${relType}]->(target)
				WITH source, target, existing
				ORDER BY elementId(existing)
				WITH source, target, collect(existing) AS existingRelationships
				FOREACH (duplicate IN tail(existingRelationships) | DELETE duplicate)
				WITH source, target
				MERGE (source)-[r:${relType}]->(target)
				SET r.id = $id,
					r.orgId = $orgId,
					r.strength = $strength,
					r.context = $context,
					r.relationType = $relationType,
					r.updatedAt = $updatedAt,
					r.projectionEpoch = coalesce($projectionEpoch, r.projectionEpoch),
					r.projectionRepairEpoch = coalesce($projectionRepairEpoch, r.projectionRepairEpoch)
				`,
				params,
			);
			const records = await runQuery(
				http,
				`
				MATCH (source:Fact {id: $sourceFactId, orgId: $orgId})
					-[r:${relType}]->
					(target:Fact {id: $targetFactId, orgId: $orgId})
				WHERE r.id = $id
					AND r.orgId = $orgId
					AND r.relationType = $relationType
					AND r.strength = $strength
					AND (r.context = $context OR (r.context IS NULL AND $context IS NULL))
					AND (r.updatedAt = $updatedAt OR (r.updatedAt IS NULL AND $updatedAt IS NULL))
					AND (
						r.projectionEpoch = $projectionEpoch
						OR (r.projectionEpoch IS NULL AND $projectionEpoch IS NULL)
					)
					AND (
						r.projectionRepairEpoch = $projectionRepairEpoch
						OR (
							r.projectionRepairEpoch IS NULL
							AND $projectionRepairEpoch IS NULL
						)
					)
				RETURN count(r) AS written
				`,
				params,
			);
			const written = toNumber(records[0]?.written);
			if (written !== 1) {
				throw new Error(
					`Neo4j ${relType} verification failed: expected 1, wrote ${written}`,
				);
			}
		},

		async upsertEdges(edges) {
			if (edges.length === 0) return;
			if (
				edges.some(
					(edge) =>
						typeof edge.projectionEpoch !== "string" ||
						edge.projectionEpoch.length === 0,
				)
			) {
				throw new Error(
					"Neo4j verified edge batches require a stable projectionEpoch",
				);
			}
			const byType = new Map<string, GraphSyncEdge[]>();
			for (const edge of edges) {
				const relType = factRelationshipType(edge.relationType);
				const group = byType.get(relType) ?? [];
				group.push(edge);
				byType.set(relType, group);
			}
			// Cypher cannot parameterize relationship labels. The allowlisted
			// relation groups bound a page to at most eight HTTP calls.
			for (const [relType, group] of byType) {
				const projectedEdges = group.map(graphEdgeParams);
				await runQuery(
					http,
					`
					UNWIND $edges AS row
					MATCH (source:Fact {id: row.sourceFactId, orgId: row.orgId})
					MATCH (target:Fact {id: row.targetFactId, orgId: row.orgId})
					OPTIONAL MATCH (source)-[existing:${relType}]->(target)
					WITH row, source, target, existing
					ORDER BY elementId(existing)
					WITH row, source, target, collect(existing) AS existingRelationships
					FOREACH (duplicate IN tail(existingRelationships) | DELETE duplicate)
					WITH row, source, target
					MERGE (source)-[r:${relType}]->(target)
					SET r.id = row.id,
						r.orgId = row.orgId,
						r.strength = row.strength,
						r.context = row.context,
						r.relationType = row.relationType,
						r.updatedAt = row.updatedAt,
						r.projectionEpoch = coalesce(row.projectionEpoch, r.projectionEpoch),
						r.projectionRepairEpoch = coalesce(row.projectionRepairEpoch, r.projectionRepairEpoch)
					`,
					{ edges: projectedEdges },
				);
				const records = await runQuery(
					http,
					`
					UNWIND $edges AS row
					MATCH (source:Fact {id: row.sourceFactId, orgId: row.orgId})
						-[r:${relType}]->
						(target:Fact {id: row.targetFactId, orgId: row.orgId})
					WHERE r.id = row.id
						AND r.orgId = row.orgId
						AND r.relationType = row.relationType
						AND r.strength = row.strength
						AND (r.context = row.context OR (r.context IS NULL AND row.context IS NULL))
						AND (r.updatedAt = row.updatedAt OR (r.updatedAt IS NULL AND row.updatedAt IS NULL))
						AND r.projectionEpoch = row.projectionEpoch
						AND (
							r.projectionRepairEpoch = row.projectionRepairEpoch
							OR (
								r.projectionRepairEpoch IS NULL
								AND row.projectionRepairEpoch IS NULL
							)
						)
					RETURN count(r) AS written
					`,
					{ edges: projectedEdges },
				);
				const written = toNumber(records[0]?.written);
				if (written !== group.length) {
					throw new Error(
						`Neo4j ${relType} batch verification failed: expected ${group.length}, wrote ${written}`,
					);
				}
			}
		},

		async upsertDomain(domain) {
			await adoptUnownedLegacyNodes([
				{ label: "Domain", id: domain.id, orgId: domain.orgId },
				{ label: "Domain", id: domain.parentId, orgId: domain.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (d:Domain {id: $id, orgId: $orgId})
				SET d.name = $name,
					d.parentId = $parentId,
					d.description = $description,
					d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
					d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
				WITH d
				OPTIONAL MATCH ()-[managed:PARENT_OF]->(d)
				DELETE managed
				WITH DISTINCT d
				FOREACH (_ IN CASE WHEN $parentId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (parent:Domain {id: $parentId, orgId: $orgId})
					SET parent.projectionEpoch = coalesce($projectionEpoch, parent.projectionEpoch),
						parent.projectionRepairEpoch = coalesce($projectionRepairEpoch, parent.projectionRepairEpoch)
					MERGE (parent)-[parentOf:PARENT_OF]->(d)
					SET parentOf.projectionEpoch = coalesce($projectionEpoch, parentOf.projectionEpoch),
						parentOf.projectionRepairEpoch = coalesce($projectionRepairEpoch, parentOf.projectionRepairEpoch))
				`,
				{
					id: domain.id,
					orgId: domain.orgId,
					name: domain.name,
					parentId: domain.parentId,
					description: domain.description,
					projectionEpoch: domain.projectionEpoch ?? null,
					projectionRepairEpoch: domain.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertTedi(tedi) {
			await adoptUnownedLegacyNodes([
				{ label: "Tedi", id: tedi.id, orgId: tedi.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (t:Tedi {id: $id, orgId: $orgId})
				SET t.slug = $slug,
					t.name = $name,
					t.projectionEpoch = coalesce($projectionEpoch, t.projectionEpoch),
					t.projectionRepairEpoch = coalesce($projectionRepairEpoch, t.projectionRepairEpoch)
				`,
				{
					id: tedi.id,
					orgId: tedi.orgId,
					slug: tedi.slug,
					name: tedi.name,
					projectionEpoch: tedi.projectionEpoch ?? null,
					projectionRepairEpoch: tedi.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertKnowledgeEntry(entry) {
			await adoptUnownedLegacyNodes([
				{
					label: "KnowledgeEntry",
					id: entry.id,
					orgId: entry.orgId,
				},
				{ label: "Domain", id: entry.domainId, orgId: entry.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (ke:KnowledgeEntry {id: $id, orgId: $orgId})
				SET ke.tediId = $tediId,
					ke.domainId = $domainId,
					ke.title = $title,
					ke.entryType = $entryType,
					ke.confidence = $confidence,
					ke.revision = $revision,
					ke.projectionEpoch = coalesce($projectionEpoch, ke.projectionEpoch),
					ke.projectionRepairEpoch = coalesce($projectionRepairEpoch, ke.projectionRepairEpoch)
				WITH ke
				OPTIONAL MATCH (ke)-[managed:SYNTHESIZED_FROM|IN_DOMAIN]->()
				DELETE managed
				WITH DISTINCT ke
				// Link to source facts
				CALL {
					WITH ke
					UNWIND $sourceFactIds AS factId
					MATCH (f:Fact {id: factId, orgId: $orgId})
					MERGE (ke)-[synthesizedFrom:SYNTHESIZED_FROM]->(f)
					SET synthesizedFrom.projectionEpoch = coalesce($projectionEpoch, synthesizedFrom.projectionEpoch),
						synthesizedFrom.projectionRepairEpoch = coalesce($projectionRepairEpoch, synthesizedFrom.projectionRepairEpoch)
					RETURN count(*) AS sourceCount
				}
				// Link to domain
				FOREACH (_ IN CASE WHEN $domainId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (d:Domain {id: $domainId, orgId: $orgId})
					SET d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
						d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
					MERGE (ke)-[inDomain:IN_DOMAIN]->(d)
					SET inDomain.projectionEpoch = coalesce($projectionEpoch, inDomain.projectionEpoch),
						inDomain.projectionRepairEpoch = coalesce($projectionRepairEpoch, inDomain.projectionRepairEpoch))
				`,
				{
					id: entry.id,
					orgId: entry.orgId,
					tediId: entry.tediId,
					domainId: entry.domainId,
					title: entry.title,
					entryType: entry.entryType,
					confidence: entry.confidence,
					revision: entry.revision ?? 0,
					sourceFactIds: entry.sourceFactIds ?? [],
					projectionEpoch: entry.projectionEpoch ?? null,
					projectionRepairEpoch: entry.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertSkill(skill) {
			await adoptUnownedLegacyNodes([
				{ label: "Skill", id: skill.id, orgId: skill.orgId },
				{ label: "Domain", id: skill.domainId, orgId: skill.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (s:Skill {id: $id, orgId: $orgId})
				SET s.tediId = $tediId,
					s.domainId = $domainId,
					s.title = $title,
					s.slug = $slug,
					s.successCount = $successCount,
					s.failureCount = $failureCount,
					s.revision = $revision,
					s.projectionEpoch = coalesce($projectionEpoch, s.projectionEpoch),
					s.projectionRepairEpoch = coalesce($projectionRepairEpoch, s.projectionRepairEpoch)
				WITH s
				OPTIONAL MATCH (s)-[managed:OPERATES_IN]->()
				DELETE managed
				WITH DISTINCT s
				FOREACH (_ IN CASE WHEN $domainId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (d:Domain {id: $domainId, orgId: $orgId})
					SET d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
						d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
					MERGE (s)-[operatesIn:OPERATES_IN]->(d)
					SET operatesIn.projectionEpoch = coalesce($projectionEpoch, operatesIn.projectionEpoch),
						operatesIn.projectionRepairEpoch = coalesce($projectionRepairEpoch, operatesIn.projectionRepairEpoch))
				`,
				{
					id: skill.id,
					orgId: skill.orgId,
					tediId: skill.tediId,
					domainId: skill.domainId,
					title: skill.title,
					slug: skill.slug ?? null,
					successCount: skill.successCount ?? 0,
					failureCount: skill.failureCount ?? 0,
					revision: skill.revision,
					projectionEpoch: skill.projectionEpoch ?? null,
					projectionRepairEpoch: skill.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertCapability(capability) {
			await adoptUnownedLegacyNodes([
				{
					label: "Capability",
					id: capability.id,
					orgId: capability.orgId,
				},
				{
					label: "Capability",
					id: capability.parentId,
					orgId: capability.orgId,
				},
			]);
			await runQuery(
				http,
				`
				MERGE (c:Capability {id: $id, orgId: $orgId})
				SET c.name = $name,
					c.slug = $slug,
					c.parentId = $parentId,
					c.valueStream = $valueStream,
					c.paceLayer = $paceLayer,
					c.maturityScore = $maturityScore,
					c.status = $status,
					c.projectionEpoch = coalesce($projectionEpoch, c.projectionEpoch),
					c.projectionRepairEpoch = coalesce($projectionRepairEpoch, c.projectionRepairEpoch)
				WITH c
				OPTIONAL MATCH ()-[managed:PARENT_OF]->(c)
				DELETE managed
				WITH DISTINCT c
				FOREACH (_ IN CASE WHEN $parentId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (parent:Capability {id: $parentId, orgId: $orgId})
					SET parent.projectionEpoch = coalesce($projectionEpoch, parent.projectionEpoch),
						parent.projectionRepairEpoch = coalesce($projectionRepairEpoch, parent.projectionRepairEpoch)
					MERGE (parent)-[parentOf:PARENT_OF]->(c)
					SET parentOf.projectionEpoch = coalesce($projectionEpoch, parentOf.projectionEpoch),
						parentOf.projectionRepairEpoch = coalesce($projectionRepairEpoch, parentOf.projectionRepairEpoch))
				`,
				{
					id: capability.id,
					orgId: capability.orgId,
					name: capability.name,
					slug: capability.slug,
					parentId: capability.parentId,
					valueStream: capability.valueStream,
					paceLayer: capability.paceLayer,
					maturityScore: capability.maturityScore,
					status: capability.status,
					projectionEpoch: capability.projectionEpoch ?? null,
					projectionRepairEpoch: capability.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertCapabilityLink(link) {
			const label = capabilityLinkLabel(link.entityKind);
			await adoptUnownedLegacyNodes([
				{
					label: "Capability",
					id: link.capabilityId,
					orgId: link.orgId,
				},
				{ label, id: link.entityId, orgId: link.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (c:Capability {id: $capabilityId, orgId: $orgId})
				SET c.projectionEpoch = coalesce($projectionEpoch, c.projectionEpoch),
					c.projectionRepairEpoch = coalesce($projectionRepairEpoch, c.projectionRepairEpoch)
				MERGE (e:${label} {id: $entityId, orgId: $orgId})
				SET e.projectionEpoch = coalesce($projectionEpoch, e.projectionEpoch),
					e.projectionRepairEpoch = coalesce($projectionRepairEpoch, e.projectionRepairEpoch)
				MERGE (e)-[r:SUPPORTS]->(c)
				SET r.orgId = $orgId,
					r.updatedAt = datetime(),
					r.projectionEpoch = coalesce($projectionEpoch, r.projectionEpoch),
					r.projectionRepairEpoch = coalesce($projectionRepairEpoch, r.projectionRepairEpoch)
				`,
				{
					capabilityId: link.capabilityId,
					entityId: link.entityId,
					orgId: link.orgId,
					projectionEpoch: link.projectionEpoch ?? null,
					projectionRepairEpoch: link.projectionRepairEpoch ?? null,
				},
			);
		},

		async deleteCapability(id, orgId) {
			await runQuery(
				http,
				"MATCH (c:Capability {id: $id, orgId: $orgId}) DETACH DELETE c",
				{ id, orgId },
			);
		},

		async deleteCapabilityLink(link) {
			const label = capabilityLinkLabel(link.entityKind);
			await runQuery(
				http,
				`
				MATCH (e:${label} {id: $entityId, orgId: $orgId})-[r:SUPPORTS]->(c:Capability {id: $capabilityId, orgId: $orgId})
				DELETE r
				`,
				{
					capabilityId: link.capabilityId,
					entityId: link.entityId,
					orgId: link.orgId,
				},
			);
		},

		async deleteFact(id, orgId) {
			await runQuery(
				http,
				"MATCH (f:Fact {id: $id, orgId: $orgId}) DETACH DELETE f",
				{ id, orgId },
			);
		},

		async deleteEdge(sourceFactId, targetFactId, relationType, orgId) {
			const relType = factRelationshipType(relationType);
			await runQuery(
				http,
				`
				MATCH (a:Fact {id: $sourceFactId, orgId: $orgId})-[r:${relType}]->(b:Fact {id: $targetFactId, orgId: $orgId})
				DELETE r
				`,
				{ sourceFactId, targetFactId, orgId },
			);
		},

		async deleteDomain(id, orgId) {
			await runQuery(
				http,
				"MATCH (d:Domain {id: $id, orgId: $orgId}) DETACH DELETE d",
				{ id, orgId },
			);
		},

		async deleteTedi(id, orgId) {
			await runQuery(
				http,
				"MATCH (t:Tedi {id: $id, orgId: $orgId}) DETACH DELETE t",
				{ id, orgId },
			);
		},

		async deleteKnowledgeEntry(id, orgId) {
			await runQuery(
				http,
				"MATCH (ke:KnowledgeEntry {id: $id, orgId: $orgId}) DETACH DELETE ke",
				{ id, orgId },
			);
		},

		async deleteSkill(id, orgId) {
			await runQuery(
				http,
				"MATCH (s:Skill {id: $id, orgId: $orgId}) DETACH DELETE s",
				{ id, orgId },
			);
		},

		async upsertProject(project) {
			await adoptUnownedLegacyNodes([
				{ label: "Project", id: project.id, orgId: project.orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (p:Project {id: $id, orgId: $orgId})
				SET p.key = $key,
					p.name = $name,
					p.status = $status,
					p.leadTediId = $leadTediId,
					p.objectiveId = $objectiveId,
					p.projectionEpoch = coalesce($projectionEpoch, p.projectionEpoch),
					p.projectionRepairEpoch = coalesce($projectionRepairEpoch, p.projectionRepairEpoch)
				WITH p
				OPTIONAL MATCH (p)-[managed:PURSUES]->()
				DELETE managed
				WITH DISTINCT p
				FOREACH (_ IN CASE WHEN $objectiveId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (o:Objective {id: $objectiveId, orgId: $orgId})
					MERGE (p)-[pursues:PURSUES]->(o)
					SET pursues.projectionEpoch = coalesce($projectionEpoch, pursues.projectionEpoch),
						pursues.projectionRepairEpoch = coalesce($projectionRepairEpoch, pursues.projectionRepairEpoch))
				`,
				{
					id: project.id,
					orgId: project.orgId,
					key: project.key,
					name: project.name,
					status: project.status,
					leadTediId: project.leadTediId ?? null,
					objectiveId: project.objectiveId ?? null,
					projectionEpoch: project.projectionEpoch ?? null,
					projectionRepairEpoch: project.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertWorkItem(item) {
			await adoptUnownedLegacyNodes([
				{ label: "WorkItem", id: item.id, orgId: item.orgId },
				{ label: "Tedi", id: item.assigneeTediId, orgId: item.orgId },
			]);
			// IN_PROJECT / CHILD_OF / ASSIGNED_TO are managed edges: deleted and
			// rebuilt each upsert so a re-parent or re-assign never leaves the old
			// edge behind. Same discipline as OPERATES_IN on Skill.
			await runQuery(
				http,
				`
				MERGE (w:WorkItem {id: $id, orgId: $orgId})
				SET w.title = $title,
					w.workKind = $workKind,
					w.disposition = $disposition,
					w.priority = $priority,
					w.projectId = $projectId,
					w.assigneeTediId = $assigneeTediId,
					w.objectiveId = $objectiveId,
					w.projectionEpoch = coalesce($projectionEpoch, w.projectionEpoch),
					w.projectionRepairEpoch = coalesce($projectionRepairEpoch, w.projectionRepairEpoch)
				WITH w
				OPTIONAL MATCH (w)-[managed:IN_PROJECT|CHILD_OF|ASSIGNED_TO]->()
				DELETE managed
				WITH DISTINCT w
				FOREACH (_ IN CASE WHEN $projectId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (p:Project {id: $projectId, orgId: $orgId})
					MERGE (w)-[inProject:IN_PROJECT]->(p)
					SET inProject.projectionEpoch = coalesce($projectionEpoch, inProject.projectionEpoch),
						inProject.projectionRepairEpoch = coalesce($projectionRepairEpoch, inProject.projectionRepairEpoch))
				WITH DISTINCT w
				FOREACH (_ IN CASE WHEN $parentWorkItemId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (parent:WorkItem {id: $parentWorkItemId, orgId: $orgId})
					MERGE (w)-[childOf:CHILD_OF]->(parent)
					SET childOf.projectionEpoch = coalesce($projectionEpoch, childOf.projectionEpoch),
						childOf.projectionRepairEpoch = coalesce($projectionRepairEpoch, childOf.projectionRepairEpoch))
				WITH DISTINCT w
				FOREACH (_ IN CASE WHEN $assigneeTediId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (t:Tedi {id: $assigneeTediId, orgId: $orgId})
					MERGE (w)-[assigned:ASSIGNED_TO]->(t)
					SET assigned.projectionEpoch = coalesce($projectionEpoch, assigned.projectionEpoch),
						assigned.projectionRepairEpoch = coalesce($projectionRepairEpoch, assigned.projectionRepairEpoch))
				`,
				{
					id: item.id,
					orgId: item.orgId,
					title: item.title,
					workKind: item.workKind,
					disposition: item.disposition,
					priority: item.priority,
					projectId: item.projectId ?? null,
					parentWorkItemId: item.parentWorkItemId ?? null,
					assigneeTediId: item.assigneeTediId ?? null,
					objectiveId: item.objectiveId ?? null,
					projectionEpoch: item.projectionEpoch ?? null,
					projectionRepairEpoch: item.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertWorkItemSource(source) {
			await adoptUnownedLegacyNodes([
				{ label: "WorkItemSource", id: source.id, orgId: source.orgId },
			]);
			// SOURCE_FOR points at whichever owner the row carries; both may be set,
			// which is a real relationship (the same page attached to a project and
			// to one specific item), not a duplicate.
			await runQuery(
				http,
				`
				MERGE (s:WorkItemSource {id: $id, orgId: $orgId})
				SET s.provider = $provider,
					s.externalId = $externalId,
					s.kind = $kind,
					s.state = $state,
					s.title = $title,
					s.externalUrl = $externalUrl,
					s.projectionEpoch = coalesce($projectionEpoch, s.projectionEpoch),
					s.projectionRepairEpoch = coalesce($projectionRepairEpoch, s.projectionRepairEpoch)
				WITH s
				OPTIONAL MATCH (s)-[managed:SOURCE_FOR]->()
				DELETE managed
				WITH DISTINCT s
				FOREACH (_ IN CASE WHEN $projectId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (p:Project {id: $projectId, orgId: $orgId})
					MERGE (s)-[sourceForProject:SOURCE_FOR]->(p)
					SET sourceForProject.projectionEpoch = coalesce($projectionEpoch, sourceForProject.projectionEpoch),
						sourceForProject.projectionRepairEpoch = coalesce($projectionRepairEpoch, sourceForProject.projectionRepairEpoch))
				WITH DISTINCT s
				FOREACH (_ IN CASE WHEN $workItemId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (w:WorkItem {id: $workItemId, orgId: $orgId})
					MERGE (s)-[sourceForItem:SOURCE_FOR]->(w)
					SET sourceForItem.projectionEpoch = coalesce($projectionEpoch, sourceForItem.projectionEpoch),
						sourceForItem.projectionRepairEpoch = coalesce($projectionRepairEpoch, sourceForItem.projectionRepairEpoch))
				`,
				{
					id: source.id,
					orgId: source.orgId,
					provider: source.provider,
					externalId: source.externalId,
					kind: source.kind,
					state: source.state,
					title: source.title ?? null,
					externalUrl: source.externalUrl ?? null,
					projectId: source.projectId ?? null,
					workItemId: source.workItemId ?? null,
					projectionEpoch: source.projectionEpoch ?? null,
					projectionRepairEpoch: source.projectionRepairEpoch ?? null,
				},
			);
		},

		async deleteProject(id, orgId) {
			await runQuery(
				http,
				"MATCH (p:Project {id: $id, orgId: $orgId}) DETACH DELETE p",
				{ id, orgId },
			);
		},

		async deleteWorkItem(id, orgId) {
			await runQuery(
				http,
				"MATCH (w:WorkItem {id: $id, orgId: $orgId}) DETACH DELETE w",
				{ id, orgId },
			);
		},

		async deleteWorkItemSource(id, orgId) {
			await runQuery(
				http,
				"MATCH (s:WorkItemSource {id: $id, orgId: $orgId}) DETACH DELETE s",
				{ id, orgId },
			);
		},

		async upsertTediExpertise(
			tediId,
			domainId,
			level,
			avgConfidence,
			orgId,
			projectionRepairEpoch,
			projectionEpoch,
		) {
			await adoptUnownedLegacyNodes([
				{ label: "Tedi", id: tediId, orgId },
				{ label: "Domain", id: domainId, orgId },
			]);
			await runQuery(
				http,
				`
				MERGE (t:Tedi {id: $tediId, orgId: $orgId})
				SET t.projectionEpoch = coalesce($projectionEpoch, t.projectionEpoch),
					t.projectionRepairEpoch = coalesce($projectionRepairEpoch, t.projectionRepairEpoch)
				MERGE (d:Domain {id: $domainId, orgId: $orgId})
				SET d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
					d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
				MERGE (t)-[e:EXPERT_IN]->(d)
				SET e.orgId = $orgId,
					e.level = $level,
					e.avgConfidence = $avgConfidence,
					e.updatedAt = datetime(),
					e.projectionEpoch = coalesce($projectionEpoch, e.projectionEpoch),
					e.projectionRepairEpoch = coalesce($projectionRepairEpoch, e.projectionRepairEpoch)
				`,
				{
					tediId,
					domainId,
					level,
					avgConfidence,
					orgId,
					projectionEpoch: projectionEpoch ?? null,
					projectionRepairEpoch: projectionRepairEpoch ?? null,
				},
			);
		},

		async deleteTediExpertise(tediId, domainId, orgId) {
			await runQuery(
				http,
				`
				MATCH (t:Tedi {id: $tediId, orgId: $orgId})-[e:EXPERT_IN]->(d:Domain {id: $domainId, orgId: $orgId})
				DELETE e
				`,
				{ tediId, domainId, orgId },
			);
		},
	};
}
