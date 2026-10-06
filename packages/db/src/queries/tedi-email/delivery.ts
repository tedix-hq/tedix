import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type TediEmailThread,
	tediEmailAttachments,
	tediEmailMessages,
	tediEmailThreads,
} from "../../schema/tedi-email";
import { toJsonRecord } from "../../utils/json";
import { recordTediEmailEvent } from "./events";
import {
	buildEmailPreview,
	type NormalizedTediEmailMessage,
	type NormalizedTediEmailThread,
	normalizeEmailRecipient,
	normalizeEmailRecipients,
	normalizeEmailSubject,
	type TediEmailRecipientInput,
} from "./recipients";
import {
	mergeParticipants,
	normalizeStoredMessage,
	normalizeStoredThread,
	unique,
	uniqueRecipients,
} from "./storage-normalization";
import { getTediEmailThread } from "./threads";

async function findThreadForInbound(
	db: DbClient,
	input: {
		tediId: string;
		subject: string;
		inReplyTo?: string | null;
		references?: string[] | null;
	},
): Promise<TediEmailThread | null> {
	const referenceIds = unique([
		input.inReplyTo ?? undefined,
		...(input.references ?? []),
	]).filter(Boolean);
	if (referenceIds.length > 0) {
		const rows = await db
			.select({ thread: tediEmailThreads })
			.from(tediEmailMessages)
			.innerJoin(
				tediEmailThreads,
				eq(tediEmailMessages.threadId, tediEmailThreads.id),
			)
			.where(
				and(
					eq(tediEmailMessages.tediId, input.tediId),
					// bound-params: In-Reply-To/References header ids of ONE inbound
					// email (header-size bounded)
					inArray(tediEmailMessages.messageIdHeader, referenceIds),
				),
			)
			.orderBy(desc(tediEmailMessages.createdAt))
			.limit(1);
		if (rows[0]?.thread) return rows[0].thread;
	}

	const subjectNorm = normalizeEmailSubject(input.subject);
	const rows = await db
		.select()
		.from(tediEmailThreads)
		.where(
			and(
				eq(tediEmailThreads.tediId, input.tediId),
				eq(tediEmailThreads.subjectNorm, subjectNorm),
				eq(tediEmailThreads.status, "open"),
			),
		)
		.orderBy(desc(tediEmailThreads.lastMessageAt))
		.limit(1);
	return rows[0] ?? null;
}

async function createThread(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		subject: string;
		participants: TediEmailRecipientInput[];
		lastMessageAt: string;
		unreadCount?: number;
	},
): Promise<NormalizedTediEmailThread> {
	const rows = await db
		.insert(tediEmailThreads)
		.values({
			id: crypto.randomUUID(),
			organizationId: input.organizationId,
			tediId: input.tediId,
			subjectNorm: normalizeEmailSubject(input.subject),
			participants: uniqueRecipients(input.participants),
			lastMessageAt: input.lastMessageAt,
			status: "open",
			labels: [],
			unreadCount: input.unreadCount ?? 0,
		})
		.returning();
	return normalizeStoredThread(rows[0]!);
}

export async function ingestInboundTediEmail(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		to: TediEmailRecipientInput;
		from: TediEmailRecipientInput;
		cc?: TediEmailRecipientInput[] | null;
		bcc?: TediEmailRecipientInput[] | null;
		replyTo?: TediEmailRecipientInput | null;
		subject: string;
		textBody: string;
		rawR2Key?: string | null;
		htmlR2Key?: string | null;
		rawSize?: number | null;
		spamScore?: number | null;
		attachments?: Array<{
			filename?: string | null;
			contentType?: string | null;
			size?: number | null;
			r2Key?: string | null;
			contentId?: string | null;
			disposition?: string | null;
		}>;
		messageIdHeader?: string | null;
		inReplyTo?: string | null;
		references?: string[] | null;
		receivedAt?: string;
	},
): Promise<{
	thread: NormalizedTediEmailThread;
	message: NormalizedTediEmailMessage;
}> {
	const receivedAt = input.receivedAt ?? new Date().toISOString();
	const from = normalizeEmailRecipient(input.from);
	const to = normalizeEmailRecipient(input.to);
	const cc = normalizeEmailRecipients(input.cc ?? []);
	const bcc = normalizeEmailRecipients(input.bcc ?? []);
	const replyTo = input.replyTo ? normalizeEmailRecipient(input.replyTo) : null;
	const participants = uniqueRecipients([from, to, ...cc]);
	let thread = await findThreadForInbound(db, input);
	if (!thread) {
		thread = await createThread(db, {
			tediId: input.tediId,
			organizationId: input.organizationId,
			subject: input.subject,
			participants,
			lastMessageAt: receivedAt,
			unreadCount: 1,
		});
	} else {
		await db
			.update(tediEmailThreads)
			.set({
				participants: mergeParticipants(thread.participants, participants),
				lastMessageAt: receivedAt,
				status: "open",
				unreadCount: sql`${tediEmailThreads.unreadCount} + 1`,
				updatedAt: sql`(CURRENT_TIMESTAMP)`,
			})
			.where(eq(tediEmailThreads.id, thread.id));
		thread = {
			...thread,
			participants: mergeParticipants(thread.participants, participants),
			lastMessageAt: receivedAt,
			status: "open",
			unreadCount: (thread.unreadCount ?? 0) + 1,
		};
	}

	const rows = await db
		.insert(tediEmailMessages)
		.values({
			id: crypto.randomUUID(),
			threadId: thread.id,
			organizationId: input.organizationId,
			tediId: input.tediId,
			direction: "inbound",
			fromAddr: from.email,
			from,
			to: [to],
			cc,
			bcc,
			replyTo,
			subject: input.subject || "(no subject)",
			bodyPreview: buildEmailPreview(input.textBody),
			textBody: input.textBody,
			htmlR2Key: input.htmlR2Key ?? null,
			rawR2Key: input.rawR2Key ?? null,
			messageIdHeader: input.messageIdHeader ?? null,
			inReplyTo: input.inReplyTo ?? null,
			references: input.references ?? [],
			spamScore: input.spamScore ?? null,
			receivedAt,
			status: "received",
		})
		.returning();
	const message = rows[0]!;

	for (const attachment of input.attachments ?? []) {
		await db.insert(tediEmailAttachments).values({
			id: crypto.randomUUID(),
			messageId: message.id,
			filename: attachment.filename ?? null,
			contentType: attachment.contentType ?? null,
			size: attachment.size ?? null,
			r2Key: attachment.r2Key ?? null,
			contentId: attachment.contentId ?? null,
			disposition: attachment.disposition ?? null,
		});
	}

	await recordTediEmailEvent(db, {
		tediId: input.tediId,
		organizationId: input.organizationId,
		threadId: thread.id,
		messageId: message.id,
		eventType: "inbound_received",
		provider: "cloudflare-email-routing",
		payload: toJsonRecord({
			from,
			to,
			cc,
			bcc,
			replyTo,
			subject: input.subject,
			messageIdHeader: input.messageIdHeader,
			rawSize: input.rawSize,
			spamScore: input.spamScore,
			attachmentCount: input.attachments?.length ?? 0,
			rawR2Key: input.rawR2Key,
			htmlR2Key: input.htmlR2Key,
		}),
	});

	return {
		thread: normalizeStoredThread(thread),
		message: normalizeStoredMessage(message),
	};
}

