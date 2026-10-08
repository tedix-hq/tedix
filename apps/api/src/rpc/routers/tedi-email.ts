/**
 * oRPC Tedi Email Router
 *
 * Inbound: apps/tedi-runtime email() -> API_SERVICE binding -> durable mailbox ->
 *           runtime ingress separately forwards through the Agents email SDK.
 * Outbound: tedi runtime / tenant apps -> API -> durable outbox ->
 *           Cloudflare Email Service.
 */

import { implement } from "@orpc/server";
import { tediEmailContract } from "@tedix/api-contract/contracts/tedi-email";
import {
	type JsonValue,
	JsonValueSchema,
} from "@tedix/api-contract/schemas/common";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { getAppBySlug } from "@tedix/db/queries/apps";
import { getActiveMemberByEmail } from "@tedix/db/queries/organization-members";
import {
	createTediEmailAddress,
	getActiveTediEmailAddressByAddress,
	getTediEmailAddressById,
	listTediEmailAddresses,
	listTediEmailAddressRequests,
	updateTediEmailAddressProvisioning,
	updateTediEmailAddressStatus,
} from "@tedix/db/queries/tedi-email/addresses";
import {
	createOutboundTediEmailMessage,
	ingestInboundTediEmail,
} from "@tedix/db/queries/tedi-email/delivery";
import { recordTediEmailOutcome } from "@tedix/db/queries/tedi-email/events";
import {
	countRecentInboundTediEmailMessages,
	findUniqueInboundTediEmailMessageIdentityByHeader,
	getTediEmailAttachment,
	getTediEmailMessage,
	getInboundTediEmailMessageIdentity,
} from "@tedix/db/queries/tedi-email/messages";
import { normalizeEmailRecipient } from "@tedix/db/queries/tedi-email/recipients";
import {
	getTediEmailThread,
	listTediEmailThreads,
	markTediEmail,
	searchTediEmail,
} from "@tedix/db/queries/tedi-email/threads";
import { getActiveTediSlugById, getTediById } from "@tedix/db/queries/tedis";
import { sendTransactionalEmail } from "../../lib/email";
import {
	decideIngress,
	evaluateSenderTrust,
	INBOUND_EMAIL_POLICY,
	parseInboundRoutingPolicy,
} from "../../lib/inbound-email-policy";
import {
	AUTHZ,
	withAuthorization,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withServiceAuth,
} from "../orpc";

function normalizeOptionalJsonRecord(
	value: Record<string, unknown> | null | undefined,
): Record<string, JsonValue> | null | undefined {
	if (value == null) return value;
	const parsed = JsonValueSchema.parse(value);
	if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
		throw createError(ErrorCodes.BAD_REQUEST, "Expected a JSON object");
	}
	return parsed;
}

const os = implement(tediEmailContract).$context<BaseContext>();
const serviceAuthed = os.use(withServiceAuth);
const authed = os.use(withAuth);

// =============================================================================
// HELPERS
// =============================================================================

function capitalise(s: string): string {
	if (!s) return s;
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function uniqueHeaderValues(
	values: Array<string | null | undefined>,
): string[] {
	return [
		...new Set(
			values.filter((v): v is string => Boolean(v)).map((v) => v.trim()),
		),
	];
}

function buildReplySubject(subject: string): string {
	return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

function createMessageIdHeader(slug: string): string {
	return `<${crypto.randomUUID()}@${slug}.tedix.tech>`;
}

function isInternalServicePrincipal(context: BaseContext): boolean {
	return context.authType === "service-binding";
}

function hasEmailProvisioningAuthority(context: BaseContext): boolean {
	return isInternalServicePrincipal(context) || isPlatformPrincipal(context);
}

function requireEmailProvisioningAuthority(context: BaseContext): void {
	if (hasEmailProvisioningAuthority(context)) return;
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Platform email provisioning authority required",
	);
}

function assertOrganizationAccess(
	context: BaseContext,
	ownerOrganizationId: string,
): void {
	if (!context.organizationId) {
		if (hasEmailProvisioningAuthority(context)) {
			return;
		}
		throw createError(ErrorCodes.UNAUTHORIZED, "Organization context required");
	}
	if (
		context.organizationId !== ownerOrganizationId &&
		!hasEmailProvisioningAuthority(context)
	) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this mailbox");
	}
}

