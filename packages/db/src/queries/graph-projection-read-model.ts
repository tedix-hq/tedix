import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import { projects } from "../schema/projects";
import { workItemSources } from "../schema/work-item-sources";
import { workItems } from "../schema/work-items";
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
import { tediRationaleRecords } from "../schema/rationale-records";
import { tedis } from "../schema/tedis";

const after = <TColumn>(column: TColumn, afterId?: string | null) =>
	afterId ? gt(column as Parameters<typeof gt>[0], afterId) : undefined;

export async function listProjectionTedis(db: DbClient, input: PageInput) {
	return db
		.select()
		.from(tedis)
		.where(
			and(
				eq(tedis.organizationId, input.organizationId),
				after(tedis.id, input.afterId),
			),
		)
		.orderBy(asc(tedis.id))
		.limit(input.limit);
}
export async function listProjectionDecisions(db: DbClient, input: PageInput) {
	return db
		.select()
		.from(tediRationaleRecords)
		.where(
			and(
				eq(tediRationaleRecords.orgId, input.organizationId),
				after(tediRationaleRecords.id, input.afterId),
			),
		)
		.orderBy(asc(tediRationaleRecords.id))
		.limit(input.limit);
}
export async function listProjectionKnowledgeEntries(
	db: DbClient,
	input: PageInput,
) {
	return db
		.select()
		.from(knowledgeEntries)
		.where(
			and(
				eq(knowledgeEntries.organizationId, input.organizationId),
				after(knowledgeEntries.id, input.afterId),
			),
		)
		.orderBy(asc(knowledgeEntries.id))
		.limit(input.limit);
}
export async function listProjectionSkills(db: DbClient, input: PageInput) {
	return db
		.select()
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.organizationId, input.organizationId),
				after(skillEntries.id, input.afterId),
			),
		)
		.orderBy(asc(skillEntries.id))
		.limit(input.limit);
}
export async function listProjectionExpertise(db: DbClient, input: PageInput) {
	return db
		.select({
			id: tediExpertise.id,
			tediId: tediExpertise.tediId,
			domainId: tediExpertise.domainId,
			level: tediExpertise.expertiseLevel,
			avgConfidence: tediExpertise.avgConfidence,
		})
		.from(tediExpertise)
		.innerJoin(tedis, eq(tedis.id, tediExpertise.tediId))
		.where(
			and(
				eq(tedis.organizationId, input.organizationId),
				after(tediExpertise.id, input.afterId),
			),
		)
		.orderBy(asc(tediExpertise.id))
		.limit(input.limit);
}
export async function listProjectionCapabilities(
	db: DbClient,
	input: PageInput,
) {
	return db
		.select()
		.from(orgCapabilities)
		.where(
			and(
				eq(orgCapabilities.organizationId, input.organizationId),
				after(orgCapabilities.id, input.afterId),
			),
		)
		.orderBy(asc(orgCapabilities.id))
		.limit(input.limit);
}
export async function listProjectionCapabilityLinks(
	db: DbClient,
	input: PageInput,
) {
	return db
		.select()
		.from(capabilityLinks)
		.where(
			and(
				eq(capabilityLinks.organizationId, input.organizationId),
				after(capabilityLinks.id, input.afterId),
			),
		)
		.orderBy(asc(capabilityLinks.id))
		.limit(input.limit);
}
export async function listProjectionEntities(db: DbClient, input: PageInput) {
	return db
		.select()
		.from(memoryEntities)
		.where(
			and(
				eq(memoryEntities.organizationId, input.organizationId),
				after(memoryEntities.id, input.afterId),
			),
		)
		.orderBy(asc(memoryEntities.id))
		.limit(input.limit);
}
export async function listProjectionEntityResolutions(
	db: DbClient,
	input: PageInput,
) {
	return db
		.select({
			id: memoryEntityResolutions.id,
			organizationId: memoryEntityResolutions.organizationId,
			mentionId: memoryEntityResolutions.mentionId,
			entityId: memoryEntityResolutions.entityId,
			decisionId: memoryEntityResolutions.decisionId,
			confidence: memoryEntityResolutions.confidence,
			validFrom: memoryEntityResolutions.validFrom,
			validTo: memoryEntityResolutions.validTo,
			status: memoryEntityResolutions.status,
			sourceFactId: memoryEntityMentions.sourceFactId,
		})
		.from(memoryEntityResolutions)
		.innerJoin(
			memoryEntityMentions,
			and(
				eq(memoryEntityMentions.id, memoryEntityResolutions.mentionId),
				eq(
					memoryEntityMentions.organizationId,
					memoryEntityResolutions.organizationId,
				),
			),
		)
		.where(
			and(
				eq(memoryEntityResolutions.organizationId, input.organizationId),
				isNotNull(memoryEntityResolutions.entityId),
				after(memoryEntityResolutions.id, input.afterId),
			),
		)
		.orderBy(asc(memoryEntityResolutions.id))
		.limit(input.limit);
}

