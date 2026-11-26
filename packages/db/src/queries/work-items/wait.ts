import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { coreStore } from "../../core-store/dialect";
import {
	workEvents as d1WorkEvents,
	workAttemptMessages as d1WorkAttemptMessages,
	workAttempts as d1WorkAttempts,
} from "../../schema/work-items";
import {
	workInteractions as d1WorkInteractions,
	workInteractionResponses as d1WorkInteractionResponses,
} from "../../schema/work-factory";

/** Read insertion positions so equal timestamps and concurrent writers do not lose replies. */
export async function readWorkWaitPage(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		interactionId?: string;
		cursor?: {
			event: number;
			message: number;
			response: number;
			interaction?: { id: string; version: number; state: string } | null;
		};
	},
) {
	const { orgId, workItemId, cursor } = params;
	const workEvents = coreTable(db, d1WorkEvents);
	const workAttemptMessages = coreTable(db, d1WorkAttemptMessages);
	const workAttempts = coreTable(db, d1WorkAttempts);
	const workInteractions = coreTable(db, d1WorkInteractions);
	const workInteractionResponses = coreTable(db, d1WorkInteractionResponses);
	// D1 uses rowids; Postgres uses the identity sequence column.
	const postgres = coreStore(db) === "postgres";
	const messagePosition = postgres
		? sql<number>`${workAttemptMessages}.sequence`.mapWith(Number)
		: sql<number>`${workAttemptMessages}.rowid`.mapWith(Number);
	const responsePosition = postgres
		? sql<number>`${workInteractionResponses}.sequence`.mapWith(Number)
		: sql<number>`${workInteractionResponses}.rowid`.mapWith(Number);
	const order = cursor ? asc : desc;
	const limit = cursor ? 100 : 1;
	// One batch gives the initial cursor a consistent view of all three ledgers.
	const [events, messages, responses] = await db.batch([
		db
			.select({
				position: workEvents.sequence,
				id: workEvents.id,
				type: workEvents.eventType,
			})
			.from(workEvents)
			.where(
				and(
					eq(workEvents.orgId, orgId),
					eq(workEvents.workItemId, workItemId),
					cursor ? gt(workEvents.sequence, cursor.event) : undefined,
				),
			)
			.orderBy(order(workEvents.sequence))
			.limit(limit),
		db
			.select({
				position: messagePosition,
				id: workAttemptMessages.id,
				type: workAttemptMessages.kind,
			})
			.from(workAttemptMessages)
			.innerJoin(
				workAttempts,
				and(
					eq(workAttempts.id, workAttemptMessages.attemptId),
					eq(workAttempts.orgId, workAttemptMessages.orgId),
					eq(workAttempts.workItemId, workAttemptMessages.workItemId),
				),
			)
			.where(
				and(
					eq(workAttemptMessages.orgId, orgId),
					eq(workAttemptMessages.workItemId, workItemId),
					cursor ? gt(messagePosition, cursor.message) : undefined,
				),
			)
			.orderBy(order(messagePosition))
			.limit(limit),
		db
			.select({
				position: responsePosition,
				id: workInteractionResponses.id,
				type: workInteractionResponses.responseKind,
			})
			.from(workInteractionResponses)
			.innerJoin(
				workInteractions,
				and(
					eq(workInteractions.id, workInteractionResponses.interactionId),
					eq(workInteractions.orgId, workInteractionResponses.orgId),
				),
			)
			.where(
				and(
					eq(workInteractionResponses.orgId, orgId),
					eq(workInteractions.workItemId, workItemId),
					cursor ? gt(responsePosition, cursor.response) : undefined,
				),
			)
			.orderBy(order(responsePosition))
			.limit(limit),
	]);
	const [request] = params.interactionId
		? await db
				.select({
					id: workInteractions.id,
					version: workInteractions.version,
					status: workInteractions.status,
					expiresAt: workInteractions.expiresAt,
				})
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, orgId),
						eq(workInteractions.workItemId, workItemId),
						eq(workInteractions.id, params.interactionId),
					),
				)
				.limit(1)
		: [];
	const interaction = request
		? {
				id: request.id,
				version: request.version,
				state:
					request.status === "open" &&
					request.expiresAt &&
					Date.parse(request.expiresAt) <= Date.now()
						? "expired"
						: request.status,
			}
		: null;
	const interactionChanged =
		cursor &&
		params.interactionId &&
		JSON.stringify(cursor.interaction) !== JSON.stringify(interaction);
	return {
		cursor: {
			workItemId,
			event: events.at(-1)?.position ?? cursor?.event ?? 0,
			message: messages.at(-1)?.position ?? cursor?.message ?? 0,
			response: responses.at(-1)?.position ?? cursor?.response ?? 0,
			...(params.interactionId ? { interaction } : {}),
		},
		changes: cursor
			? [
					...(interactionChanged
						? [
								{
									kind: "event" as const,
									id: params.interactionId!,
									type: `interaction.${interaction?.state ?? "missing"}`,
								},
							]
						: []),
					...events.map(({ id, type }) => ({
						kind: "event" as const,
						id,
						type,
					})),
					...messages.map(({ id, type }) => ({
						kind: "message" as const,
						id,
						type,
					})),
					...responses.map(({ id, type }) => ({
						kind: "response" as const,
						id,
						type,
					})),
				]
			: [],
	};
}