async function requireTediEmailAccess(context: BaseContext, tediId: string) {
	if (
		context.authType === "tedi" &&
		context.tediId &&
		context.tediId !== tediId
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Tedi JWT cannot access another tedi mailbox",
		);
	}

	const tedi = await getTediById(context.db, tediId);
	if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	assertOrganizationAccess(context, tedi.organizationId);
	return tedi;
}

async function resolveSenderIdentity(
	context: BaseContext,
	input: { tediId?: string; appSlug?: string },
): Promise<{
	name: string;
	email: string;
	slug: string;
	organizationId: string;
	tediId?: string;
} | null> {
	if (input.tediId) {
		const tedi = await requireTediEmailAccess(context, input.tediId);
		const tediSlug = await getActiveTediSlugById(context.db, input.tediId);
		if (!tediSlug) return null;
		return {
			name: tedi.displayName ?? `${capitalise(tediSlug)} (Tedi)`,
			email: `${tediSlug}@tedix.tech`,
			slug: tediSlug,
			organizationId: tedi.organizationId,
			tediId: input.tediId,
		};
	}
	if (input.appSlug) {
		const app = await getAppBySlug(context.db, input.appSlug);
		if (!app) return null;
		assertOrganizationAccess(context, app.organizationId);
		return {
			name: app.name ?? capitalise(input.appSlug),
			email: "noreply@tedix.tech",
			slug: input.appSlug,
			organizationId: app.organizationId,
		};
	}
	return null;
}

function outboundEnv(env: CloudflareEnv): {
	EMAIL?: SendEmail;
} {
	return env as { EMAIL?: SendEmail };
}

function assertOutboundEmailConfigured(context: BaseContext): void {
	const env = outboundEnv(context.env);
	if (env.EMAIL) return;
	throw createError(
		ErrorCodes.INTERNAL_SERVER_ERROR,
		"EMAIL binding unavailable",
	);
}

function throwIfNoBackend(context: BaseContext, ok: boolean): void {
	const env = outboundEnv(context.env);
	if (!ok && !env.EMAIL) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"No outbound email backend configured (EMAIL binding unavailable)",
		);
	}
}

function safeObjectSegment(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 100) || "item"
	);
}

function todayPrefix(): string {
	return new Date().toISOString().slice(0, 10);
}

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

async function storeOutboundHtml(
	context: BaseContext,
	input: { slug: string; html?: string | null },
): Promise<string | null> {
	if (!input.html) return null;
	const bucket = context.env.TEDI_R2_BUCKET;
	if (!bucket) return null;
	const key = [
		"email",
		safeObjectSegment(input.slug),
		"outbound",
		todayPrefix(),
		`${crypto.randomUUID()}.html`,
	].join("/");
	await bucket.put(key, input.html, {
		httpMetadata: { contentType: "text/html; charset=utf-8" },
	});
	return key;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
	}
	return btoa(binary);
}

async function readEmailObjectBytes(
	context: BaseContext,
	key: string,
	maxBytes: number,
): Promise<{
	bytes?: Uint8Array;
	contentType?: string | null;
	size?: number | null;
	truncated: boolean;
}> {
	const bucket = context.env.TEDI_R2_BUCKET;
	if (!bucket) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"TEDI_R2_BUCKET unavailable",
		);
	}
	const object = await bucket.get(key);
	if (!object) {
		throw createError(ErrorCodes.NOT_FOUND, "Stored email object not found");
	}
	const size = object.size ?? null;
	if (size != null && size > maxBytes) {
		return {
			contentType: object.httpMetadata?.contentType,
			size,
			truncated: true,
		};
	}
	const buffer = await object.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	if (bytes.byteLength > maxBytes) {
		return {
			contentType: object.httpMetadata?.contentType,
			size: bytes.byteLength,
			truncated: true,
		};
	}
	return {
		bytes,
		contentType: object.httpMetadata?.contentType,
		size: size ?? bytes.byteLength,
		truncated: false,
	};
}

