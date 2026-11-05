/**
 * Tedi email ingress schemas shared by the runtime ingress and apps/api.
 */

import * as z from "zod";
import { normalizeTrustedRecipientAddress } from "../utils/email-trusted-recipients";

const EmailAuthVerdictSchema = z.enum(["pass", "fail", "none"]);
/** Parsed from the Cloudflare `Authentication-Results` header by the runtime ingress. */
export const EmailAuthResultsSchema = z.object({
	dkim: EmailAuthVerdictSchema,
	dmarc: EmailAuthVerdictSchema,
	spf: EmailAuthVerdictSchema,
	dkimDomain: z.string().optional(),
	dmarcDomain: z.string().optional(),
	spfDomain: z.string().optional(),
});
export const EmailSenderTrustSchema = z.enum(["trusted", "untrusted"]);
export const EmailIngressDecisionSchema = z.enum(["deliver", "quarantine"]);

export type EmailAuthResults = z.infer<typeof EmailAuthResultsSchema>;
export type EmailSenderTrust = z.infer<typeof EmailSenderTrustSchema>;
export type EmailIngressDecision = z.infer<typeof EmailIngressDecisionSchema>;

const EMAIL_SENDER_ENTRY = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const EMAIL_SENDER_DOMAIN_ENTRY = /^@[a-z0-9.-]+\.[a-z]{2,}$/;

/** A lowercase sender email or an `@domain` suffix; input is trimmed and lowercased. */
export const EmailAllowedSenderSchema = z
	.string()
	.trim()
	.toLowerCase()
	.max(254)
	.refine(
		(entry) =>
			EMAIL_SENDER_ENTRY.test(entry) || EMAIL_SENDER_DOMAIN_ENTRY.test(entry),
		{
			message: "Allowed sender must be an email address or an @domain suffix",
		},
	);

/**
 * Tenant-editable `tedi_email_addresses.routing_policy`. Strict: the inbound
 * policy reads exactly these keys, so an unknown key is a typo, not config.
 */
export const EmailRoutingPolicySchema = z
	.object({
		allowedSenders: z.array(EmailAllowedSenderSchema).max(200).optional(),
		untrustedSenders: EmailIngressDecisionSchema.optional(),
		spamThreshold: z.number().min(0).max(20).optional(),
		/** Restricted support intake; sender-to-tenant mapping stays with the admin. */
		supportIntake: z.boolean().optional(),
		/** Provenance label written by the creating surface. */
		source: z.string().max(100).optional(),
	})
	.strict();

export type EmailRoutingPolicy = z.infer<typeof EmailRoutingPolicySchema>;

/**
 * An exact external address a tedi may email without a human approval card.
 * Wildcards, bare domains and `@domain` suffixes are rejected; the value is
 * stored lowercased.
 */
export const EmailTrustedRecipientAddressSchema = z
	.string()
	.trim()
	.min(3)
	.max(254)
	.transform((value, ctx) => {
		const address = normalizeTrustedRecipientAddress(value);
		if (!address) {
			ctx.addIssue({
				code: "custom",
				message:
					"Use one exact email address such as partner@example.com; wildcards and domains are not allowed",
			});
			return z.NEVER;
		}
		return address;
	});

export const EmailTrustedRecipientSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	tediId: z.string(),
	address: z.string(),
	createdBy: z.string(),
	createdAt: z.string(),
	revokedAt: z.string().nullable(),
	revokedBy: z.string().nullable(),
});
export type EmailTrustedRecipient = z.infer<typeof EmailTrustedRecipientSchema>;

export const ListEmailTrustedRecipientsInputSchema = z
	.object({
		tediId: z.string().uuid(),
		includeRevoked: z.boolean().optional(),
	})
	.strict();
export const AddEmailTrustedRecipientInputSchema = z.object({
	tediId: z.string().uuid(),
	address: EmailTrustedRecipientAddressSchema,
});
export const RevokeEmailTrustedRecipientInputSchema = z.object({
	tediId: z.string().uuid(),
	recipientId: z.string().uuid(),
});

/**
 * Service-only check used by the MCP gateway and the tedi runtime before a
 * send. Recipients for a reply are resolved from the stored thread; the
 * trusted list is always read from storage.
 */
export const ResolveTrustedRecipientSendInputSchema = z.object({
	tediId: z.string().uuid(),
	/** The tedi the verified caller acts as; must equal `tediId`. */
	actingTediId: z.string().min(1).nullable(),
	kind: z.enum(["send", "reply"]),
	to: z.array(z.string().max(320)).max(50).optional(),
	cc: z.array(z.string().max(320)).max(50).optional(),
	bcc: z.array(z.string().max(320)).max(50).optional(),
	/** Stored reply target for `kind: "reply"` without an explicit `to`. */
	threadId: z.string().uuid().optional(),
	messageId: z.string().uuid().optional(),
});
export const ResolveTrustedRecipientSendOutputSchema = z.object({
	trusted: z.boolean(),
	reason: z.string(),
	addresses: z.array(z.string()),
});
export type ResolveTrustedRecipientSendInput = z.infer<
	typeof ResolveTrustedRecipientSendInputSchema
>;
export type ResolveTrustedRecipientSendOutput = z.infer<
	typeof ResolveTrustedRecipientSendOutputSchema
>;
