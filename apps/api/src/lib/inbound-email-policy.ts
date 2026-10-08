/**
 * Inbound email sender policy
 *
 * Pure verdicts for mail arriving at a tedi address. The router gathers the
 * facts (address row, member lookup, recent volume); this module decides.
 *
 * A sender is trusted only when it is a known correspondent AND the message
 * carries a Cloudflare `Authentication-Results` DKIM or DMARC pass aligned
 * with the sender's domain. A missing header is never trusted: a From line
 * is free to forge, an aligned signature is not.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type {
	EmailAuthResults,
	EmailIngressDecision,
	EmailSenderTrust,
} from "@tedix/api-contract/schemas/tedi-email";

export const INBOUND_EMAIL_POLICY = {
	/** `X-CF-Spamh-Score` at or above this is quarantined. */
	spamThreshold: 5,
	/** Untrusted inbound messages to one tedi inside the window before quarantine. */
	untrustedRateLimit: 20,
	untrustedRateWindowMs: 10 * 60 * 1000,
} as const;

/** Operator-authored `tedi_email_addresses.routing_policy` keys this module reads. */
export interface InboundRoutingPolicy {
	/** Lowercase emails or `@domain` suffixes. */
	allowedSenders: string[];
	spamThreshold: number;
	untrustedSenders: "deliver" | "quarantine";
}

export function parseInboundRoutingPolicy(
	raw: Record<string, JsonValue> | null | undefined,
): InboundRoutingPolicy {
	const allowed = Array.isArray(raw?.allowedSenders)
		? raw.allowedSenders
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim().toLowerCase())
				.filter(Boolean)
		: [];
	const threshold =
		typeof raw?.spamThreshold === "number" && Number.isFinite(raw.spamThreshold)
			? raw.spamThreshold
			: INBOUND_EMAIL_POLICY.spamThreshold;
	return {
		allowedSenders: allowed,
		spamThreshold: threshold,
		untrustedSenders:
			raw?.untrustedSenders === "quarantine" ? "quarantine" : "deliver",
	};
}

function domainOf(email: string): string {
	return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function authenticatedFor(
	auth: EmailAuthResults | undefined,
	domain: string,
): boolean {
	if (!auth || !domain) return false;
	const aligned = (candidate: string | undefined) =>
		candidate !== undefined &&
		(candidate === domain || candidate.endsWith(`.${domain}`));
	return (
		(auth.dkim === "pass" && aligned(auth.dkimDomain)) ||
		(auth.dmarc === "pass" && aligned(auth.dmarcDomain))
	);
}

export function evaluateSenderTrust(input: {
	fromEmail: string;
	authResults?: EmailAuthResults;
	policy: InboundRoutingPolicy;
	/** Sender is an active member of the recipient tedi's organization. */
	isOrganizationMember: boolean;
	/** Sender is an active tedi address in the same organization. */
	isOrganizationTediAddress: boolean;
}): EmailSenderTrust {
	const from = input.fromEmail.trim().toLowerCase();
	const fromDomain = domainOf(from);
	const candidateDomains: string[] = [];
	if (input.isOrganizationMember || input.isOrganizationTediAddress) {
		candidateDomains.push(fromDomain);
	}
	for (const entry of input.policy.allowedSenders) {
		if (entry.startsWith("@")) {
			if (from.endsWith(entry)) candidateDomains.push(entry.slice(1));
		} else if (entry === from) {
			candidateDomains.push(fromDomain);
		}
	}
	return candidateDomains.some((domain) =>
		authenticatedFor(input.authResults, domain),
	)
		? "trusted"
		: "untrusted";
}

export function decideIngress(input: {
	senderTrust: EmailSenderTrust;
	spamScore?: number | null;
	policy: InboundRoutingPolicy;
	/** Untrusted inbound messages to this tedi inside the rate window. */
	recentUntrustedCount: number;
}): EmailIngressDecision {
	if (
		typeof input.spamScore === "number" &&
		input.spamScore >= input.policy.spamThreshold
	) {
		return "quarantine";
	}
	if (input.senderTrust === "trusted") return "deliver";
	if (input.policy.untrustedSenders === "quarantine") return "quarantine";
	if (input.recentUntrustedCount > INBOUND_EMAIL_POLICY.untrustedRateLimit) {
		return "quarantine";
	}
	return "deliver";
}
