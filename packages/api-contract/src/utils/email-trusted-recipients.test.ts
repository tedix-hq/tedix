import { describe, expect, it } from "vite-plus/test";
import { EmailTrustedRecipientAddressSchema } from "../schemas/tedi-email";
import {
	decideAutonomousAction,
	humanReservedActionClasses,
} from "./approval-policy";
import {
	decideTrustedRecipientSend,
	normalizeTrustedRecipientAddress,
	trustedRecipientEmailAction,
	trustedRecipientSkipsCard,
} from "./email-trusted-recipients";

const TEDI = "tedi-reddit-operator";
const PARTNER = "partner-agent@mail.example.com";
const trusted = [{ tediId: TEDI, address: PARTNER, revokedAt: null }];

function decide(
	recipients: Parameters<typeof decideTrustedRecipientSend>[0]["recipients"],
	overrides: Partial<Parameters<typeof decideTrustedRecipientSend>[0]> = {},
) {
	return decideTrustedRecipientSend({
		senderTediId: TEDI,
		actingTediId: TEDI,
		recipients,
		trusted,
		...overrides,
	});
}

describe("decideTrustedRecipientSend", () => {
	it("allows a send when every to, cc and bcc address is trusted", () => {
		expect(
			decide({
				to: [{ email: PARTNER }],
				cc: [PARTNER],
				bcc: [{ email: PARTNER }],
			}),
		).toEqual({
			trusted: true,
			reason: "trusted recipient",
			addresses: [PARTNER],
		});
	});

	it("needs a card when any one recipient is untrusted", () => {
		for (const recipients of [
			{ to: [{ email: PARTNER }, { email: "someone@example.com" }] },
			{ to: [{ email: PARTNER }], cc: [{ email: "someone@example.com" }] },
			{ to: [{ email: PARTNER }], bcc: ["someone@example.com"] },
		]) {
			const decision = decide(recipients);
			expect(decision.trusted).toBe(false);
			expect(decision.reason).toBe("untrusted recipient: someone@example.com");
		}
	});

	it("needs a card for a revoked entry", () => {
		expect(
			decide(
				{ to: [PARTNER] },
				{
					trusted: [
						{
							tediId: TEDI,
							address: PARTNER,
							revokedAt: "2026-11-05T10:00:00Z",
						},
					],
				},
			).trusted,
		).toBe(false);
	});

	it("ignores another tedi's list", () => {
		expect(
			decide(
				{ to: [PARTNER] },
				{ trusted: [{ tediId: "other-tedi", address: PARTNER }] },
			).trusted,
		).toBe(false);
	});

	it("needs the caller to be the sending tedi", () => {
		expect(decide({ to: [PARTNER] }, { actingTediId: "other-tedi" })).toEqual(
			expect.objectContaining({
				trusted: false,
				reason: "caller is not the sending tedi",
			}),
		);
		expect(decide({ to: [PARTNER] }, { actingTediId: null }).trusted).toBe(
			false,
		);
		expect(
			decide({ to: [PARTNER] }, { senderTediId: null, actingTediId: null })
				.trusted,
		).toBe(false);
	});

	it("compares addresses case-insensitively", () => {
		expect(
			decide(
				{ to: ["  Partner-Agent@Mail.Example.COM "] },
				{
					trusted: [
						{ tediId: TEDI, address: "PARTNER-AGENT@mail.example.com" },
					],
				},
			),
		).toEqual({
			trusted: true,
			reason: "trusted recipient",
			addresses: [PARTNER],
		});
	});

	it("never treats wildcard or domain entries as a match", () => {
		for (const address of [
			"*@mail.example.com",
			"@mail.example.com",
			"mail.example.com",
			"*",
		]) {
			expect(
				decide({ to: [PARTNER] }, { trusted: [{ tediId: TEDI, address }] })
					.trusted,
			).toBe(false);
		}
		expect(
			decide(
				{ to: ["*@mail.example.com"] },
				{ trusted: [{ tediId: TEDI, address: "*@mail.example.com" }] },
			),
		).toEqual(
			expect.objectContaining({ trusted: false, reason: "invalid recipient" }),
		);
	});

	it("needs a card when there are no recipients", () => {
		expect(decide({}).reason).toBe("no recipients");
	});
});