function actorLabel(context: BaseContext): string {
	if (context.authType === "tedi" && context.tediId)
		return `tedi:${context.tediId}`;
	if (context.user?.sub) return `user:${context.user.sub}`;
	if (context.serviceAccount?.clientId)
		return `service:${context.serviceAccount.clientId}`;
	if (context.apiKey?.id) return `apikey:${context.apiKey.id}`;
	return context.authType ?? "unknown";
}

// =============================================================================
// INBOUND EMAIL
// =============================================================================

const inboundEmail = serviceAuthed.inboundEmail.handler(
	async ({ input, context }) => {
		const { from, subject, body } = input;
		const to = normalizeEmailRecipient(input.to);
		const toAddress = to.email;

		// Addresses are opt-in: only an active `tedi_email_addresses` row
		// receives mail. `{slug}@tedix.tech` is provisioned explicitly through
		// `requestAddress`/`provisionAddress`, never implied from a tedi slug.
		const routedAddress = await getActiveTediEmailAddressByAddress(
			context.db,
			toAddress,
		);
		const tedi = routedAddress
			? await getTediById(context.db, routedAddress.tediId)
			: null;
		if (!routedAddress || !tedi) {
			console.warn(
				`[Email] No active tedi address found for recipient: ${toAddress}`,
			);
			return { delivered: false };
		}
		const tediId = routedAddress.tediId;
		const organizationId = tedi.organizationId;

		const policy = parseInboundRoutingPolicy(routedAddress.routingPolicy);
		const fromEmail = normalizeEmailRecipient(from).email;
		const [member, senderAddress] = await Promise.all([
			getActiveMemberByEmail(context.db, organizationId, fromEmail),
			getActiveTediEmailAddressByAddress(context.db, fromEmail),
		]);
		const senderTrust = evaluateSenderTrust({
			fromEmail,
			authResults: input.authResults,
			policy,
			isOrganizationMember: member !== undefined,
			isOrganizationTediAddress:
				senderAddress?.organizationId === organizationId,
		});
		const recentUntrustedCount =
			senderTrust === "untrusted"
				? await countRecentInboundTediEmailMessages(context.db, {
						tediId,
						organizationId,
						sinceIso: new Date(
							Date.now() - INBOUND_EMAIL_POLICY.untrustedRateWindowMs,
						).toISOString(),
						excludeFromAddrs: policy.allowedSenders.filter(
							(entry) => !entry.startsWith("@"),
						),
					})
				: 0;
		const ingressDecision = decideIngress({
			senderTrust,
			spamScore: input.spamScore,
			policy,
			recentUntrustedCount,
		});

		const stored = await ingestInboundTediEmail(context.db, {
			tediId,
			organizationId,
			to,
			from,
			cc: input.cc,
			bcc: input.bcc,
			replyTo: input.replyTo,
			subject,
			textBody: body,
			rawR2Key: input.rawR2Key,
			htmlR2Key: input.htmlR2Key,
			rawSize: input.rawSize,
			spamScore: input.spamScore,
			attachments: input.attachments,
			messageIdHeader: input.messageId,
			inReplyTo: input.inReplyTo,
			references: input.references,
		});
		if (ingressDecision === "quarantine") {
			// Persisted for operator triage, filed as spam, never woken.
			await markTediEmail(context.db, {
				tediId,
				organizationId,
				threadId: stored.thread.id,
				spam: true,
			});
		}

		// Acknowledge durable mailbox persistence. Runtime ingress separately
		// forwards a delivered message through the Agents SDK to wake the runtime.
		return {
			delivered: true,
			threadId: stored.thread.id,
			messageId: stored.message.id,
			senderTrust,
			ingressDecision,
		};
	},
);

