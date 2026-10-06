import { describe, expect, it, vi } from "vite-plus/test";
import { sendTransactionalEmail } from "./email";

describe("sendTransactionalEmail", () => {
	it("sends through the Cloudflare Email Service builder overload", async () => {
		const send = vi.fn(async () => ({ messageId: "cf-email-123" }));
		const email = { send } as unknown as SendEmail;

		const result = await sendTransactionalEmail(
			{ EMAIL: email },
			{
				from: { name: "CTO Tedi", email: "cto@tedix.tech" },
				to: [{ name: "Ada Lovelace", email: "customer@example.com" }],
				cc: [{ email: "ops@example.com" }],
				bcc: [{ name: "Audit", email: "audit@example.com" }],
				subject: "Hello",
				html: "<p>Hello <strong>Ada</strong></p>",
				replyTo: { name: "CTO Desk", email: "reply@example.com" },
				headers: {
					"Message-ID": "<message-1@cto.tedix.tech>",
					References: "<root@example.com>",
				},
			},
		);

		expect(send).toHaveBeenCalledWith({
			from: { name: "CTO Tedi", email: "cto@tedix.tech" },
			to: [{ name: "Ada Lovelace", email: "customer@example.com" }],
			cc: ["ops@example.com"],
			bcc: [{ name: "Audit", email: "audit@example.com" }],
			subject: "Hello",
			text: "Hello Ada",
			html: "<p>Hello <strong>Ada</strong></p>",
			replyTo: { name: "CTO Desk", email: "reply@example.com" },
			headers: {
				"Message-ID": "<message-1@cto.tedix.tech>",
				References: "<root@example.com>",
			},
		});
		expect(result).toEqual({
			ok: true,
			sent: true,
			messageId: "cf-email-123",
			provider: "cloudflare",
		});
	});

	it("reports a missing EMAIL binding without attempting delivery", async () => {
		await expect(
			sendTransactionalEmail(
				{},
				{
					from: { name: "CTO Tedi", email: "cto@tedix.tech" },
					to: [{ email: "customer@example.com" }],
					subject: "Hello",
					text: "Hello Ada",
				},
			),
		).resolves.toEqual({
			ok: false,
			sent: false,
			reason: "EMAIL binding unavailable",
			provider: "cloudflare",
		});
	});

	it("returns a discriminated failure with the provider reason", async () => {
		const send = vi.fn(async () => {
			throw new Error("recipient rejected");
		});
		const email = { send } as unknown as SendEmail;

		const result = await sendTransactionalEmail(
			{ EMAIL: email },
			{
				from: { email: "cto@tedix.tech" },
				to: [{ email: "customer@example.com" }],
				subject: "Hello",
				text: "Hello Ada",
			},
		);

		expect(result).toEqual({
			ok: false,
			sent: false,
			reason: "recipient rejected",
			provider: "cloudflare",
		});
	});
});
