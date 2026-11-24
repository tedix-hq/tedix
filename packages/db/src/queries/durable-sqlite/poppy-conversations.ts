/**
 * Reads and writes of the Poppy conversation tables (`poppy-store/schema.ts`)
 * in a tedi runtime Durable Object. Every function is synchronous; callers
 * group a request's statements inside the object's `transactionSync`.
 */
import {
	type AnyColumn,
	and,
	asc,
	desc,
	eq,
	gt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import type { PoppyStoreDb } from "../../poppy-store/store";
import {
	poppyConversations,
	poppyDesks,
	poppyEvents,
	poppyRequests,
} from "../../poppy-store/schema";

export type PoppyRequestRow = typeof poppyRequests.$inferSelect;

const maxSequence = (column: AnyColumn) =>
	sql<number>`coalesce(max(${column}), 0)`.mapWith(Number);

export function getPoppyConversation(
	db: PoppyStoreDb,
	id: string,
): string | undefined {
	return db
		.select({ value: poppyConversations.value })
		.from(poppyConversations)
		.where(eq(poppyConversations.id, id))
		.get()?.value;
}

export function savePoppyConversation(
	db: PoppyStoreDb,
	p: { id: string; value: string },
): void {
	db.insert(poppyConversations)
		.values(p)
		.onConflictDoUpdate({
			target: poppyConversations.id,
			set: { value: p.value },
		})
		.run();
}

export function insertPoppyEvent(
	db: PoppyStoreDb,
	p: { conversation: string; id: string; value: string },
): void {
	db.insert(poppyEvents).values(p).run();
}

/**
 * Open a human desk covering every request so far, plus the one about to be
 * recorded when `includesNewRequest`.
 */
export function openPoppyDesk(
	db: PoppyStoreDb,
	p: {
		id: string;
		conversation: string;
		root: string;
		includesNewRequest: boolean;
	},
): void {
	const through =
		db
			.select({ max: maxSequence(poppyRequests.sequence) })
			.from(poppyRequests)
			.get()?.max ?? 0;
	db.insert(poppyDesks)
		.values({
			id: p.id,
			conversation: p.conversation,
			root: p.root,
			pending: 1,
			throughSequence: through + (p.includesNewRequest ? 1 : 0),
		})
		.run();
}

export function closePoppyDesks(db: PoppyStoreDb, conversation: string): void {
	db.update(poppyDesks)
		.set({ pending: 0 })
		.where(eq(poppyDesks.conversation, conversation))
		.run();
}

export function closePoppyDesk(db: PoppyStoreDb, id: string): void {
	db.update(poppyDesks).set({ pending: 0 }).where(eq(poppyDesks.id, id)).run();
}

export function findPoppyDesk(
	db: PoppyStoreDb,
	p: { id: string; conversation: string },
) {
	return db
		.select({
			pending: poppyDesks.pending,
			throughSequence: poppyDesks.throughSequence,
		})
		.from(poppyDesks)
		.where(
			and(eq(poppyDesks.id, p.id), eq(poppyDesks.conversation, p.conversation)),
		)
		.get();
}

/** Desks of a conversation and of its direct conversations. */
export function listPoppyDesks(db: PoppyStoreDb, conversation: string) {
	return db
		.select({
			id: poppyDesks.id,
			conversation: poppyDesks.conversation,
			pending: poppyDesks.pending,
		})
		.from(poppyDesks)
		.where(
			or(
				eq(poppyDesks.root, conversation),
				eq(poppyDesks.conversation, conversation),
			),
		)
		.all();
}

export function findPoppyRequest(
	db: PoppyStoreDb,
	p: { owner: string; id: string },
): PoppyRequestRow | undefined {
	return db
		.select()
		.from(poppyRequests)
		.where(and(eq(poppyRequests.owner, p.owner), eq(poppyRequests.id, p.id)))
		.get();
}

/** Record an accepted request; it has seen every event of its conversation so far. */
export function insertPoppyRequest(
	db: PoppyStoreDb,
	p: Omit<typeof poppyRequests.$inferInsert, "sequence" | "throughSequence">,
): void {
	const through =
		db
			.select({ max: maxSequence(poppyEvents.sequence) })
			.from(poppyEvents)
			.where(eq(poppyEvents.conversation, p.conversation))
			.get()?.max ?? 0;
	db.insert(poppyRequests)
		.values({ ...p, throughSequence: through })
		.run();
}

/** Mark one request, every request of a conversation, or those up to a sequence as answered. */
export function settlePoppyRequests(
	db: PoppyStoreDb,
	p:
		| { owner: string; id: string }
		| { conversation: string; throughSequence?: number },
): void {
	db.update(poppyRequests)
		.set({ pending: 0 })
		.where(
			"owner" in p
				? and(eq(poppyRequests.owner, p.owner), eq(poppyRequests.id, p.id))
				: and(
						eq(poppyRequests.conversation, p.conversation),
						p.throughSequence === undefined
							? undefined
							: lte(poppyRequests.sequence, p.throughSequence),
					),
		)
		.run();
}

/** Hand a conversation's waiting requests to a person. */
export function escalatePoppyRequests(
	db: PoppyStoreDb,
	conversation: string,
): void {
	db.update(poppyRequests)
		.set({ pending: 2 })
		.where(
			and(
				eq(poppyRequests.conversation, conversation),
				gt(poppyRequests.pending, 0),
			),
		)
		.run();
}

export function hasPendingPoppyRequest(
	db: PoppyStoreDb,
	conversation: string,
): boolean {
	return (
		db
			.select({ id: poppyRequests.id })
			.from(poppyRequests)
			.where(
				and(
					eq(poppyRequests.conversation, conversation),
					gt(poppyRequests.pending, 0),
				),
			)
			.limit(1)
			.get() !== undefined
	);
}

/** Conversations with a request waiting for the agent. */
export function listPendingPoppyConversations(db: PoppyStoreDb): string[] {
	return db
		.selectDistinct({ conversation: poppyRequests.conversation })
		.from(poppyRequests)
		.where(eq(poppyRequests.pending, 1))
		.all()
		.map((row) => row.conversation);
}

/** The oldest request waiting for the agent, optionally in one conversation. */
export function nextPoppyRequest(
	db: PoppyStoreDb,
	conversation?: string,
): PoppyRequestRow | undefined {
	return db
		.select()
		.from(poppyRequests)
		.where(
			and(
				eq(poppyRequests.pending, 1),
				conversation === undefined
					? undefined
					: eq(poppyRequests.conversation, conversation),
			),
		)
		.orderBy(asc(poppyRequests.sequence))
		.limit(1)
		.get();
}

export function findPoppyEventSequence(
	db: PoppyStoreDb,
	p: { conversation: string; id: string },
): number | undefined {
	return db
		.select({ sequence: poppyEvents.sequence })
		.from(poppyEvents)
		.where(
			and(
				eq(poppyEvents.conversation, p.conversation),
				eq(poppyEvents.id, p.id),
			),
		)
		.get()?.sequence;
}

/** Events after a sequence, oldest first. */
export function listPoppyEventsAfter(
	db: PoppyStoreDb,
	p: { conversation: string; afterSequence: number; limit: number },
): string[] {
	return db
		.select({ value: poppyEvents.value })
		.from(poppyEvents)
		.where(
			and(
				eq(poppyEvents.conversation, p.conversation),
				gt(poppyEvents.sequence, p.afterSequence),
			),
		)
		.orderBy(asc(poppyEvents.sequence))
		.limit(p.limit)
		.all()
		.map((row) => row.value);
}

/**
 * The latest events of a conversation, oldest first: all of them, those up to
 * `throughSequence` plus every company message after it, or only messages.
 */
export function listRecentPoppyEvents(
	db: PoppyStoreDb,
	p: {
		conversation: string;
		limit: number;
		throughSequence?: number;
		messagesOnly?: boolean;
	},
): string[] {
	return db
		.select({ value: poppyEvents.value })
		.from(poppyEvents)
		.where(
			and(
				eq(poppyEvents.conversation, p.conversation),
				p.throughSequence === undefined
					? undefined
					: or(
							lte(poppyEvents.sequence, p.throughSequence),
							eq(
								sql`json_extract(${poppyEvents.value}, '$.message.role')`,
								"company",
							),
						),
				p.messagesOnly
					? eq(sql`json_extract(${poppyEvents.value}, '$.type')`, "message")
					: undefined,
			),
		)
		.orderBy(desc(poppyEvents.sequence))
		.limit(p.limit)
		.all()
		.map((row) => row.value)
		.reverse();
}
