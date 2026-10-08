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