const recordOutcome = serviceAuthed.recordOutcome.handler(
	async ({ input, context }) => {
		let message: Awaited<ReturnType<typeof getInboundTediEmailMessageIdentity>>;
		if (input.kind === "worker_dispatch") {
			message = await getInboundTediEmailMessageIdentity(
				context.db,
				input.messageId,
			);
		} else {
			const resolved = await findUniqueInboundTediEmailMessageIdentityByHeader(
				context.db,
				{
					tediId: input.tediId,
					messageIdHeader: input.messageIdHeader,
				},
			);
			if (resolved.status === "ambiguous") {
				throw createError(
					ErrorCodes.CONFLICT,
					"Email Message-ID resolves to multiple mailbox messages",
				);
			}
			message = resolved.status === "found" ? resolved.message : null;
		}
		if (!message) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Inbound email message not found",
			);
		}
		try {
			const receipt = await recordTediEmailOutcome(context.db, {
				...input,
				message,
			});
			return { ...receipt, messageId: message.id };
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "Conflicting email outcome observation"
			) {
				throw createError(ErrorCodes.CONFLICT, error.message);
			}
			throw error;
		}
	},
);

// =============================================================================
// MAILBOX READ / TRIAGE
// =============================================================================

const listInbox = authed.listInbox
	.use(AUTHZ.messagingRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediEmailAccess(context, input.tediId);
		return listTediEmailThreads(context.db, {
			tediId: input.tediId,
			organizationId: tedi.organizationId,
			status: input.status ?? "open",
			unread: input.unread,
			query: input.query,
			cursor: input.cursor,
			limit: input.limit,
		});
	});

const readThread = authed.readThread
	.use(AUTHZ.messagingRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediEmailAccess(context, input.tediId);
		const result = await getTediEmailThread(context.db, {
			tediId: input.tediId,
			organizationId: tedi.organizationId,
			threadId: input.threadId,
		});
		if (!result)
			throw createError(ErrorCodes.NOT_FOUND, "Email thread not found");
		if (input.markRead) {
			await markTediEmail(context.db, {
				tediId: input.tediId,
				organizationId: tedi.organizationId,
				threadId: input.threadId,
				read: true,
			});
			const reread = await getTediEmailThread(context.db, {
				tediId: input.tediId,
				organizationId: tedi.organizationId,
				threadId: input.threadId,
			});
			if (reread) return reread;
		}
		return result;
	});

const search = authed.search
	.use(AUTHZ.messagingRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediEmailAccess(context, input.tediId);
		const results = await searchTediEmail(context.db, {
			tediId: input.tediId,
			organizationId: tedi.organizationId,
			query: input.query,
			limit: input.limit,
		});
		return { results };
	});

const mark = authed.mark
	.use(withAuthorization("tedis:update", "mcp:messaging.write"))
	.handler(async ({ input, context }) => {
		const tedi = await requireTediEmailAccess(context, input.tediId);
		try {
			return await markTediEmail(context.db, {
				tediId: input.tediId,
				organizationId: tedi.organizationId,
				threadId: input.threadId,
				messageId: input.messageId,
				read: input.read,
				archived: input.archived,
				spam: input.spam,
			});
		} catch (err) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				err instanceof Error ? err.message : "Email target not found",
			);
		}
	});

const getAttachment = authed.getAttachment
	.use(AUTHZ.messagingRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediEmailAccess(context, input.tediId);
		const result = await getTediEmailAttachment(context.db, {
			attachmentId: input.attachmentId,
			tediId: input.tediId,
			organizationId: tedi.organizationId,
		});
		if (!result) {
			throw createError(ErrorCodes.NOT_FOUND, "Email attachment not found");
		}
		if (!result.attachment.r2Key) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Attachment bytes were not stored for this message",
			);
		}

		const object = await readEmailObjectBytes(
			context,
			result.attachment.r2Key,
			input.maxBytes ?? 1_000_000,
		);
		return {
			attachment: result.attachment,
			messageId: result.message.id,
			contentBase64: object.bytes ? bytesToBase64(object.bytes) : undefined,
			contentType: object.contentType ?? result.attachment.contentType,
			size: object.size ?? result.attachment.size,
			truncated: object.truncated,
		};
	});

