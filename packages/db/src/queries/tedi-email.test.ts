import { describe, expect, it } from "vite-plus/test";
import {
	buildEmailPreview,
	normalizeEmailRecipient,
	normalizeEmailRecipients,
	normalizeEmailSubject,
} from "./tedi-email/recipients";

describe("tedi email helpers", () => {
	it("normalizes reply prefixes into a stable thread subject", () => {
		expect(normalizeEmailSubject(" Re: FWD:  Quarterly update  ")).toBe(
			"quarterly update",
		);
	});

	it("builds compact text previews from HTML-ish bodies", () => {
		expect(
			buildEmailPreview(
				"<style>.x{}</style><p>Hello <strong>Tedi</strong></p>",
			),
		).toBe("Hello Tedi");
		expect(
			buildEmailPreview(
				"<p>Hi</p><script>alert(1)</script ><STYLE>.x{}</style><p>there</p>",
			),
		).toBe("Hi there");
	});

	it("builds previews from hostile unclosed markup in linear time", () => {
		const started = performance.now();
		buildEmailPreview(`${"<style".repeat(20_000)}${"<".repeat(20_000)}`);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("normalizes named recipients while preserving display names", () => {
		expect(
			normalizeEmailRecipient({
				email: " Ada@Example.COM ",
				name: " Ada Lovelace ",
			}),
		).toEqual({ email: "ada@example.com", name: "Ada Lovelace" });
		expect(normalizeEmailRecipients(["Ops@Example.COM"])).toEqual([
			{ email: "ops@example.com" },
		]);
	});
});
