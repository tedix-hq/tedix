/**
 * Tedi Email Query Helpers
 */

import type { SQL } from "drizzle-orm";
import { and, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { tediEmailMessages, tediEmailThreads } from "../../schema/tedi-email";
import { toJsonRecord } from "../../utils/json";
import { prefixedColumns } from "../../utils/select";
import { recordTediEmailEvent } from "./events";
import {
	getTediEmailAttachmentsForMessage,
	getTediEmailMessage,
} from "./messages";
import {
	type NormalizedTediEmailMessage,
	type NormalizedTediEmailThread,
	normalizeEmailSubject,
	type TediEmailMessageWithAttachments,
} from "./recipients";
import {
	clampLimit,
	normalizeStoredMessage,
	normalizeStoredThread,
} from "./storage-normalization";

async function recalcUnreadCount(
	db: DbClient,
	threadId: string,
): Promise<number> {
	const rows = await db
		.select({ count: sql<number>`count(*)` })
		.from(tediEmailMessages)
		.where(
			and(
				eq(tediEmailMessages.threadId, threadId),
				eq(tediEmailMessages.direction, "inbound"),
				isNull(tediEmailMessages.readAt),
			),
		);
	const unreadCount = Number(rows[0]?.count ?? 0);
	await db
		.update(tediEmailThreads)
		.set({
			unreadCount,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(eq(tediEmailThreads.id, threadId));
	return unreadCount;
}

export async function listTediEmailThreads(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		status?: "open" | "archived" | "spam" | "all";
		unread?: boolean;
		query?: string;
		cursor?: string;
		limit?: number;
	},
): Promise<{
	threads: Array<
		NormalizedTediEmailThread & {
			latestMessage: TediEmailMessageWithAttachments | null;
		}
	>;
	nextCursor: string | null;
}> {
	const limit = clampLimit(input.limit);
	const conditions: SQL[] = [
		eq(tediEmailThreads.tediId, input.tediId),
		eq(tediEmailThreads.organizationId, input.organizationId),
	];
	if (input.status && input.status !== "all") {
		conditions.push(eq(tediEmailThreads.status, input.status));
	}
	if (input.unread) {
		conditions.push(sql`${tediEmailThreads.unreadCount} > 0`);
	}
	if (input.cursor) {
		conditions.push(sql`${tediEmailThreads.lastMessageAt} < ${input.cursor}`);
	}
	if (input.query?.trim()) {
		conditions.push(
			like(
				tediEmailThreads.subjectNorm,
				`%${normalizeEmailSubject(input.query)}%`,
			),
		);
	}

	const rows = await db
		.select()
		.from(tediEmailThreads)
		.where(and(...conditions))
		.orderBy(desc(tediEmailThreads.lastMessageAt))
		.limit(limit + 1);

	const page = rows.slice(0, limit);
	const threads = await Promise.all(
		page.map(async (thread) => ({
			...normalizeStoredThread(thread),
			latestMessage: await getLatestMessageForThread(db, thread.id),
		})),
	);

	return {
		threads,
		nextCursor:
			rows.length > limit ? (page.at(-1)?.lastMessageAt ?? null) : null,
	};
}

async function getLatestMessageForThread(
	db: DbClient,
	threadId: string,
): Promise<TediEmailMessageWithAttachments | null> {
	const rows = await db
		.select()
		.from(tediEmailMessages)
		.where(eq(tediEmailMessages.threadId, threadId))
		.orderBy(desc(tediEmailMessages.createdAt))
		.limit(1);
	const message = rows[0];
	if (!message) return null;
	return {
		...normalizeStoredMessage(message),
		attachments: await getTediEmailAttachmentsForMessage(db, message.id),
	};
}

export async function getTediEmailThread(
	db: DbClient,
	input: { threadId: string; tediId: string; organizationId: string },
): Promise<{
	thread: NormalizedTediEmailThread;
	messages: TediEmailMessageWithAttachments[];
} | null> {
	const thread = await db.query.tediEmailThreads.findFirst({
		where: {
			id: input.threadId,
			tediId: input.tediId,
			organizationId: input.organizationId,
		},
	});
	if (!thread) return null;
	const messages = await db
		.select()
		.from(tediEmailMessages)
		.where(eq(tediEmailMessages.threadId, input.threadId))
		.orderBy(tediEmailMessages.createdAt);
	return {
		thread: normalizeStoredThread(thread),
		messages: await Promise.all(
			messages.map(async (message) => ({
				...normalizeStoredMessage(message),
				attachments: await getTediEmailAttachmentsForMessage(db, message.id),
			})),
		),
	};
}

export async function searchTediEmail(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		query: string;
		limit?: number;
	},
): Promise<
	Array<{
		message: NormalizedTediEmailMessage;
		thread: NormalizedTediEmailThread;
	}>
> {
	const limit = clampLimit(input.limit);
	const q = `%${input.query.trim().toLowerCase()}%`;
	// `prefixedColumns`, not the bare tables: selecting both under distinct TS
	// keys still emits their raw column names, so `id`, `organization_id`,
	// `tedi_id`, `status`, `created_at` and `updated_at` appeared twice and D1
	// collapsed them — search hits came back with the thread's id and status on
	// the message, and the thread's `participants_json` shifted off the end and
	// threw `"undefined" is not valid JSON`.
	const rows = await db
		.select({
			message: prefixedColumns(tediEmailMessages, "message"),
			thread: prefixedColumns(tediEmailThreads, "thread"),
		})
		.from(tediEmailMessages)
		.innerJoin(
			tediEmailThreads,
			eq(tediEmailMessages.threadId, tediEmailThreads.id),
		)
		.where(
			and(
				eq(tediEmailMessages.tediId, input.tediId),
				eq(tediEmailMessages.organizationId, input.organizationId),
				or(
					like(sql`lower(${tediEmailMessages.fromAddr})`, q),
					like(sql`lower(${tediEmailMessages.from})`, q),
					like(sql`lower(${tediEmailMessages.to})`, q),
					like(sql`lower(${tediEmailMessages.cc})`, q),
					like(sql`lower(${tediEmailMessages.bcc})`, q),
					like(sql`lower(${tediEmailMessages.subject})`, q),
					like(sql`lower(${tediEmailMessages.bodyPreview})`, q),
					like(sql`lower(${tediEmailMessages.textBody})`, q),
				)!,
			),
		)
		.orderBy(desc(tediEmailMessages.createdAt))
		.limit(limit);
	return rows.map(({ message, thread }) => ({
		message: normalizeStoredMessage(message),
		thread: normalizeStoredThread(thread),
	}));
}

export async function markTediEmail(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		threadId?: string;
		messageId?: string;
		read?: boolean;
		archived?: boolean;
		spam?: boolean;
	},
): Promise<{ ok: true; threadId: string; unreadCount: number }> {
	const targetThreadId =
		input.threadId ??
		(
			await getTediEmailMessage(db, {
				messageId: input.messageId!,
				tediId: input.tediId,
				organizationId: input.organizationId,
			})
		)?.threadId;
	if (!targetThreadId) {
		throw new Error("Email message or thread not found");
	}

	const messagePatch = {
		...(input.read === true ? { readAt: new Date().toISOString() } : {}),
		...(input.read === false ? { readAt: null } : {}),
		...(input.archived === true
			? { archivedAt: new Date().toISOString() }
			: {}),
		...(input.archived === false ? { archivedAt: null } : {}),
		updatedAt: sql`(CURRENT_TIMESTAMP)`,
	};

	if (input.messageId) {
		await db
			.update(tediEmailMessages)
			.set(messagePatch)
			.where(
				and(
					eq(tediEmailMessages.id, input.messageId),
					eq(tediEmailMessages.tediId, input.tediId),
					eq(tediEmailMessages.organizationId, input.organizationId),
				),
			);
	} else if (input.threadId) {
		await db
			.update(tediEmailMessages)
			.set(messagePatch)
			.where(
				and(
					eq(tediEmailMessages.threadId, input.threadId),
					eq(tediEmailMessages.tediId, input.tediId),
					eq(tediEmailMessages.organizationId, input.organizationId),
				),
			);
	}

	const threadPatch = {
		...(input.spam === true ? { status: "spam" as const } : {}),
		...(input.archived === true ? { status: "archived" as const } : {}),
		...(input.archived === false || input.spam === false
			? { status: "open" as const }
			: {}),
		updatedAt: sql`(CURRENT_TIMESTAMP)`,
	};
	if (Object.keys(threadPatch).length > 1) {
		await db
			.update(tediEmailThreads)
			.set(threadPatch)
			.where(
				and(
					eq(tediEmailThreads.id, targetThreadId),
					eq(tediEmailThreads.tediId, input.tediId),
					eq(tediEmailThreads.organizationId, input.organizationId),
				),
			);
	}

	const unreadCount = await recalcUnreadCount(db, targetThreadId);
	await recordTediEmailEvent(db, {
		tediId: input.tediId,
		organizationId: input.organizationId,
		threadId: targetThreadId,
		messageId: input.messageId,
		eventType: "marked",
		provider: "tedix",
		payload: toJsonRecord({
			read: input.read,
			archived: input.archived,
			spam: input.spam,
		}),
	});

	return { ok: true, threadId: targetThreadId, unreadCount };
}
