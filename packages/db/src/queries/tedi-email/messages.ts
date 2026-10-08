/**
 * Tedi Email Query Helpers
 */

import { and, eq, gte, notInArray, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type TediEmailAttachment,
	tediEmailAttachments,
	tediEmailMessages,
} from "../../schema/tedi-email";
import { prefixedColumns } from "../../utils/select";
import type { NormalizedTediEmailMessage } from "./recipients";
import { normalizeStoredMessage } from "./storage-normalization";

export async function getTediEmailAttachmentsForMessage(
	db: DbClient,
	messageId: string,
): Promise<TediEmailAttachment[]> {
	return db
		.select()
		.from(tediEmailAttachments)
		.where(eq(tediEmailAttachments.messageId, messageId))
		.orderBy(tediEmailAttachments.createdAt);
}

export async function getTediEmailAttachment(
	db: DbClient,
	input: { attachmentId: string; tediId: string; organizationId: string },
): Promise<{
	attachment: TediEmailAttachment;
	message: NormalizedTediEmailMessage;
} | null> {
	// Attachments and messages both have `id` and `created_at`. Unaliased, D1
	// collapses each pair into one output column, so the message fields shift left
	// and the attachment's id/timestamp are returned as the message's — with the
	// json recipient columns falling off the end as `"undefined" is not valid JSON`.
	const rows = await db
		.select({
			attachment: prefixedColumns(tediEmailAttachments, "attachment"),
			message: prefixedColumns(tediEmailMessages, "message"),
		})
		.from(tediEmailAttachments)
		.innerJoin(
			tediEmailMessages,
			eq(tediEmailAttachments.messageId, tediEmailMessages.id),
		)
		.where(
			and(
				eq(tediEmailAttachments.id, input.attachmentId),
				eq(tediEmailMessages.tediId, input.tediId),
				eq(tediEmailMessages.organizationId, input.organizationId),
			),
		)
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	return {
		attachment: row.attachment,
		message: normalizeStoredMessage(row.message),
	};
}

export async function getTediEmailMessage(
	db: DbClient,
	input: { messageId: string; tediId: string; organizationId: string },
): Promise<NormalizedTediEmailMessage | null> {
	const rows = await db
		.select()
		.from(tediEmailMessages)
		.where(
			and(
				eq(tediEmailMessages.id, input.messageId),
				eq(tediEmailMessages.tediId, input.tediId),
				eq(tediEmailMessages.organizationId, input.organizationId),
			),
		)
		.limit(1);
	return rows[0] ? normalizeStoredMessage(rows[0]) : null;
}

/** Metadata-only identity for a service-bound dispatch observation. */
export async function getInboundTediEmailMessageIdentity(
	db: DbClient,
	messageId: string,
): Promise<{
	id: string;
	threadId: string;
	tediId: string;
	organizationId: string;
} | null> {
	const rows = await db
		.select({
			id: tediEmailMessages.id,
			threadId: tediEmailMessages.threadId,
			tediId: tediEmailMessages.tediId,
			organizationId: tediEmailMessages.organizationId,
		})
		.from(tediEmailMessages)
		.where(
			and(
				eq(tediEmailMessages.id, messageId),
				eq(tediEmailMessages.direction, "inbound"),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

/** Exact RFC Message-ID match; duplicate mailbox rows are ambiguous. */
export async function findUniqueInboundTediEmailMessageIdentityByHeader(
	db: DbClient,
	input: { tediId: string; messageIdHeader: string },
): Promise<
	| { status: "missing" | "ambiguous" }
	| {
			status: "found";
			message: {
				id: string;
				threadId: string;
				tediId: string;
				organizationId: string;
			};
	  }
> {
	const rows = await db
		.select({
			id: tediEmailMessages.id,
			threadId: tediEmailMessages.threadId,
			tediId: tediEmailMessages.tediId,
			organizationId: tediEmailMessages.organizationId,
		})
		.from(tediEmailMessages)
		.where(
			and(
				eq(tediEmailMessages.tediId, input.tediId),
				eq(tediEmailMessages.messageIdHeader, input.messageIdHeader),
				eq(tediEmailMessages.direction, "inbound"),
			),
		)
		.limit(2);
	if (rows.length === 0) return { status: "missing" };
	if (rows.length > 1) return { status: "ambiguous" };
	return { status: "found", message: rows[0]! };
}

/**
 * Inbound messages received by one tedi since `sinceIso`, excluding senders in
 * `excludeFromAddrs`. Callers pass the recipient's known trusted correspondents
 * so the result approximates untrusted inbound volume for rate limiting.
 */
export async function countRecentInboundTediEmailMessages(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		sinceIso: string;
		excludeFromAddrs?: string[];
	},
): Promise<number> {
	const exclude = [...new Set(input.excludeFromAddrs ?? [])].slice(0, 50);
	const rows = await db
		.select({ total: sql<number>`count(*)` })
		.from(tediEmailMessages)
		.where(
			and(
				eq(tediEmailMessages.tediId, input.tediId),
				eq(tediEmailMessages.organizationId, input.organizationId),
				eq(tediEmailMessages.direction, "inbound"),
				gte(tediEmailMessages.receivedAt, input.sinceIso),
				...(exclude.length
					? [notInArray(tediEmailMessages.fromAddr, exclude)]
					: []),
			),
		);
	return Number(rows[0]?.total ?? 0);
}
