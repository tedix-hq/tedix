import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("agents", () => ({
	routeAgentEmail: vi.fn(),
}));

vi.mock("agents/email", () => ({
	createSecureReplyEmailResolver: vi.fn(),
}));

import {
	createEmailHeaderReader,
	decodeMimeHeader,
	extractEmailRecipient,
	extractEmailRecipients,
	parseInboundEmail,
} from "../src/email-ingress";

describe("email header parsing", () => {
	it("decodes RFC 2047 encoded subjects", () => {
		expect(
			decodeMimeHeader(
				"=?utf-8?B?W3RlZGl4LWVtYWlsLWUyZS0xNzc5MTM2NjUwOTQ5XSBDVE8gdG8gQ0VP?=",
			),
		).toBe("[tedix-email-e2e-1779136650949] CTO to CEO");
	});

	it("falls back to raw MIME headers when the Worker header map is incomplete", () => {
		const rawBody = [
			"From: CTO <cto@tedix.tech>",
			"Subject: Tedix local binding validation",
			" mcp-local-send-after-binding-1780348378575",
			'To: "CEO Tedi" <ceo@tedix.tech>',
			"Message-ID: <local-subject-test@tedix.tech>",
			"",
			"Hello CEO.",
		].join("\r\n");
		const reader = createEmailHeaderReader(new Headers(), rawBody);

		expect(reader("subject")).toBe(
			"Tedix local binding validation mcp-local-send-after-binding-1780348378575",
		);
		expect(reader("to")).toBe('"CEO Tedi" <ceo@tedix.tech>');
		expect(reader("message-id")).toBe("<local-subject-test@tedix.tech>");
	});

	it("extracts the usable address from display headers", () => {
		expect(extractEmailRecipient('"CTO (Tedi)" <cto@tedix.tech>').email).toBe(
			"cto@tedix.tech",
		);
		expect(extractEmailRecipient('"Ada Lovelace" <Ada@Example.COM>')).toEqual({
			email: "ada@example.com",
			name: "Ada Lovelace",
		});
		expect(
			extractEmailRecipients('"Ops Team" <ops@example.com>, audit@example.com'),
		).toEqual([
			{ email: "ops@example.com", name: "Ops Team" },
			{ email: "audit@example.com" },
		]);
	});

	it("strips raw message headers from plain text bodies", () => {
		expect(
			parseInboundEmail(
				[
					"Content-Type: text/plain; charset=utf-8",
					"Content-Transfer-Encoding: quoted-printable",
					"",
					"Hello CEO=2C",
					"This is the readable body.",
				].join("\r\n"),
			).text,
		).toBe("Hello CEO,\r\nThis is the readable body.");
	});

	it("does not quoted-printable decode non-encoded plain text bodies", () => {
		expect(
			parseInboundEmail(
				[
					"Content-Type: text/plain; charset=utf-8",
					"",
					"Login token: https://os.tedix.dev/login?t=11fabfd05",
				].join("\r\n"),
			).text,
		).toBe("Login token: https://os.tedix.dev/login?t=11fabfd05");
	});

	it("extracts the text/plain part from multipart messages", () => {
		expect(
			parseInboundEmail(
				[
					'Content-Type: multipart/alternative; boundary="tedix-boundary"',
					"",
					"--tedix-boundary",
					"Content-Type: text/html; charset=utf-8",
					"",
					"<p>HTML fallback</p>",
					"--tedix-boundary",
					"Content-Type: text/plain; charset=utf-8",
					"",
					"Plain text wins.",
					"--tedix-boundary--",
				].join("\r\n"),
			).text,
		).toBe("Plain text wins.");
	});

	it("falls back to readable text from HTML-only messages", () => {
		expect(
			parseInboundEmail(
				[
					"Content-Type: multipart/alternative; boundary=tedix-boundary",
					"",
					"--tedix-boundary",
					"Content-Type: text/html; charset=utf-8",
					"",
					"<html><body><p>Hello CEO.</p><p>Reply soon.</p></body></html>",
					"--tedix-boundary--",
				].join("\r\n"),
			).text,
		).toBe("Hello CEO. Reply soon.");
	});

	it("keeps attachments out of the readable body and preserves metadata and bytes", () => {
		const parsed = parseInboundEmail(
			[
				'Content-Type: multipart/mixed; boundary="outer"',
				"",
				"--outer",
				"Content-Type: text/plain; charset=utf-8",
				"",
				"Please review the attached invoice.",
				"--outer",
				"Content-Type: application/pdf; name=invoice.pdf",
				"Content-Disposition: attachment; filename=invoice.pdf",
				"Content-Transfer-Encoding: base64",
				"Content-ID: <invoice-1>",
				"",
				"SGVsbG8=",
				"--outer--",
			].join("\r\n"),
		);

		expect(parsed.text).toBe("Please review the attached invoice.");
		expect(parsed.attachmentParts).toEqual([
			{ ...parsed.attachments[0], bytes: new TextEncoder().encode("Hello") },
		]);
		expect(parsed.attachments).toEqual([
			{
				contentId: "invoice-1",
				contentType: "application/pdf",
				disposition: "attachment",
				filename: "invoice.pdf",
				size: 5,
			},
		]);
	});
});
