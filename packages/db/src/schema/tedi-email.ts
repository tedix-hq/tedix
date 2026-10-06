/**
 * Tedi Email Schema
 *
 * Durable, multi-tenant mailbox tables for first-party tedi email. Cloudflare
 * Email Routing receives the bytes, but Tedix owns routing, persistence,
 * search, read state, and outbound audit state here.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

export const TEDI_EMAIL_ADDRESS_KIND_VALUES = [
	"primary",
	"alias",
	"plus",
	"custom_domain",
] as const;
export type TediEmailAddressKind =
	(typeof TEDI_EMAIL_ADDRESS_KIND_VALUES)[number];

export const TEDI_EMAIL_ADDRESS_STATUS_VALUES = [
	"active",
	"paused",
	"reserved",
] as const;
export type TediEmailAddressStatus =
	(typeof TEDI_EMAIL_ADDRESS_STATUS_VALUES)[number];

export const TEDI_EMAIL_THREAD_STATUS_VALUES = [
	"open",
	"archived",
	"spam",
] as const;
export type TediEmailThreadStatus =
	(typeof TEDI_EMAIL_THREAD_STATUS_VALUES)[number];

export const TEDI_EMAIL_DIRECTION_VALUES = ["inbound", "outbound"] as const;
export type TediEmailDirection = (typeof TEDI_EMAIL_DIRECTION_VALUES)[number];

export const TEDI_EMAIL_MESSAGE_STATUS_VALUES = [
	"received",
	"sent",
	"failed",
] as const;
export type TediEmailMessageStatus =
	(typeof TEDI_EMAIL_MESSAGE_STATUS_VALUES)[number];

export interface TediEmailRecipient {
	email: string;
	name?: string;
}

export const tediEmailAddresses = sqliteTable(
	"tedi_email_addresses",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		address: text("address").notNull(),
		localPart: text("local_part").notNull(),
		domain: text("domain").notNull(),
		kind: text("kind", {
			enum: [...TEDI_EMAIL_ADDRESS_KIND_VALUES],
		})
			.notNull()
			.default("primary"),
		status: text("status", {
			enum: [...TEDI_EMAIL_ADDRESS_STATUS_VALUES],
		})
			.notNull()
			.default("active"),
		routingPolicy: text("routing_policy", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdBy: text("created_by"),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_tedi_email_address").on(table.address),
		index("idx_tedi_email_addresses_tedi").on(table.tediId, table.status),
		index("idx_tedi_email_addresses_org").on(
			table.organizationId,
			table.status,
		),
	],
);

export const tediEmailThreads = sqliteTable(
	"tedi_email_threads",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		subjectNorm: text("subject_norm").notNull(),
		participants: text("participants_json", { mode: "json" }).$type<
			TediEmailRecipient[]
		>(),
		lastMessageAt: text("last_message_at").notNull(),
		status: text("status", {
			enum: [...TEDI_EMAIL_THREAD_STATUS_VALUES],
		})
			.notNull()
			.default("open"),
		labels: text("labels_json", { mode: "json" }).$type<string[]>(),
		unreadCount: integer("unread_count").notNull().default(0),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_tedi_email_threads_tedi_last").on(
			table.tediId,
			table.lastMessageAt,
		),
		index("idx_tedi_email_threads_org").on(table.organizationId),
		index("idx_tedi_email_threads_status").on(table.tediId, table.status),
		index("idx_tedi_email_threads_subject").on(table.tediId, table.subjectNorm),
	],
);

export const tediEmailMessages = sqliteTable(
	"tedi_email_messages",
	{
		id: text("id").primaryKey(),
		threadId: text("thread_id")
			.notNull()
			.references(() => tediEmailThreads.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		direction: text("direction", {
			enum: [...TEDI_EMAIL_DIRECTION_VALUES],
		}).notNull(),
		fromAddr: text("from_addr").notNull(),
		from: text("from_json", { mode: "json" }).$type<TediEmailRecipient>(),
		to: text("to_json", { mode: "json" })
			.$type<TediEmailRecipient[]>()
			.notNull(),
		cc: text("cc_json", { mode: "json" }).$type<TediEmailRecipient[]>(),
		bcc: text("bcc_json", { mode: "json" }).$type<TediEmailRecipient[]>(),
		replyTo: text("reply_to_json", {
			mode: "json",
		}).$type<TediEmailRecipient>(),
		subject: text("subject").notNull(),
		bodyPreview: text("body_preview"),
		textBody: text("text_body"),
		htmlR2Key: text("html_r2_key"),
		rawR2Key: text("raw_r2_key"),
		messageIdHeader: text("message_id_header"),
		inReplyTo: text("in_reply_to"),
		references: text("references_json", { mode: "json" }).$type<string[]>(),
		providerMessageId: text("provider_message_id"),
		receivedAt: text("received_at"),
		sentAt: text("sent_at"),
		readAt: text("read_at"),
		archivedAt: text("archived_at"),
		spamScore: real("spam_score"),
		status: text("status", {
			enum: [...TEDI_EMAIL_MESSAGE_STATUS_VALUES],
		}).notNull(),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_tedi_email_messages_thread").on(table.threadId, table.createdAt),
		index("idx_tedi_email_messages_tedi_created").on(
			table.tediId,
			table.createdAt,
		),
		index("idx_tedi_email_messages_message_id").on(
			table.tediId,
			table.messageIdHeader,
		),
		index("idx_tedi_email_messages_unread").on(
			table.tediId,
			table.readAt,
			table.direction,
		),
	],
);

export const tediEmailAttachments = sqliteTable(
	"tedi_email_attachments",
	{
		id: text("id").primaryKey(),
		messageId: text("message_id")
			.notNull()
			.references(() => tediEmailMessages.id, { onDelete: "cascade" }),
		filename: text("filename"),
		contentType: text("content_type"),
		size: integer("size"),
		r2Key: text("r2_key"),
		contentId: text("content_id"),
		disposition: text("disposition"),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [index("idx_tedi_email_attachments_message").on(table.messageId)],
);

export const tediEmailEvents = sqliteTable(
	"tedi_email_events",
	{
		id: text("id").primaryKey(),
		messageId: text("message_id").references(() => tediEmailMessages.id, {
			onDelete: "set null",
		}),
		threadId: text("thread_id").references(() => tediEmailThreads.id, {
			onDelete: "set null",
		}),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		eventType: text("event_type").notNull(),
		provider: text("provider"),
		payload: text("payload_json", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_tedi_email_events_message").on(table.messageId),
		index("idx_tedi_email_events_thread").on(table.threadId),
		index("idx_tedi_email_events_tedi_created").on(
			table.tediId,
			table.createdAt,
		),
	],
);

export type TediEmailAddress = typeof tediEmailAddresses.$inferSelect;
export type NewTediEmailAddress = typeof tediEmailAddresses.$inferInsert;
export type TediEmailThread = typeof tediEmailThreads.$inferSelect;
export type NewTediEmailThread = typeof tediEmailThreads.$inferInsert;
export type TediEmailMessage = typeof tediEmailMessages.$inferSelect;
export type NewTediEmailMessage = typeof tediEmailMessages.$inferInsert;
export type TediEmailAttachment = typeof tediEmailAttachments.$inferSelect;
export type NewTediEmailAttachment = typeof tediEmailAttachments.$inferInsert;
export type TediEmailEvent = typeof tediEmailEvents.$inferSelect;
export type NewTediEmailEvent = typeof tediEmailEvents.$inferInsert;