const getMessageSource = authed.getMessageSource
	.use(AUTHZ.messagingRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediEmailAccess(context, input.tediId);
		const message = await getTediEmailMessage(context.db, {
			messageId: input.messageId,
			tediId: input.tediId,
			organizationId: tedi.organizationId,
		});
		if (!message) {
			throw createError(ErrorCodes.NOT_FOUND, "Email message not found");
		}
		const key = input.part === "raw" ? message.rawR2Key : message.htmlR2Key;
		if (!key) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`Stored ${input.part} source is unavailable for this message`,
			);
		}

		const object = await readEmailObjectBytes(
			context,
			key,
			input.maxBytes ?? 250_000,
		);
		return {
			messageId: message.id,
			part: input.part,
			content: object.bytes
				? new TextDecoder("utf-8").decode(object.bytes)
				: undefined,
			contentType:
				object.contentType ??
				(input.part === "raw" ? "message/rfc822" : "text/html"),
			size: object.size,
			truncated: object.truncated,
		};
	});

const listAddresses = authed.listAddresses
	.use(AUTHZ.messagingRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediEmailAccess(context, input.tediId);
		const addresses = await listTediEmailAddresses(context.db, {
			tediId: input.tediId,
			organizationId: tedi.organizationId,
			status: input.status ?? "all",
		});
		return { addresses };
	});

const listAddressRequests = authed.listAddressRequests
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		requireEmailProvisioningAuthority(context);
		const addresses = await listTediEmailAddressRequests(context.db, {
			organizationId: input.organizationId,
			tediId: input.tediId,
			status: input.status ?? "reserved",
			domain: input.domain?.trim().toLowerCase(),
			kind: input.kind,
			limit: input.limit,
		});
		return { addresses, total: addresses.length };
	});

const createAddress = authed.createAddress
	.use(withAuthorization("tedis:update", "mcp:messaging.write"))
	.handler(async ({ input, context }) => {
		const tedi = await requireTediEmailAccess(context, input.tediId);
		const requestedStatus = input.status ?? "reserved";
		if (requestedStatus !== "reserved") {
			requireEmailProvisioningAuthority(context);
		}
		try {
			const address = await createTediEmailAddress(context.db, {
				tediId: input.tediId,
				organizationId: tedi.organizationId,
				address: input.address,
				kind: input.kind,
				status: context.authType === "tedi" ? "reserved" : requestedStatus,
				routingPolicy: normalizeOptionalJsonRecord(
					input.routingPolicy ?? { source: "tedi-email-address-request" },
				),
				createdBy: actorLabel(context),
			});
			return { address };
		} catch (err) {
			throw createError(
				ErrorCodes.CONFLICT,
				err instanceof Error ? err.message : "Email address conflict",
			);
		}
	});

const updateAddress = authed.updateAddress
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		requireEmailProvisioningAuthority(context);
		const tedi = await requireTediEmailAccess(context, input.tediId);
		const address = await updateTediEmailAddressStatus(context.db, {
			id: input.addressId,
			tediId: input.tediId,
			organizationId: tedi.organizationId,
			status: input.status,
			routingPolicy: normalizeOptionalJsonRecord(input.routingPolicy),
		});
		if (!address) {
			throw createError(ErrorCodes.NOT_FOUND, "Email address not found");
		}
		return { address };
	});

const provisionAddress = authed.provisionAddress
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		requireEmailProvisioningAuthority(context);
		const existing = await getTediEmailAddressById(context.db, input.addressId);
		if (!existing) {
			throw createError(ErrorCodes.NOT_FOUND, "Email address not found");
		}
		assertOrganizationAccess(context, existing.organizationId);
		const address = await updateTediEmailAddressProvisioning(context.db, {
			id: input.addressId,
			status: input.status,
			routingPolicy: normalizeOptionalJsonRecord(input.routingPolicy),
		});
		if (!address) {
			throw createError(ErrorCodes.NOT_FOUND, "Email address not found");
		}
		return { address };
	});

