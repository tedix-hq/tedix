import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DecisionGraphNode } from "@tedix/api-contract/schemas/decision-graph";
import { containsCardSecret } from "@tedix/api-contract/utils/card-secrets";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { learningInteractionEvents } from "../schema/learning-feedback";
import { memoryEntities } from "../schema/memory-entities";
import type { MemoryFact } from "../schema/memory-graph";
import { organizationMembers } from "../schema/organization-members";
import { organizationSecrets } from "../schema/organization-secrets";
import {
	workInteractions,
	workInteractionResponses,
	type WorkInteraction,
} from "../schema/work-factory";
import {
	workItemComments,
	workItems,
	type WorkItem,
	type NewWorkItemRelation,
} from "../schema/work-items";
import {
	DECISION_EDGE_UPSERT_LIMIT,
	type DecisionEdgeInput,
	upsertDecisionEdges,
} from "./decision-graph";

function skipped(source: string) {
	// Source text and database errors can contain credential material.
	console.warn("[decision-graph] edge write skipped", { source });
}

export async function writeDecisionEdgesBestEffort(
	db: DbQueryClient,
	orgId: string,
	edges: readonly DecisionEdgeInput[],
) {
	for (
		let offset = 0;
		offset < edges.length;
		offset += DECISION_EDGE_UPSERT_LIMIT
	) {
		try {
			await upsertDecisionEdges(
				db,
				orgId,
				edges.slice(offset, offset + DECISION_EDGE_UPSERT_LIMIT),
			);
		} catch {
			skipped(edges[offset]!.source);
		}
	}
}

export async function recordWorkRelationEdges(
	db: DbQueryClient,
	orgId: string,
	relations: readonly NewWorkItemRelation[],
) {
	await writeDecisionEdgesBestEffort(
		db,
		orgId,
		relations.flatMap((relation) =>
			relation.orgId === orgId &&
			(relation.relationType === "blocks" ||
				relation.relationType === "supersedes")
				? [
						{
							kind: relation.relationType,
							from: { kind: "work_item" as const, id: relation.fromWorkItemId },
							to: { kind: "work_item" as const, id: relation.toWorkItemId },
							source: "work_link",
							evidenceRef: `work-relation:${relation.id}`,
							note:
								relation.relationType === "blocks"
									? "Waiting Work"
									: "Replaced Work",
							occurredAt: relation.createdAt,
						},
					]
				: [],
		),
	);
}

export async function recordPersistedCardCreationEdges(
	db: DbQueryClient,
	orgId: string,
	cardId: string,
) {
	try {
		const [card] = await db
			.select()
			.from(workInteractions)
			.where(
				and(eq(workInteractions.orgId, orgId), eq(workInteractions.id, cardId)),
			)
			.limit(1);
		if (card) await recordCardCreationEdges(db, card);
	} catch {
		skipped("deck_creation");
	}
}

export async function recordPersistedCardResolutionEdges(
	db: DbQueryClient,
	orgId: string,
	responseId: string,
) {
	try {
		const [response] = await db
			.select()
			.from(workInteractionResponses)
			.where(
				and(
					eq(workInteractionResponses.orgId, orgId),
					eq(workInteractionResponses.id, responseId),
					eq(workInteractionResponses.resolvesRequest, true),
				),
			)
			.limit(1);
		if (!response) return;
		const [card] = await db
			.select()
			.from(workInteractions)
			.where(
				and(
					eq(workInteractions.orgId, orgId),
					eq(workInteractions.id, response.interactionId),
					eq(workInteractions.targetType, "user"),
				),
			)
			.limit(1);
		if (card)
			await recordDecisionResolutionEdges(db, {
				orgId,
				cardId: card.id,
				decisionId: response.id,
				workItemId: card.workItemId,
				occurredAt: response.respondedAt,
				source: "card_resolution",
				evidenceRef: `work-interaction-response:${response.id}`,
				note: response.body,
			});
	} catch {
		skipped("card_resolution");
	}
}

const record = (
	value: JsonValue | undefined | null,
): Record<string, JsonValue> =>
	value && typeof value === "object" && !Array.isArray(value) ? value : {};
const strings = (value: JsonValue | undefined): string[] =>
	(typeof value === "string" ? [value] : Array.isArray(value) ? value : [])
		.filter((id): id is string => typeof id === "string" && !!id.trim())
		.slice(0, 50);
