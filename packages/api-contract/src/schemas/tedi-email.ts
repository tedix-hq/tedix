/**
 * Tedi email ingress schemas shared by the runtime ingress and apps/api.
 */

import * as z from "zod";

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
		/** Provenance label written by the creating surface. */
		source: z.string().max(100).optional(),
	})
	.strict();

export type EmailRoutingPolicy = z.infer<typeof EmailRoutingPolicySchema>;
