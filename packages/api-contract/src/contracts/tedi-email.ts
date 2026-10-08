import "@orpc/openapi/extensions/route";
/**
 * Tedi Email Contract
 * Internal endpoints for inbound email routing and outbound email sending.
 *
 * Tagged "internal" -- excluded from public OpenAPI spec.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { JsonValueSchema } from "../schemas/common";
import {
	EmailAuthResultsSchema,
	EmailIngressDecisionSchema,
	EmailSenderTrustSchema,
} from "../schemas/tedi-email";

const EmailThreadStatusSchema = z.enum(["open", "archived", "spam", "all"]);
const EmailAddressKindSchema = z.enum([
	"primary",
	"alias",
	"plus",
	"custom_domain",
]);
const EmailAddressStatusSchema = z.enum(["active", "paused", "reserved"]);
const EmailRecipientSchema = z.object({
	email: z.string().email(),
	name: z.string().min(1).max(200).optional(),
});

const EmailAddressSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	tediId: z.string(),
	address: z.string(),
	localPart: z.string(),
	domain: z.string(),
	kind: EmailAddressKindSchema,
	status: EmailAddressStatusSchema,
	routingPolicy: z.record(z.string(), JsonValueSchema).nullable().optional(),
	createdBy: z.string().nullable().optional(),
	createdAt: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
});

const EmailAttachmentSchema = z.object({
	id: z.string(),
	messageId: z.string(),
	filename: z.string().nullable().optional(),
	contentType: z.string().nullable().optional(),
	size: z.number().nullable().optional(),
	r2Key: z.string().nullable().optional(),
	contentId: z.string().nullable().optional(),
	disposition: z.string().nullable().optional(),
	createdAt: z.string().nullable().optional(),
});

const EmailMessageSchema = z.object({
	id: z.string(),
	threadId: z.string(),
	tediId: z.string(),
	organizationId: z.string(),
	direction: z.enum(["inbound", "outbound"]),
	fromAddr: z.string(),
	from: EmailRecipientSchema,
	to: z.array(EmailRecipientSchema),
	cc: z.array(EmailRecipientSchema).nullable().optional(),
	bcc: z.array(EmailRecipientSchema).nullable().optional(),
	replyTo: EmailRecipientSchema.nullable().optional(),
	subject: z.string(),
	bodyPreview: z.string().nullable().optional(),
	textBody: z.string().nullable().optional(),
	htmlR2Key: z.string().nullable().optional(),
	rawR2Key: z.string().nullable().optional(),
	messageIdHeader: z.string().nullable().optional(),
	inReplyTo: z.string().nullable().optional(),
	references: z.array(z.string()).nullable().optional(),
	providerMessageId: z.string().nullable().optional(),
	receivedAt: z.string().nullable().optional(),
	sentAt: z.string().nullable().optional(),
	readAt: z.string().nullable().optional(),
	archivedAt: z.string().nullable().optional(),
	status: z.enum(["received", "sent", "failed"]),
	attachments: z.array(EmailAttachmentSchema).optional(),
	createdAt: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
});

const EmailThreadSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	organizationId: z.string(),
	subjectNorm: z.string(),
	participants: z.array(EmailRecipientSchema).nullable().optional(),
	lastMessageAt: z.string(),
	status: z.enum(["open", "archived", "spam"]),
	labels: z.array(z.string()).nullable().optional(),
	unreadCount: z.number(),
	createdAt: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
});

const EmailThreadSummarySchema = EmailThreadSchema.extend({
	latestMessage: EmailMessageSchema.nullable(),
});

export const tediEmailContract = oc
	.route({ tags: ["internal", "tedi-email"], prefix: "/tediEmail" })
	.router({
		/**
		 * POST /tediEmail/inbound-email -- Persist inbound email in a tedi mailbox
		 * Called by tedi-runtime via the API_SERVICE binding.
		 */
		inboundEmail: oc
			.route({
				method: "POST",
				path: "/inbound-email",
				summary: "Persist inbound email in a tedi mailbox",
				description:
					"Persists parsed email in the resolved tedi mailbox. Tedi runtime separately forwards eligible messages to the Agent.",
			})
			.input(
				z.object({
					slug: z.string().optional(),
					from: EmailRecipientSchema,
					subject: z.string(),
					body: z.string(),
					to: EmailRecipientSchema,
					cc: z.array(EmailRecipientSchema).max(50).optional(),
					bcc: z.array(EmailRecipientSchema).max(50).optional(),
					replyTo: EmailRecipientSchema.optional(),
					rawR2Key: z.string().optional(),
					htmlR2Key: z.string().optional(),
					rawSize: z.number().int().nonnegative().optional(),
					spamScore: z.number().optional(),
					authResults: EmailAuthResultsSchema.optional(),
					attachments: z
						.array(
							z.object({
								filename: z.string().optional(),
								contentType: z.string().optional(),
								size: z.number().int().nonnegative().optional(),
								r2Key: z.string().optional(),
								contentId: z.string().optional(),
								disposition: z.string().optional(),
							}),
						)
						.optional(),
					messageId: z.string().optional(),
					inReplyTo: z.string().optional(),
					references: z.array(z.string()).optional(),
				}),
			)
			.output(
				z.object({
					delivered: z
						.boolean()
						.describe(
							"True when the message is durably persisted in the mailbox; does not acknowledge runtime wake or model execution.",
						),
					threadId: z.string().optional(),
					messageId: z.string().optional(),
					senderTrust: EmailSenderTrustSchema.optional().describe(
						"Sender verdict for a persisted message: trusted only for an allowlisted, member or same-organization tedi address that passed DKIM or DMARC for its domain.",
					),
					ingressDecision: EmailIngressDecisionSchema.optional().describe(
						"deliver wakes the runtime; quarantine keeps the message for triage, marks it spam and must not wake the model.",
					),
				}),
			),

		/** Content-free, append-only observations; neither arm classifies mail. */
		recordOutcome: oc
			.route({
				method: "POST",
				path: "/outcome",
				summary: "Record an observed email dispatch or runtime outcome",
				description:
					"Service-binding-only outcome receipt for an existing inbound mailbox message. Does not route, send, or triage email.",
			})
			.input(
				z.discriminatedUnion("kind", [
					z.object({
						kind: z.literal("worker_dispatch"),
						messageId: z.string().uuid(),
						result: z.enum([
							"sdk_returned",
							"no_route",
							"skipped",
							"failed",
							"unknown",
						]),
						elapsedMs: z.number().int().min(0).max(86_400_000),
					}),
					z.object({
						kind: z.literal("runtime_turn"),
						tediId: z.string().uuid(),
						messageIdHeader: z.string().min(1).max(998),
						runId: z.string().min(1).max(512),
						result: z.enum(["completed", "failed", "unknown"]),
						elapsedMs: z.number().int().min(0).max(86_400_000),
						replied: z
							.boolean()
							.nullable()
							.describe(
								"Null when the runtime did not observe a terminal reply result.",
							),
					}),
				]),
			)
			.output(
				z.object({
					id: z.string(),
					messageId: z.string().uuid(),
					duplicate: z.boolean(),
				}),
			),

		listInbox: oc
			.route({
				method: "GET",
				path: "/inbox",
				summary: "List tedi email inbox threads",
				description:
					"Lists durable mailbox threads for a tedi. Intended for per-tedi MCP email tools.",
			})
			.input(
				z.object({
					tediId: z.string().uuid(),
					status: EmailThreadStatusSchema.optional(),
					unread: z.boolean().optional(),
					query: z.string().min(1).max(200).optional(),
					cursor: z.string().optional(),
					limit: z.number().int().min(1).max(100).optional(),
				}),
			)
			.output(
				z.object({
					threads: z.array(EmailThreadSummarySchema),
					nextCursor: z.string().nullable(),
				}),
			),

		readThread: oc
			.route({
				method: "GET",
				path: "/threads/{threadId}",
				summary: "Read a tedi email thread",
				description: "Returns a durable mailbox thread and its messages.",
			})
			.input(
				z.object({
					tediId: z.string().uuid(),
					threadId: z.string().uuid(),
					markRead: z.boolean().optional(),
				}),
			)
			.output(
				z.object({
					thread: EmailThreadSchema,
					messages: z.array(EmailMessageSchema),
				}),
			),

		search: oc
			.route({
				method: "GET",
				path: "/search",
				summary: "Search tedi email",
				description:
					"Searches normalized sender, subject, preview, and stored text body for one tedi.",
			})
			.input(
				z.object({
					tediId: z.string().uuid(),
					query: z.string().min(1).max(500),
					limit: z.number().int().min(1).max(100).optional(),
				}),
			)
			.output(
				z.object({
					results: z.array(
						z.object({
							message: EmailMessageSchema,
							thread: EmailThreadSchema,
						}),
					),
				}),
			),

		mark: oc
			.route({
				method: "POST",
				path: "/mark",
				summary: "Update tedi email read/archive/spam state",
				description:
					"Marks a tedi email message or thread as read/unread, archived/unarchived, or spam/not-spam.",
			})
			.input(
				z
					.object({
						tediId: z.string().uuid(),
						threadId: z.string().uuid().optional(),
						messageId: z.string().uuid().optional(),
						read: z.boolean().optional(),
						archived: z.boolean().optional(),
						spam: z.boolean().optional(),
					})
					.refine((d) => Boolean(d.threadId) || Boolean(d.messageId), {
						message: "threadId or messageId is required",
					}),
			)
			.output(
				z.object({
					ok: z.boolean(),
					threadId: z.string(),
					unreadCount: z.number(),
				}),
			),

		getAttachment: oc
			.route({
				method: "GET",
				path: "/attachments/{attachmentId}",
				summary: "Read a tedi email attachment",
				description:
					"Returns attachment metadata plus base64 content for small stored R2-backed attachments.",
			})
			.input(
				z.object({
					tediId: z.string().uuid(),
					attachmentId: z.string().uuid(),
					maxBytes: z.number().int().min(1).max(2_000_000).optional(),
				}),
			)
			.output(
				z.object({
					attachment: EmailAttachmentSchema,
					messageId: z.string(),
					contentBase64: z.string().optional(),
					contentType: z.string().nullable().optional(),
					size: z.number().nullable().optional(),
					truncated: z.boolean(),
				}),
			),

		getMessageSource: oc
			.route({
				method: "GET",
				path: "/messages/{messageId}/source",
				summary: "Read stored raw or HTML email source",
				description:
					"Returns a bounded UTF-8 view of the stored raw MIME source or HTML body for debugging and rich-email inspection.",
			})
			.input(
				z.object({
					tediId: z.string().uuid(),
					messageId: z.string().uuid(),
					part: z.enum(["raw", "html"]),
					maxBytes: z.number().int().min(1).max(500_000).optional(),
				}),
			)
			.output(
				z.object({
					messageId: z.string(),
					part: z.enum(["raw", "html"]),
					content: z.string().optional(),
					contentType: z.string(),
					size: z.number().nullable().optional(),
					truncated: z.boolean(),
				}),
			),

		listAddresses: oc
			.route({
				method: "GET",
				path: "/addresses",
				summary: "List tedi email addresses",
				description:
					"Lists primary, alias, plus, and custom-domain addresses assigned or reserved for a tedi.",
			})
			.input(
				z.object({
					tediId: z.string().uuid(),
					status: z.enum(["active", "paused", "reserved", "all"]).optional(),
				}),
			)
			.output(z.object({ addresses: z.array(EmailAddressSchema) })),

		listAddressRequests: oc
			.route({
				method: "GET",
				path: "/address-requests",
				summary: "List tedi email provisioning requests",
				description:
					"Platform operator view of reserved, active, and paused tedi email addresses across tenants.",
			})
			.input(
				z.object({
					organizationId: z.string().uuid().optional(),
					tediId: z.string().uuid().optional(),
					status: z.enum(["active", "paused", "reserved", "all"]).optional(),
					domain: z.string().min(1).max(255).optional(),
					kind: EmailAddressKindSchema.optional(),
					limit: z.number().int().min(1).max(100).optional(),
				}),
			)
			.output(
				z.object({
					addresses: z.array(EmailAddressSchema),
					total: z.number(),
				}),
			),

		createAddress: oc
			.route({
				method: "POST",
				path: "/addresses",
				summary: "Create or request a tedi email address",
				description:
					"Tedis may reserve alias/custom-domain addresses; platform-admin callers can activate provisioned routes.",
			})
			.input(
				z.object({
					tediId: z.string().uuid(),
					address: z.string().email(),
					kind: EmailAddressKindSchema.exclude(["primary"]),
					status: EmailAddressStatusSchema.optional(),
					routingPolicy: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.output(z.object({ address: EmailAddressSchema })),

		updateAddress: oc
			.route({
				method: "POST",
				path: "/addresses/{addressId}",
				summary: "Update a tedi email address",
				description:
					"Platform-admin update of address status or routing metadata after provisioning, pausing, or custom-domain validation.",
			})
			.input(
				z.object({
					tediId: z.string().uuid(),
					addressId: z.string().uuid(),
					status: EmailAddressStatusSchema,
					routingPolicy: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.output(z.object({ address: EmailAddressSchema })),

		provisionAddress: oc
			.route({
				method: "POST",
				path: "/address-requests/{addressId}/provision",
				summary: "Provision a tedi email address",
				description:
					"Platform-admin activation, pausing, or reservation update for a tedi email address request.",
			})
			.input(
				z.object({
					addressId: z.string().uuid(),
					status: EmailAddressStatusSchema,
					routingPolicy: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.output(z.object({ address: EmailAddressSchema })),

		/**
		 * POST /tediEmail/send -- Send transactional email on behalf of a tedi or app.
		 *
		 * Outbound delivery uses the Cloudflare Email Service `EMAIL` binding
		 * configured on apps/api. The durable mailbox row is written regardless of
		 * whether the provider accepts the send.
		 *
		 * Either `tediId` (UUID) or `appSlug` must be provided. When `appSlug`
		 * is supplied, the sender uses the onboarded Tedix sending domain.
		 */
		sendEmail: oc
			.route({
				method: "POST",
				path: "/send",
				summary: "Send email from a tedi or app",
				description:
					"Sends outbound email on behalf of a tedi (tediId) or an app (appSlug) through the Cloudflare Email Service binding.",
			})
			.input(
				z
					.object({
						tediId: z.string().uuid().optional(),
						appSlug: z.string().min(1).max(64).optional(),
						to: z.array(EmailRecipientSchema).min(1).max(50),
						cc: z.array(EmailRecipientSchema).max(50).optional(),
						bcc: z.array(EmailRecipientSchema).max(50).optional(),
						subject: z.string().min(1).max(998),
						text: z.string().optional(),
						html: z.string().optional(),
						replyTo: EmailRecipientSchema.optional(),
						threadId: z.string().uuid().optional(),
						inReplyToMessageId: z.string().uuid().optional(),
					})
					.refine((d) => Boolean(d.tediId) || Boolean(d.appSlug), {
						message: "Either tediId or appSlug is required",
					})
					.refine((d) => Boolean(d.text) || Boolean(d.html), {
						message: "Either text or html body is required",
					})
					.refine(
						(d) =>
							d.to.length + (d.cc?.length ?? 0) + (d.bcc?.length ?? 0) <= 50,
						{
							message:
								"Cloudflare Email Service supports at most 50 total recipients",
						},
					),
			)
			.output(
				z.object({
					ok: z.boolean(),
					sent: z.boolean(),
					messageId: z.string().optional(),
					provider: z.literal("cloudflare"),
					emailMessageId: z.string().optional(),
					threadId: z.string().optional(),
				}),
			),

		replyEmail: oc
			.route({
				method: "POST",
				path: "/reply",
				summary: "Reply to a stored tedi email thread or message",
				description:
					"Sends a reply as a tedi and records the outbound message in the durable mailbox.",
			})
			.input(
				z
					.object({
						tediId: z.string().uuid(),
						threadId: z.string().uuid().optional(),
						messageId: z.string().uuid().optional(),
						subject: z.string().min(1).max(998).optional(),
						text: z.string().optional(),
						html: z.string().optional(),
						cc: z.array(EmailRecipientSchema).max(49).optional(),
						bcc: z.array(EmailRecipientSchema).max(49).optional(),
						replyTo: EmailRecipientSchema.optional(),
					})
					.refine((d) => Boolean(d.threadId) || Boolean(d.messageId), {
						message: "threadId or messageId is required",
					})
					.refine((d) => Boolean(d.text) || Boolean(d.html), {
						message: "Either text or html body is required",
					})
					.refine((d) => 1 + (d.cc?.length ?? 0) + (d.bcc?.length ?? 0) <= 50, {
						message:
							"Cloudflare Email Service supports at most 50 total recipients",
					}),
			)
			.output(
				z.object({
					ok: z.boolean(),
					sent: z.boolean(),
					provider: z.literal("cloudflare"),
					providerMessageId: z.string().optional(),
					emailMessageId: z.string().optional(),
					threadId: z.string(),
				}),
			),
	});

export type TediEmailContract = typeof tediEmailContract;