const label = (text: string) =>
	containsCardSecret([text])
		? "Recorded decision"
		: text.replace(/\s+/g, " ").trim().slice(0, 280);

function named(text: string, name: string | null) {
	if (!name?.trim()) return false;
	const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`,
		"iu",
	).test(text);
}

/** Matched people, systems and credentials per table per card. */
const CARD_NAME_MATCH_LIMIT = 50;
/**
 * Names are matched in JavaScript over a bounded, index-ordered window per
 * table instead of an `instr(<card text>, lower(name))` predicate, which read
 * every active row of the organization and bound the whole card text to each
 * of the three reads every card triggered. A window that fills up means the
 * organization outgrew name matching: the name arm is skipped and only the
 * metadata id list still identifies nodes.
 */
export const CARD_NAME_SCAN_LIMIT = 500;
/** Card subject, prompt and Work title bound the name-matching text. */
const CARD_NAME_MATCH_TEXT_LIMIT = 20_000;

/**
 * Union of the metadata id list and, while the candidate window did not
 * overflow, the window rows whose names appear in the card text — ordered by
 * id and capped at CARD_NAME_MATCH_LIMIT like the SQL it replaces.
 */
function cardNameCandidates<
	T extends { id: string | null; name: string | null },
>(window: T[], byIds: T[], text: string): (T & { id: string })[] {
	const merged = new Map<string, T & { id: string }>();
	for (const row of byIds)
		if (row.id) merged.set(row.id, row as T & { id: string });
	if (window.length <= CARD_NAME_SCAN_LIMIT)
		for (const row of window)
			if (row.id && !merged.has(row.id) && named(text, row.name))
				merged.set(row.id, row as T & { id: string });
	return [...merged.values()]
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.slice(0, CARD_NAME_MATCH_LIMIT);
}

export async function recordCardCreationEdges(
	db: DbQueryClient,
	card: Pick<
		WorkInteraction,
		| "targetType"
		| "kind"
		| "id"
		| "orgId"
		| "workItemId"
		| "subject"
		| "prompt"
		| "createdAt"
		| "metadata"
	>,
	work?: WorkItem | void,
) {
	if (card.targetType !== "user" || card.kind === "coordination") return;
	if (!work && card.workItemId) {
		try {
			[work] = await db
				.select()
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, card.orgId),
						eq(workItems.id, card.workItemId),
					),
				)
				.limit(1);
		} catch {
			skipped("deck_creation_work");
		}
	}
	const from = { kind: "deck_card" as const, id: card.id };
	const base = {
		source: "deck_creation",
		occurredAt: card.createdAt,
		evidenceRef: /^(approval|work-approval):/.test(card.id)
			? card.id
			: `work-interaction:${card.id}`,
	};
	if (work)
		await writeDecisionEdgesBestEffort(db, card.orgId, [
			{
				...base,
				kind: "card_from_work",
				from,
				to: { kind: "work_item", id: work.id },
				note: label(work.title),
			},
		]);
	try {
		const metadata = { ...work?.metadata, ...card.metadata };
		const source = record(metadata.source);
		const ids = [
			...new Set(
				[
					metadata.personId,
					metadata.entityId,
					metadata.systemId,
					metadata.credentialId,
					metadata.connectorId,
					source.personId,
					source.systemId,
					source.credentialId,
				].flatMap(strings),
			),
		].slice(0, 50);
		const text = `${card.subject}\n${card.prompt}\n${work?.title ?? ""}`.slice(
			0,
			CARD_NAME_MATCH_TEXT_LIMIT,
		);
		// One sequential D1 round trip: a bounded, index-ordered candidate
		// window plus the metadata id list per table. The secrets reads select
		// metadata only, never encryptedValue or hint.
		const [
			entityWindow,
			memberWindow,
			secretWindow,
			entitiesById,
			membersById,
			secretsById,
		] = await db.batch([
			db
				.select({
					id: memoryEntities.id,
					name: memoryEntities.displayName,
					type: memoryEntities.entityType,
				})
				.from(memoryEntities)
				.where(
					and(
						eq(memoryEntities.organizationId, card.orgId),
						eq(memoryEntities.status, "active"),
					),
				)
				.orderBy(memoryEntities.id)
				.limit(CARD_NAME_SCAN_LIMIT + 1),
			db
				.select({
					id: organizationMembers.userId,
					name: organizationMembers.name,
				})
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, card.orgId),
						eq(organizationMembers.status, "active"),
						isNotNull(organizationMembers.userId),
					),
				)
				.orderBy(organizationMembers.userId)
				.limit(CARD_NAME_SCAN_LIMIT + 1),
			db
				.select({ id: organizationSecrets.id, name: organizationSecrets.name })
				.from(organizationSecrets)
				.where(eq(organizationSecrets.organizationId, card.orgId))
				.orderBy(organizationSecrets.name)
				.limit(CARD_NAME_SCAN_LIMIT + 1),
			db
				.select({
					id: memoryEntities.id,
					name: memoryEntities.displayName,
					type: memoryEntities.entityType,
				})
				.from(memoryEntities)
				.where(
					and(
						eq(memoryEntities.organizationId, card.orgId),
						eq(memoryEntities.status, "active"),
						inArray(memoryEntities.id, ids),
					),
				)
				.orderBy(memoryEntities.id)
				.limit(CARD_NAME_MATCH_LIMIT),
			db
				.select({
					id: organizationMembers.userId,
					name: organizationMembers.name,
				})
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, card.orgId),
						eq(organizationMembers.status, "active"),
						inArray(organizationMembers.userId, ids),
					),
				)
				.orderBy(organizationMembers.userId)
				.limit(CARD_NAME_MATCH_LIMIT),
			db
				.select({ id: organizationSecrets.id, name: organizationSecrets.name })
				.from(organizationSecrets)
				.where(
					and(
						eq(organizationSecrets.organizationId, card.orgId),
						inArray(organizationSecrets.id, ids),
					),
				)
				.orderBy(organizationSecrets.id)
				.limit(CARD_NAME_MATCH_LIMIT),
		]);
		const involved: { node: DecisionGraphNode; name: string }[] = [];
		for (const entity of cardNameCandidates(entityWindow, entitiesById, text)) {
			const kind =
				entity.type === "person"
					? "person"
					: [
								"service",
								"tool",
								"api",
								"repository",
								"product",
								"domain",
						  ].includes(entity.type)
						? "system"
						: null;
			if (kind)
				involved.push({ node: { kind, id: entity.id }, name: entity.name });
		}
		for (const person of cardNameCandidates(memberWindow, membersById, text))
			involved.push({
				node: { kind: "person", id: person.id },
				name: person.name ?? "Person",
			});
		for (const credential of cardNameCandidates(
			secretWindow,
			secretsById,
			text,
		))
			involved.push({
				node: { kind: "credential", id: credential.id },
				name: credential.name,
			});
		await writeDecisionEdgesBestEffort(
			db,
			card.orgId,
			involved.map(({ node, name }) => ({
				...base,
				kind: "involves",
				from,
				to: node,
				note: label(name),
				confidence: ids.includes(node.id) ? 1 : 0.9,
			})),
		);
	} catch {
		skipped("deck_creation_entities");
	}
}

export async function recordDecisionResolutionEdges(
	db: DbQueryClient,
	p: {
		orgId: string;
		cardId: string;
		decisionId: string;
		workItemId?: string | null;
		occurredAt: string;
		source: string;
		evidenceRef: string;
		note: string;
	},
) {
	const from = { kind: "deck_card" as const, id: p.cardId };
	const to = { kind: "decision" as const, id: p.decisionId };
	const base = {
		source: p.source,
		occurredAt: p.occurredAt,
		evidenceRef: p.evidenceRef,
		note: label(p.note),
	};
	const edges: DecisionEdgeInput[] = [
		{ ...base, kind: "card_answers", from, to },
		{ ...base, kind: "decided_by", from, to },
	];
	try {
		if (p.workItemId) {
			const [work] = await db
				.select({ id: workItems.id })
				.from(workItems)
				.where(
					and(eq(workItems.orgId, p.orgId), eq(workItems.id, p.workItemId)),
				)
				.limit(1);
			if (work)
				edges.push({
					...base,
					kind: "decided_by",
					from: { kind: "work_item", id: work.id },
					to,
				});
		}
	} catch {
		skipped(`${p.source}_work`);
	}
	await writeDecisionEdgesBestEffort(db, p.orgId, edges);
}

export async function recordOwnerInstructionEdges(
	db: DbQueryClient,
	fact: MemoryFact,
) {
	if (
		fact.reviewStatus !== "confirmed" ||
		fact.archivedAt ||
		fact.validTo ||
		!["decision", "preference"].includes(fact.factType)
	)
		return;
	try {
		const feed = record(fact.metadata?.learningFeed);
		const evidence = record(feed.evidence);
		const ids = [
			...new Set([
				...strings(feed.evidenceEventIds),
				...(Array.isArray(evidence.sources)
					? evidence.sources.flatMap((s) => strings(record(s).id))
					: []),
			]),
		].slice(0, 50);
		const subjects = new Map<string, DecisionGraphNode>();
		let occurredAt = fact.createdAt ?? undefined;
		let referencedSubjects = 0;
		const addWork = async (id: string) => {
			const [work] = await db
				.select({ id: workItems.id })
				.from(workItems)
				.where(
					and(eq(workItems.orgId, fact.organizationId), eq(workItems.id, id)),
				)
				.limit(1);
			if (work) subjects.set(`work:${id}`, { kind: "work_item", id });
		};
		const addCard = async (id: string) => {
			const [card] = await db
				.select({
					id: workInteractions.id,
					workItemId: workInteractions.workItemId,
				})
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, fact.organizationId),
						eq(workInteractions.id, id),
						eq(workInteractions.targetType, "user"),
					),
				)
				.limit(1);
			if (!card) return;
			subjects.set(`card:${id}`, { kind: "deck_card", id });
			if (card.workItemId) await addWork(card.workItemId);
		};
		if (ids.length) {
			const events = await db
				.select({
					targetId: learningInteractionEvents.targetId,
					targetType: learningInteractionEvents.targetType,
					metadata: learningInteractionEvents.metadata,
					occurredAt: learningInteractionEvents.occurredAt,
				})
				.from(learningInteractionEvents)
				.where(
					and(
						eq(learningInteractionEvents.organizationId, fact.organizationId),
						eq(learningInteractionEvents.actorType, "user"),
						typeof feed.ownerUserId === "string"
							? eq(learningInteractionEvents.actorId, feed.ownerUserId)
							: undefined,
						inArray(learningInteractionEvents.id, ids),
					),
				)
				.orderBy(
					learningInteractionEvents.occurredAt,
					learningInteractionEvents.id,
				)
				.limit(50);
			for (const event of events) {
				occurredAt = event.occurredAt;
				if (event.targetId && event.targetType === "work_interaction")
					await addCard(event.targetId);
				if (event.targetId && event.targetType === "work_item")
					await addWork(event.targetId);
				const context = record(event.metadata?.decisionContext);
				if (typeof context.workItemId === "string")
					await addWork(context.workItemId);
				// Chat imports retain the user's quote. Only explicit record links
				// identify covered subjects; prose and model-generated titles do not.
				const answer =
					typeof event.metadata?.answer === "string"
						? event.metadata.answer.slice(0, 20000)
						: "";
				for (const match of answer.matchAll(
					/(work-item:|\/work\/items\/|work-interaction:|\/work\/interactions\/)([a-zA-Z0-9_-]{1,200})/g,
				)) {
					if (referencedSubjects++ >= 50) break;
					if (match[1] === "work-item:" || match[1] === "/work/items/")
						await addWork(match[2]!);
					else await addCard(match[2]!);
				}
			}
		}
		const commentId = fact.source?.match(/^work-comment:([^:]+)$/)?.[1];
		if (commentId) {
			const [comment] = await db
				.select({
					workItemId: workItemComments.workItemId,
					createdAt: workItemComments.createdAt,
				})
				.from(workItemComments)
				.where(
					and(
						eq(workItemComments.orgId, fact.organizationId),
						eq(workItemComments.id, commentId),
						eq(workItemComments.authorType, "user"),
					),
				)
				.limit(1);
			if (comment) {
				await addWork(comment.workItemId);
				occurredAt = comment.createdAt;
			}
		}
		await writeDecisionEdgesBestEffort(
			db,
			fact.organizationId,
			[...subjects.values()].map((from) => ({
				kind: "decided_by",
				from,
				to: { kind: "owner_instruction", id: fact.id },
				source: "owner_instruction_capture",
				evidenceRef: `memory-fact:${fact.id}`,
				note: label(fact.content),
				occurredAt,
			})),
		);
	} catch {
		skipped("owner_instruction_capture");
	}
}