describe("normalizeTrustedRecipientAddress", () => {
	it("keeps exact addresses only", () => {
		expect(normalizeTrustedRecipientAddress(" A.B+tag@Example.org ")).toBe(
			"a.b+tag@example.org",
		);
		for (const value of [
			"",
			"*@example.org",
			"a*b@example.org",
			"@example.org",
			"example.org",
			"Name <a@example.org>",
			"a@localhost",
			"a@@example.org",
		])
			expect(normalizeTrustedRecipientAddress(value)).toBeNull();
	});

	it("backs the stored-address schema", () => {
		expect(EmailTrustedRecipientAddressSchema.parse(" X@Example.org")).toBe(
			"x@example.org",
		);
		expect(
			EmailTrustedRecipientAddressSchema.safeParse("*@example.org").success,
		).toBe(false);
		expect(
			EmailTrustedRecipientAddressSchema.safeParse("@example.org").success,
		).toBe(false);
	});
});

describe("trusted recipient gate", () => {
	it("names the email send and reply actions", () => {
		expect(trustedRecipientEmailAction("tediEmail/sendEmail")).toBe("send");
		expect(trustedRecipientEmailAction("tediEmail/replyEmail")).toBe("reply");
		expect(trustedRecipientEmailAction("reply_to_email")).toBe("reply");
		expect(trustedRecipientEmailAction("tediEmail/listInbox")).toBeNull();
		expect(trustedRecipientEmailAction(undefined)).toBeNull();
	});

	it("classifies send and reply tools as external messages", () => {
		for (const name of [
			"tedis:tediEmail/sendEmail",
			"tedis:tediEmail/replyEmail",
			"reply_to_email",
			"echo__email_send",
		])
			expect(humanReservedActionClasses(name)).toEqual(["external_message"]);
	});

	it("skips the card only for a trusted send with no other reserved class", () => {
		const yes = { trusted: true };
		expect(
			trustedRecipientSkipsCard({
				reservedClasses: ["external_message"],
				decision: yes,
			}),
		).toBe(true);
		expect(
			trustedRecipientSkipsCard({
				reservedClasses: ["external_message", "money"],
				decision: yes,
			}),
		).toBe(false);
		expect(
			trustedRecipientSkipsCard({
				reservedClasses: ["external_message"],
				decision: { trusted: false },
			}),
		).toBe(false);
		expect(
			trustedRecipientSkipsCard({
				reservedClasses: ["external_message"],
				decision: null,
			}),
		).toBe(false);
	});

	it("lets decideAutonomousAction auto-approve only a trusted reply", () => {
		const base = { risk: "unknown" as const, content: "reply_to_email" };
		expect(decideAutonomousAction(base)).toEqual({
			autoApprove: false,
			reason: "human-reserved: external_message",
		});
		expect(
			decideAutonomousAction({
				...base,
				trustedRecipientSend: { trusted: true },
			}),
		).toEqual({ autoApprove: true, reason: "trusted recipient" });
		expect(
			decideAutonomousAction({
				...base,
				trustedRecipientSend: { trusted: false },
			}).autoApprove,
		).toBe(false);
		expect(
			decideAutonomousAction({
				...base,
				policy: { version: 1, maxRisk: "medium", askForClasses: ["*"] },
				classId: "native:reply_to_email",
				trustedRecipientSend: { trusted: true },
			}).autoApprove,
		).toBe(false);
		expect(
			decideAutonomousAction({
				...base,
				content: "reply_to_email and pay the invoice",
				trustedRecipientSend: { trusted: true },
			}).autoApprove,
		).toBe(false);
	});
});