type PageInput = {
	organizationId: string;
	afterId?: string | null;
	limit: number;
};
type EntityInput = { organizationId: string; entityId: string };

async function first<T>(rows: Promise<T[]>): Promise<T | null> {
	return (await rows)[0] ?? null;
}

export function getProjectionFact(db: DbClient, input: EntityInput) {
	return first(
		db
			.select()
			.from(memoryFacts)
			.where(
				and(
					eq(memoryFacts.id, input.entityId),
					eq(memoryFacts.organizationId, input.organizationId),
				),
			)
			.limit(1),
	);
}
export function getProjectionDomain(db: DbClient, input: EntityInput) {
	return first(
		db
			.select()
			.from(memoryDomains)
			.where(
				and(
					eq(memoryDomains.id, input.entityId),
					eq(memoryDomains.organizationId, input.organizationId),
				),
			)
			.limit(1),
	);
}
export function getProjectionTedi(db: DbClient, input: EntityInput) {
	return first(
		db
			.select()
			.from(tedis)
			.where(
				and(
					eq(tedis.id, input.entityId),
					eq(tedis.organizationId, input.organizationId),
				),
			)
			.limit(1),
	);
}
export function getProjectionDecision(db: DbClient, input: EntityInput) {
	return first(
		db
			.select()
			.from(tediRationaleRecords)
			.where(
				and(
					eq(tediRationaleRecords.id, input.entityId),
					eq(tediRationaleRecords.orgId, input.organizationId),
				),
			)
			.limit(1),
	);
}
export function getProjectionKnowledgeEntry(db: DbClient, input: EntityInput) {
	return first(
		db
			.select()
			.from(knowledgeEntries)
			.where(
				and(
					eq(knowledgeEntries.id, input.entityId),
					eq(knowledgeEntries.organizationId, input.organizationId),
				),
			)
			.limit(1),
	);
}
export function getProjectionSkill(db: DbClient, input: EntityInput) {
	return first(
		db
			.select()
			.from(skillEntries)
			.where(
				and(
					eq(skillEntries.id, input.entityId),
					eq(skillEntries.organizationId, input.organizationId),
				),
			)
			.limit(1),
	);
}
export function getProjectionCapability(db: DbClient, input: EntityInput) {
	return first(
		db
			.select()
			.from(orgCapabilities)
			.where(
				and(
					eq(orgCapabilities.id, input.entityId),
					eq(orgCapabilities.organizationId, input.organizationId),
				),
			)
			.limit(1),
	);
}
export function getProjectionCapabilityLink(db: DbClient, input: EntityInput) {
	return first(
		db
			.select()
			.from(capabilityLinks)
			.where(
				and(
					eq(capabilityLinks.id, input.entityId),
					eq(capabilityLinks.organizationId, input.organizationId),
				),
			)
			.limit(1),
	);
}
export function getProjectionExpertise(db: DbClient, input: EntityInput) {
	return first(
		db
			.select({
				tediId: tediExpertise.tediId,
				domainId: tediExpertise.domainId,
				level: tediExpertise.expertiseLevel,
				avgConfidence: tediExpertise.avgConfidence,
			})
			.from(tediExpertise)
			.innerJoin(tedis, eq(tedis.id, tediExpertise.tediId))
			.where(
				and(
					eq(tediExpertise.id, input.entityId),
					eq(tedis.organizationId, input.organizationId),
				),
			)
			.limit(1),
	);
}
export function getProjectionEdge(db: DbClient, input: EntityInput) {
	const sourceFact = alias(memoryFacts, "projection_edge_source");
	const targetFact = alias(memoryFacts, "projection_edge_target");
	return first(
		db
			.select({
				id: memoryEdges.id,
				sourceFactId: memoryEdges.sourceFactId,
				targetFactId: memoryEdges.targetFactId,
				relationType: memoryEdges.relationType,
				strength: memoryEdges.strength,
				context: memoryEdges.context,
				createdAt: memoryEdges.createdAt,
				organizationId: sourceFact.organizationId,
			})
			.from(memoryEdges)
			.innerJoin(sourceFact, eq(sourceFact.id, memoryEdges.sourceFactId))
			.innerJoin(targetFact, eq(targetFact.id, memoryEdges.targetFactId))
			.where(
				and(
					eq(memoryEdges.id, input.entityId),
					eq(sourceFact.organizationId, input.organizationId),
					eq(targetFact.organizationId, input.organizationId),
				),
			)
			.limit(1),
	);
}

