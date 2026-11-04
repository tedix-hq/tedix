import { and, desc, eq, gt, sql } from "drizzle-orm";
import {
	DecisionEnvelopeSchema,
	DecisionSourcesSchema,
	type DecisionSource,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";
import type { DbQueryClient } from "../../query-client";
import { tediEmailMessages, tediEmailThreads } from "../../schema/tedi-email";
import { getWorkItemById } from "./crud";
import { workItemComments } from "../../schema/work-items";
import { getOsOutput } from "../os-workspaces/outputs";
import { workInteractions } from "../../schema/work-factory";

type Request = {
	status: string;
	kind?: string;
	targetType: string | null;
	subject: string;
	prompt: string;
	metadata: Record<string, unknown>;
};
export const DECISION_SOURCE_CHANGED =
	"This card's sources changed or cannot be verified. Ask its agent to check the facts and create a fresh card before deciding.";

/** Read again at both boundaries; a previous display check is never answer authority. */
export async function decisionSourcesCurrent(
	db: DbQueryClient,
	orgId: string,
	request: Request,
	options: { reviewedThrough?: string } = {},
) {
	return (await decisionSourcesReview(db, orgId, request, options)).current;
}

type SourceReview =
	| { current: true }
	| {
			current: false;
			/**
			 * Set when the only change is newer comments on a cited Work: the
			 * person may read the latest and answer through its time.
			 */
			reviewable?: { through: string; note: string };
	  };

export async function decisionSourcesReview(
	db: DbQueryClient,
	orgId: string,
	request: Request,
	options: { reviewedThrough?: string } = {},
): Promise<SourceReview> {
	const current = { current: true } as const;
	const changed = { current: false } as const;
	if (
		request.status !== "open" ||
		request.targetType !== "user" ||
		request.kind === "coordination"
	)
		return current;
	const envelope = DecisionEnvelopeSchema.safeParse(
		request.metadata.decisionDeck,
	);
	if (request.metadata.decisionDeck !== undefined && !envelope.success)
		return changed;
	const records = [
		request.metadata.decisionSources,
		envelope.success ? envelope.data.sources : undefined,
	].filter((raw) => raw !== undefined);
	if (!records.length) {
		// Lane Done acknowledges a step the person performed; it approves no effect.
		const follow = request.metadata.followThrough;
		const handoff =
			request.metadata.laneHandoff ??
			(follow &&
			typeof follow === "object" &&
			!Array.isArray(follow) &&
			"laneHandoff" in follow
				? follow.laneHandoff
				: undefined);
		if (
			!envelope.success &&
			handoff &&
			typeof handoff === "object" &&
			!Array.isArray(handoff) &&
			"key" in handoff &&
			"nextClick" in handoff &&
			"requestId" in handoff &&
			typeof handoff.key === "string" &&
			typeof handoff.nextClick === "string" &&
			typeof handoff.requestId === "string"
		)
			return current;
		// Never grandfather irreversible approvals whose evidence was not recorded.
		if (
			humanReservedActionClasses(`${request.subject}\n${request.prompt}`).some(
				(kind) =>
					[
						"delete_data",
						"money",
						"external_message",
						"public_publish",
					].includes(kind),
			)
		)
			return changed;
		return !envelope.success ||
			!(
				envelope.data.reversibility === "one_way" ||
				envelope.data.protectedEffects.some((effect) =>
					["money", "message", "data"].includes(effect),
				)
			)
			? current
			: changed;
	}
	let reviewable: { through: string; note: string } | undefined;
	for (const raw of records) {
		const sources = DecisionSourcesSchema.safeParse(raw);
		if (!sources.success) return changed;
		for (const source of sources.data) {
			const match = await decisionSourceMatches(
				db,
				orgId,
				source,
				options.reviewedThrough,
			);
			if (match === false) return changed;
			if (match !== true && (!reviewable || match.through > reviewable.through))
				reviewable = match;
		}
	}
	return reviewable ? { current: false, reviewable } : current;
}

/** Expire only the checked version; keep its facts and history without recording an answer. */
export async function retireDecisionSourceCard(
	db: DbQueryClient,
	p: {
		orgId: string;
		id: string;
		targetId: string;
		version: number;
		now: string;
	},
) {
	return db
		.update(workInteractions)
		.set({
			status: "expired",
			expiredAt: p.now,
			resolutionFence: crypto.randomUUID(),
			version: sql`${workInteractions.version}+1`,
			metadata: sql`json_set(${workInteractions.metadata}, '$.supersession', json(${JSON.stringify({ reason: "decision_sources_changed", at: p.now })}))`,
		})
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				eq(workInteractions.id, p.id),
				eq(workInteractions.version, p.version),
				eq(workInteractions.status, "open"),
				eq(workInteractions.targetType, "user"),
				eq(workInteractions.targetId, p.targetId),
			),
		)
		.returning({ id: workInteractions.id });
}

/** Only tenant-scoped reads; missing/archived sources never validate a decision. */
async function decisionSourceMatches(
	db: DbQueryClient,
	orgId: string,
	source: DecisionSource,
	reviewedThrough?: string,
): Promise<boolean | { through: string; note: string }> {
	switch (source.kind) {
		case "work": {
			const work = await getWorkItemById(db, source.id, orgId);
			if (!work || work.version !== source.version) return false;
			const [comments] = await db
				.select({ count: sql<number>`count(*)` })
				.from(workItemComments)
				.where(
					and(
						eq(workItemComments.orgId, orgId),
						eq(workItemComments.workItemId, source.id),
					),
				);
			const count = Number(comments?.count);
			if (count === source.commentCount) return true;
			if (count < source.commentCount) return false;
			// Only newer comments: current through what the person has read.
			const [latest] = await db
				.select({
					body: workItemComments.body,
					createdAt: workItemComments.createdAt,
				})
				.from(workItemComments)
				.where(
					and(
						eq(workItemComments.orgId, orgId),
						eq(workItemComments.workItemId, source.id),
						reviewedThrough
							? gt(workItemComments.createdAt, reviewedThrough)
							: undefined,
					),
				)
				.orderBy(desc(workItemComments.createdAt), desc(workItemComments.id))
				.limit(1);
			if (!latest) return true;
			return { through: latest.createdAt, note: latest.body.slice(0, 600) };
		}
		case "output": {
			const output = await getOsOutput(db, {
				organizationId: orgId,
				outputId: source.id,
			});
			return (
				output?.status === "active" &&
				output.currentRevisionId === source.revisionId
			);
		}
		case "email_thread": {
			const [thread] = await db
				.select({
					updatedAt: tediEmailThreads.updatedAt,
					lastMessageAt: tediEmailThreads.lastMessageAt,
				})
				.from(tediEmailThreads)
				.where(
					and(
						eq(tediEmailThreads.id, source.id),
						eq(tediEmailThreads.organizationId, orgId),
						eq(tediEmailThreads.tediId, source.tediId),
					),
				)
				.limit(1);
			if (
				!thread ||
				thread.updatedAt !== source.updatedAt ||
				thread.lastMessageAt !== source.lastMessageAt
			)
				return false;
			// Count also catches delayed inbound messages whose timestamp precedes the latest message.
			const [messages] = await db
				.select({ count: sql<number>`count(*)` })
				.from(tediEmailMessages)
				.where(
					and(
						eq(tediEmailMessages.threadId, source.id),
						eq(tediEmailMessages.organizationId, orgId),
						eq(tediEmailMessages.tediId, source.tediId),
					),
				);
			return Number(messages?.count) === source.messageCount;
		}
	}
}