export async function createOutboundTediEmailMessage(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		threadId?: string | null;
		from: TediEmailRecipientInput;
		to: TediEmailRecipientInput[];
		cc?: TediEmailRecipientInput[] | null;
		bcc?: TediEmailRecipientInput[] | null;
		replyTo?: TediEmailRecipientInput | null;
		subject: string;
		textBody?: string | null;
		htmlR2Key?: string | null;
		rawR2Key?: string | null;
		providerMessageId?: string | null;
		messageIdHeader?: string | null;
		inReplyTo?: string | null;
		references?: string[] | null;
		status: "sent" | "failed";
		sentAt?: string;
	},
): Promise<{
	thread: NormalizedTediEmailThread;
	message: NormalizedTediEmailMessage;
}> {
	const sentAt = input.sentAt ?? new Date().toISOString();
	const from = normalizeEmailRecipient(input.from);
	const to = normalizeEmailRecipients(input.to);
	const cc = normalizeEmailRecipients(input.cc ?? []);
	const bcc = normalizeEmailRecipients(input.bcc ?? []);
	const replyTo = input.replyTo ? normalizeEmailRecipient(input.replyTo) : null;
	let thread: TediEmailThread | null = null;
	if (input.threadId) {
		const found = await getTediEmailThread(db, {
			threadId: input.threadId,
			tediId: input.tediId,
			organizationId: input.organizationId,
		});
		thread = found?.thread ?? null;
	}
	if (!thread) {
		thread = await createThread(db, {
			tediId: input.tediId,
			organizationId: input.organizationId,
			subject: input.subject,
			participants: uniqueRecipients([from, ...to, ...cc]),
			lastMessageAt: sentAt,
			unreadCount: 0,
		});
	} else {
		const participants = mergeParticipants(thread.participants, [
			from,
			...to,
			...cc,
		]);
		await db
			.update(tediEmailThreads)
			.set({
				participants,
				lastMessageAt: sentAt,
				updatedAt: sql`(CURRENT_TIMESTAMP)`,
			})
			.where(eq(tediEmailThreads.id, thread.id));
		thread = { ...thread, participants, lastMessageAt: sentAt };
	}

	const rows = await db
		.insert(tediEmailMessages)
		.values({
			id: crypto.randomUUID(),
			threadId: thread.id,
			organizationId: input.organizationId,
			tediId: input.tediId,
			direction: "outbound",
			fromAddr: from.email,
			from,
			to,
			cc,
			bcc,
			replyTo,
			subject: input.subject,
			bodyPreview: buildEmailPreview(input.textBody),
			textBody: input.textBody ?? null,
			htmlR2Key: input.htmlR2Key ?? null,
			rawR2Key: input.rawR2Key ?? null,
			messageIdHeader: input.messageIdHeader ?? null,
			inReplyTo: input.inReplyTo ?? null,
			references: input.references ?? [],
			providerMessageId: input.providerMessageId ?? null,
			sentAt,
			readAt: sentAt,
			status: input.status,
		})
		.returning();
	const message = rows[0]!;

	await recordTediEmailEvent(db, {
		tediId: input.tediId,
		organizationId: input.organizationId,
		threadId: thread.id,
		messageId: message.id,
		eventType: input.status === "sent" ? "outbound_sent" : "outbound_failed",
		provider: "cloudflare",
		payload: toJsonRecord({
			from,
			to,
			cc,
			bcc,
			replyTo,
			subject: input.subject,
			providerMessageId: input.providerMessageId,
		}),
	});

	return {
		thread: normalizeStoredThread(thread),
		message: normalizeStoredMessage(message),
	};
}