/**
 * Work-graph projection reads. These feed the repair sweep that materializes
 * Project / WorkItem / WorkItemSource nodes, so the context graph can answer
 * "what work belongs to this engagement, and what is it built from" — a join
 * that until now existed only in D1.
 */
export async function listProjectionProjects(db: DbClient, input: PageInput) {
	return db
		.select({
			id: projects.id,
			organizationId: projects.orgId,
			key: projects.key,
			name: projects.name,
			status: projects.status,
			leadTediId: projects.leadTediId,
			objectiveId: projects.objectiveId,
			createdAt: projects.createdAt,
			updatedAt: projects.updatedAt,
		})
		.from(projects)
		.where(
			and(
				eq(projects.orgId, input.organizationId),
				after(projects.id, input.afterId),
			),
		)
		.orderBy(asc(projects.id))
		.limit(input.limit);
}

export async function listProjectionWorkItems(db: DbClient, input: PageInput) {
	return db
		.select({
			id: workItems.id,
			organizationId: workItems.orgId,
			title: workItems.title,
			workKind: workItems.workKind,
			disposition: workItems.disposition,
			priority: workItems.priority,
			projectId: workItems.projectId,
			parentWorkItemId: workItems.parentWorkItemId,
			assigneeTediId: workItems.accountableOwnerId,
			objectiveId: workItems.objectiveId,
			createdAt: workItems.createdAt,
			updatedAt: workItems.updatedAt,
		})
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, input.organizationId),
				after(workItems.id, input.afterId),
			),
		)
		.orderBy(asc(workItems.id))
		.limit(input.limit);
}

export async function listProjectionWorkItemSources(
	db: DbClient,
	input: PageInput,
) {
	return db
		.select({
			id: workItemSources.id,
			organizationId: workItemSources.orgId,
			provider: workItemSources.provider,
			externalId: workItemSources.externalId,
			kind: workItemSources.kind,
			state: workItemSources.state,
			title: workItemSources.title,
			externalUrl: workItemSources.externalUrl,
			projectId: workItemSources.projectId,
			workItemId: workItemSources.workItemId,
			createdAt: workItemSources.createdAt,
			updatedAt: workItemSources.updatedAt,
		})
		.from(workItemSources)
		.where(
			and(
				eq(workItemSources.orgId, input.organizationId),
				after(workItemSources.id, input.afterId),
			),
		)
		.orderBy(asc(workItemSources.id))
		.limit(input.limit);
}
