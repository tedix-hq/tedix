import { describe, expect, it } from "vite-plus/test";
import {
	decideIngress,
	evaluateSenderTrust,
	INBOUND_EMAIL_POLICY,
	parseInboundRoutingPolicy,
} from "./inbound-email-policy";

const pass = {
	dkim: "pass" as const,
	dmarc: "pass" as const,
	spf: "pass" as const,
	dkimDomain: "example.com",
	dmarcDomain: "example.com",
};
const none = {
	dkim: "none" as const,
	dmarc: "none" as const,
	spf: "none" as const,
};

describe("inbound email sender trust", () => {
	it("trusts an organization member only with an aligned DKIM or DMARC pass", () => {
		const base = {
			fromEmail: "Ada@Example.com",
			policy: parseInboundRoutingPolicy(null),
			isOrganizationMember: true,
			isOrganizationTediAddress: false,
		};
		expect(evaluateSenderTrust({ ...base, authResults: pass })).toBe("trusted");
		expect(
			evaluateSenderTrust({
				...base,
				authResults: { ...none, dmarc: "pass", dmarcDomain: "example.com" },
			}),
		).toBe("trusted");
		expect(evaluateSenderTrust({ ...base, authResults: none })).toBe(
			"untrusted",
		);
		expect(evaluateSenderTrust(base)).toBe("untrusted");
		// A pass for an unrelated domain does not vouch for the From line.
		expect(
			evaluateSenderTrust({
				...base,
				authResults: {
					...pass,
					dkimDomain: "evil.net",
					dmarcDomain: "evil.net",
				},
			}),
		).toBe("untrusted");
	});

	it("honors @domain allowlist entries only for that domain's own signature", () => {
		const policy = parseInboundRoutingPolicy({
			allowedSenders: ["@login.example-idp.test", "Partner@Vendor.example"],
		});
		const stranger = {
			policy,
			isOrganizationMember: false,
			isOrganizationTediAddress: false,
		};
		expect(
			evaluateSenderTrust({
				...stranger,
				fromEmail: "noreply@login.example-idp.test",
				authResults: {
					...none,
					dkim: "pass",
					dkimDomain: "login.example-idp.test",
				},
			}),
		).toBe("trusted");
		expect(
			evaluateSenderTrust({
				...stranger,
				fromEmail: "noreply@login.example-idp.test",
				authResults: { ...none, dkim: "pass", dkimDomain: "attacker.com" },
			}),
		).toBe("untrusted");
		expect(
			evaluateSenderTrust({
				...stranger,
				fromEmail: "partner@vendor.example",
				authResults: { ...none, dmarc: "pass", dmarcDomain: "vendor.example" },
			}),
		).toBe("trusted");
		expect(
			evaluateSenderTrust({
				...stranger,
				fromEmail: "other@vendor.example",
				authResults: { ...none, dmarc: "pass", dmarcDomain: "vendor.example" },
			}),
		).toBe("untrusted");
	});
});

describe("inbound email ingress decision", () => {
	const policy = parseInboundRoutingPolicy(null);

	it("quarantines at the spam threshold regardless of trust", () => {
		expect(
			decideIngress({
				senderTrust: "trusted",
				spamScore: INBOUND_EMAIL_POLICY.spamThreshold,
				policy,
				recentUntrustedCount: 0,
			}),
		).toBe("quarantine");
		expect(
			decideIngress({
				senderTrust: "untrusted",
				spamScore: 2,
				policy: parseInboundRoutingPolicy({ spamThreshold: 2 }),
				recentUntrustedCount: 0,
			}),
		).toBe("quarantine");
	});

	it("delivers untrusted mail by default but respects the per-address policy and rate limit", () => {
		expect(
			decideIngress({
				senderTrust: "untrusted",
				spamScore: 1,
				policy,
				recentUntrustedCount: INBOUND_EMAIL_POLICY.untrustedRateLimit,
			}),
		).toBe("deliver");
		expect(
			decideIngress({
				senderTrust: "untrusted",
				policy,
				recentUntrustedCount: INBOUND_EMAIL_POLICY.untrustedRateLimit + 1,
			}),
		).toBe("quarantine");
		expect(
			decideIngress({
				senderTrust: "untrusted",
				policy: parseInboundRoutingPolicy({ untrustedSenders: "quarantine" }),
				recentUntrustedCount: 0,
			}),
		).toBe("quarantine");
		expect(
			decideIngress({
				senderTrust: "trusted",
				policy: parseInboundRoutingPolicy({ untrustedSenders: "quarantine" }),
				recentUntrustedCount: 100,
			}),
		).toBe("deliver");
	});
});
