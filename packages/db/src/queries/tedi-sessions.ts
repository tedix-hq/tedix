import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import { tediSessionStates } from "../schema/tedi-sessions";

export type TediSessionState = typeof tediSessionStates.$inferSelect;

export async function getTediSessionState(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		userId: string;
		sessionKey: string;
	},
): Promise<TediSessionState | null> {
	const [row] = await db
		.select()
		.from(tediSessionStates)
		.where(
			and(
				eq(tediSessionStates.organizationId, input.organizationId),
				eq(tediSessionStates.tediId, input.tediId),
				eq(tediSessionStates.userId, input.userId),
				eq(tediSessionStates.sessionKey, input.sessionKey),
			),
		)
		.limit(1);
	return row ?? null;
}

function derivedTitle(value: string | undefined): string | null {
	const title = value?.trim();
	return title &&
		!/^(conversation|chat|session|thread|new|new chat|untitled|untitled chat)$/i.test(
			title,
		)
		? title
		: null;
}

export async function upsertTediSessionState(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		userId: string;
		sessionKey: string;
		title?: string | null;
		derivedTitle?: string;
		pinned?: boolean;
		deleted?: boolean;
		lastSeenAt?: number | null;
	},
): Promise<TediSessionState | null> {
	const now = new Date().toISOString();
	const hasTitle = input.title !== undefined;
	const normalizedDerivedTitle = derivedTitle(input.derivedTitle);
	const hasDerivedTitle = !hasTitle && normalizedDerivedTitle !== null;
	const hasPinned = input.pinned !== undefined;
	const hasDeleted = input.deleted !== undefined;
	const hasLastSeenAt = input.lastSeenAt !== undefined;
	const updateValues: {
		deletedAt?: string | null;
		lastSeenAt?: number | null;
		pinnedAt?: string | null;
		title?: SQL | string | null;
		updatedAt: string;
	} = { updatedAt: now };
	if (hasTitle) updateValues.title = input.title ?? null;
	else if (hasDerivedTitle) {
		updateValues.title = sql`
			case
				when ${tediSessionStates.title} is null
					or trim(${tediSessionStates.title}) = ''
					or lower(trim(${tediSessionStates.title})) in ('conversation', 'chat', 'session', 'thread', 'new', 'new chat', 'untitled', 'untitled chat')
				then ${normalizedDerivedTitle}
				else ${tediSessionStates.title}
			end
		`;
	}
	if (hasPinned) updateValues.pinnedAt = input.pinned ? now : null;
	if (hasDeleted) updateValues.deletedAt = input.deleted ? now : null;
	if (hasLastSeenAt) updateValues.lastSeenAt = input.lastSeenAt ?? null;

	const rows = await db
		.insert(tediSessionStates)
		.values({
			id: crypto.randomUUID(),
			organizationId: input.organizationId,
			tediId: input.tediId,
			userId: input.userId,
			sessionKey: input.sessionKey,
			title: hasTitle ? input.title : normalizedDerivedTitle,
			pinnedAt: input.pinned ? now : null,
			deletedAt: input.deleted ? now : null,
			lastSeenAt: hasLastSeenAt ? input.lastSeenAt : null,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [
				tediSessionStates.organizationId,
				tediSessionStates.tediId,
				tediSessionStates.userId,
				tediSessionStates.sessionKey,
			],
			set: updateValues,
		})
		.returning();
	return rows[0] ?? getTediSessionState(db, input);
}

export async function listTediSessionStates(
	db: DbClient,
	input: { organizationId: string; tediId: string; userId: string },
): Promise<TediSessionState[]> {
	return db
		.select()
		.from(tediSessionStates)
		.where(
			and(
				eq(tediSessionStates.organizationId, input.organizationId),
				eq(tediSessionStates.tediId, input.tediId),
				eq(tediSessionStates.userId, input.userId),
			),
		)
		.orderBy(
			desc(tediSessionStates.pinnedAt),
			desc(tediSessionStates.updatedAt),
		);
}

export async function listTediConversationActivity(
	db: DbClient,
	input: { organizationId: string; tediId: string },
): Promise<Array<{ id: string; lastActivityIso: string | null }>> {
	const rows = await db
		.select({
			conversationId: tediRuntimeEvents.conversationId,
			lastAt: sql<string>`max(${tediRuntimeEvents.createdAt})`,
		})
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.tediId, input.tediId),
				eq(tediRuntimeEvents.organizationId, input.organizationId),
			),
		)
		.groupBy(tediRuntimeEvents.conversationId);
	return rows
		.filter(
			(row): row is { conversationId: string; lastAt: string } =>
				typeof row.conversationId === "string" && row.conversationId.length > 0,
		)
		.map((row) => ({ id: row.conversationId, lastActivityIso: row.lastAt }));
}

export async function bulkSoftDeleteTediSessionStates(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		userId: string;
		sessionKeys: string[];
	},
): Promise<number> {
	const now = new Date().toISOString();
	let deleted = 0;
	for (let index = 0; index < input.sessionKeys.length; index += 10) {
		const chunk = input.sessionKeys.slice(index, index + 10);
		await db
			.insert(tediSessionStates)
			.values(
				chunk.map((sessionKey) => ({
					id: crypto.randomUUID(),
					organizationId: input.organizationId,
					tediId: input.tediId,
					userId: input.userId,
					sessionKey,
					deletedAt: now,
					createdAt: now,
					updatedAt: now,
				})),
			)
			.onConflictDoUpdate({
				target: [
					tediSessionStates.organizationId,
					tediSessionStates.tediId,
					tediSessionStates.userId,
					tediSessionStates.sessionKey,
				],
				set: { deletedAt: now, pinnedAt: null, updatedAt: now },
			});
		deleted += chunk.length;
	}
	return deleted;
}