// =============================================================================
// OUTBOUND EMAIL
// =============================================================================

const sendEmail = authed.sendEmail
	.use(withAuthorization("integrations:manage", "mcp:messaging.write"))
	.handler(async ({ input, context }) => {
		const { to, cc, bcc, subject, text, html, replyTo } = input;
		const sender = await resolveSenderIdentity(context, {
			tediId: input.tediId,
			appSlug: input.appSlug,
		});
		if (!sender) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				input.tediId
					? "Tedi not found"
					: `App not found for slug "${input.appSlug}"`,
			);
		}
		assertOutboundEmailConfigured(context);

		let inReplyTo: string | null = null;
		let references: string[] = [];
		let threadId = input.threadId;
		if (input.tediId && input.inReplyToMessageId) {
			const original = await getTediEmailMessage(context.db, {
				messageId: input.inReplyToMessageId,
				tediId: input.tediId,
				organizationId: sender.organizationId,
			});
			if (!original) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Reply target message not found",
				);
			}
			threadId = original.threadId;
			inReplyTo = original.messageIdHeader ?? null;
			references = uniqueHeaderValues([
				...(original.references ?? []),
				original.messageIdHeader,
			]);
		}

		const messageIdHeader = createMessageIdHeader(sender.slug);
		const htmlR2Key = await storeOutboundHtml(context, {
			slug: sender.slug,
			html,
		});
		const result = await sendTransactionalEmail(outboundEnv(context.env), {
			from: { name: sender.name, email: sender.email },
			to,
			cc,
			bcc,
			subject,
			text,
			html,
			replyTo,
			headers: {
				// CF Email Service rejects explicit Message-ID (it generates its own
				// for SPF/DKIM compliance). We preserve our internal id via the X-*
				// header so inbound replies can be correlated back to the outbound
				// thread. In-Reply-To and References ARE on CF's whitelist.
				"X-Tedix-Message-ID": messageIdHeader,
				// RFC 3834: a tedi's mail is machine-generated, so a peer tedi
				// mailbox stores it without waking its model (no reply loops).
				"Auto-Submitted": "auto-replied",
				...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}),
				...(references.length > 0 ? { References: references.join(" ") } : {}),
			},
		});
		throwIfNoBackend(context, result.ok);
		const providerMessageId = result.ok ? result.messageId : undefined;

		let emailMessageId: string | undefined;
		let storedThreadId: string | undefined;
		if (sender.tediId) {
			const stored = await createOutboundTediEmailMessage(context.db, {
				tediId: sender.tediId,
				organizationId: sender.organizationId,
				threadId,
				from: { name: sender.name, email: sender.email },
				to,
				cc,
				bcc,
				replyTo,
				subject,
				textBody: text ?? (html ? stripHtml(html) : null),
				htmlR2Key,
				providerMessageId,
				messageIdHeader,
				inReplyTo,
				references,
				status: result.ok ? "sent" : "failed",
			});
			emailMessageId = stored.message.id;
			storedThreadId = stored.thread.id;
		}

		return {
			ok: result.ok,
			sent: result.sent,
			messageId: providerMessageId,
			provider: result.provider,
			emailMessageId,
			threadId: storedThreadId,
		};
	});

