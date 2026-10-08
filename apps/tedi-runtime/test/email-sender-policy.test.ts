import { describe, expect, it } from "vite-plus/test";
import {
	INBOUND_TRUST_HEADER,
	parseAuthenticationResults,
	stampInboundTrustOnHeaders,
	stampInboundTrustOnRawBytes,
} from "../src/email-sender-policy";

/** Header block Cloudflare Email Routing prepends (real shape, dummy signature). */
const cloudflareHeaderBlock = [
	"Received: from o1.em1.cloudflare.com (o1.em1.cloudflare.com [1.2.3.4]) by cloudflare-email.com (cloudflare) id 4f2a8c3e for <cto@tedix.tech>",
	"ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.i=@em1.cloudflare.com header.s=s1 header.b=DUMMYSIG; dmarc=pass header.from=em1.cloudflare.com policy.dmarc=reject; spf=none (mx.cloudflare.net: no SPF record for bounces@em1.cloudflare.com)",
	"Received-SPF: pass (mx.cloudflare.net: domain designates 1.2.3.4 as permitted sender) envelope-from=bounces@em1.cloudflare.com",
	"Authentication-Results: mx.cloudflare.net; dkim=pass header.i=@em1.cloudflare.com header.s=s1 header.b=DUMMYSIG; dmarc=pass header.from=em1.cloudflare.com policy.dmarc=reject; spf=none (mx.cloudflare.net: no SPF record for bounces@em1.cloudflare.com)",
	"X-CF-SpamH-Score: 1",
].join("\r\n");

function authenticationResultsOf(headerBlock: string): string[] {
	return headerBlock
		.split("\r\n")
		.filter((line) => /^authentication-results:/i.test(line))
		.map((line) => line.slice(line.indexOf(":") + 1).trim());
}

describe("Authentication-Results parsing", () => {
	it("reads the DKIM, DMARC and SPF verdicts from the Cloudflare header block", () => {
		expect(
			parseAuthenticationResults(
				authenticationResultsOf(cloudflareHeaderBlock),
			),
		).toEqual({
			dkim: "pass",
			dkimDomain: "em1.cloudflare.com",
			dmarc: "pass",
			dmarcDomain: "em1.cloudflare.com",
			spf: "none",
		});
		expect(
			parseAuthenticationResults([
				"mx.cloudflare.net;\r\n dkim=fail header.d=example.com;\r\n spf=pass (ok) smtp.mailfrom=bounce@example.com;\r\n dmarc=none",
			]),
		).toEqual({
			dkim: "fail",
			dkimDomain: "example.com",
			dmarc: "none",
			spf: "pass",
			spfDomain: "example.com",
		});
	});

	it("uses only the topmost header and ignores a sender-forged one", () => {
		const forged =
			"mx.cloudflare.net; dkim=pass header.d=login.example-idp.test; dmarc=pass header.from=login.example-idp.test";
		// Cloudflare's header is prepended, so a forged copy sits below it.
		expect(
			parseAuthenticationResults([
				...authenticationResultsOf(cloudflareHeaderBlock),
				forged,
			]),
		).toMatchObject({ dkimDomain: "em1.cloudflare.com" });
		// A message carrying only the sender's own header yields nothing.
		expect(
			parseAuthenticationResults([
				"mail.attacker.example; dkim=pass header.d=login.example-idp.test; dmarc=pass header.from=login.example-idp.test",
			]),
		).toBeUndefined();
		expect(parseAuthenticationResults([])).toBeUndefined();
	});
});

describe("inbound trust stamping", () => {
	it("strips a forged trust header from raw bytes and headers before stamping ours", () => {
		const raw = [
			"From: mallory@example.com",
			`${INBOUND_TRUST_HEADER.toUpperCase()}: trusted`,
			"Subject: forged",
			"X-Tedix-Inbound-Trust: trusted",
			"\tcontinued",
			"",
			`${INBOUND_TRUST_HEADER}: trusted`,
			"Body stays untouched.",
		].join("\r\n");
		const stamped = new TextDecoder().decode(
			stampInboundTrustOnRawBytes(new TextEncoder().encode(raw), "untrusted"),
		);
		const [headerBlock, body] = stamped.split("\r\n\r\n");
		expect(headerBlock?.split("\r\n")).toEqual([
			`${INBOUND_TRUST_HEADER}: untrusted`,
			"From: mallory@example.com",
			"Subject: forged",
		]);
		expect(body).toBe(
			`${INBOUND_TRUST_HEADER}: trusted\r\nBody stays untouched.`,
		);

		const headers = stampInboundTrustOnHeaders(
			new Headers({ "X-Tedix-Inbound-Trust": "trusted", subject: "forged" }),
			"untrusted",
		);
		expect(headers.get(INBOUND_TRUST_HEADER)).toBe("untrusted");
		expect(headers.get("subject")).toBe("forged");
	});

	it("stamps a verdict on a message without a header/body separator", () => {
		const stamped = new TextDecoder().decode(
			stampInboundTrustOnRawBytes(
				new TextEncoder().encode("Subject: bare"),
				"trusted",
			),
		);
		expect(stamped).toBe(`${INBOUND_TRUST_HEADER}: trusted\r\nSubject: bare`);
	});
});