const replyEmail = authed.replyEmail
	.use(withAuthorization("integrations:manage", "mcp:messaging.write"))
	.handler(async ({ input, context }) => {
		const tedi = await requireTediEmailAccess(context, input.tediId);
		const senderSlug = await getActiveTediSlugById(context.db, input.tediId);
		if (!senderSlug) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");

		const threadIdFromMessage = input.messageId
			? (
					await getTediEmailMessage(context.db, {
						messageId: input.messageId,
						tediId: input.tediId,
						organizationId: tedi.organizationId,
					})
				)?.threadId
			: undefined;
		const threadId = input.threadId ?? threadIdFromMessage;
		if (!threadId) {
			throw createError(ErrorCodes.NOT_FOUND, "Email reply target not found");
		}

		const thread = await getTediEmailThread(context.db, {
			threadId,
			tediId: input.tediId,
			organizationId: tedi.organizationId,
		});
		if (!thread)
			throw createError(ErrorCodes.NOT_FOUND, "Email thread not found");

		const original =
			(input.messageId
				? thread.messages.find((message) => message.id === input.messageId)
				: undefined) ??
			[...thread.messages]
				.reverse()
				.find((message) => message.direction === "inbound");
		if (!original) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"No inbound message found to reply to",
			);
		}

		const to = normalizeEmailRecipient(
			original.direction === "inbound"
				? (original.from ?? original.fromAddr)
				: (original.replyTo ?? original.to[0] ?? ""),
		);
		if (!to.email) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Reply target has no recipient address",
			);
		}
		assertOutboundEmailConfigured(context);

		const fromAddr = `${senderSlug}@tedix.tech`;
		const messageIdHeader = createMessageIdHeader(senderSlug);
		const subject = input.subject ?? buildReplySubject(original.subject);
		const inReplyTo = original.messageIdHeader ?? null;
		const references = uniqueHeaderValues([
			...(original.references ?? []),
			original.messageIdHeader,
		]);
		const htmlR2Key = await storeOutboundHtml(context, {
			slug: senderSlug,
			html: input.html,
		});

		const result = await sendTransactionalEmail(outboundEnv(context.env), {
			from: {
				name: tedi.displayName ?? `${capitalise(senderSlug)} (Tedi)`,
				email: fromAddr,
			},
			to: [to],
			cc: input.cc,
			bcc: input.bcc,
			replyTo: input.replyTo,
			subject,
			text: input.text,
			html: input.html,
			headers: {
				// CF Email Service rejects explicit Message-ID (it generates its own
				// for SPF/DKIM compliance). We preserve our internal id via the X-*
				// header so inbound replies can be correlated back to the outbound
				// thread. In-Reply-To and References ARE on CF's whitelist.
				"X-Tedix-Message-ID": messageIdHeader,
				// RFC 3834: a tedi's mail is machine-generated, so a peer tedi
				// mailbox stores it without waking its model (no reply loops).
				"Auto-Submitted": "auto-replied",
				...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}),
				...(references.length > 0 ? { References: references.join(" ") } : {}),
			},
		});
		throwIfNoBackend(context, result.ok);
		const providerMessageId = result.ok ? result.messageId : undefined;

		const stored = await createOutboundTediEmailMessage(context.db, {
			tediId: input.tediId,
			organizationId: tedi.organizationId,
			threadId,
			from: {
				name: tedi.displayName ?? `${capitalise(senderSlug)} (Tedi)`,
				email: fromAddr,
			},
			to: [to],
			cc: input.cc,
			bcc: input.bcc,
			replyTo: input.replyTo,
			subject,
			textBody: input.text ?? (input.html ? stripHtml(input.html) : null),
			htmlR2Key,
			providerMessageId,
			messageIdHeader,
			inReplyTo,
			references,
			status: result.ok ? "sent" : "failed",
		});

		return {
			ok: result.ok,
			sent: result.sent,
			provider: result.provider,
			providerMessageId,
			emailMessageId: stored.message.id,
			threadId: stored.thread.id,
		};
	});

// =============================================================================
// ROUTER EXPORT
// =============================================================================

export const tediEmailContractRouter = os.router({
	inboundEmail,
	recordOutcome,
	listInbox,
	readThread,
	search,
	mark,
	getAttachment,
	getMessageSource,
	listAddresses,
	listAddressRequests,
	createAddress,
	updateAddress,
	provisionAddress,
	sendEmail,
	replyEmail,
});
