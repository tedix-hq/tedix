import { describe, expect, it } from "vite-plus/test";
import {
	DEFAULT_EMBEDDED_LOCALE,
	escapeEmbeddedHtml,
	normalizeEmbeddedLocale,
	resolveEmbeddedTranslation,
	normalizeEmbeddedPageContext,
	safeEmbeddedAccent,
	safeEmbeddedHostRoute,
	safeEmbeddedImageUrl,
} from "./host-boundary";

describe("embedded host boundary", () => {
	it("escapes markup and restricts branding inputs", () => {
		expect(escapeEmbeddedHtml('<img src=x onerror="steal()">')).toBe(
			"&lt;img src=x onerror=&quot;steal()&quot;&gt;",
		);
		expect(safeEmbeddedAccent("#0a7")).toBe("#0a7");
		expect(
			safeEmbeddedAccent("red; background:url(https://evil.example)"),
		).toBe("#2557d6");
		expect(safeEmbeddedImageUrl("/brand.svg", "https://customer.example")).toBe(
			"https://customer.example/brand.svg",
		);
		expect(
			safeEmbeddedImageUrl(
				"data:image/svg+xml,evil",
				"https://customer.example",
			),
		).toBeNull();
	});

	it("bounds host context without treating it as authority", () => {
		const context = normalizeEmbeddedPageContext(
			{
				pathname: "/orders?state=open",
				title: `  ${"T".repeat(250)}  `,
				sections: Array.from(
					{ length: 20 },
					(_, index) => ` Section ${index} `,
				),
				entity: { type: "order", id: "123", label: "Repair" },
				event: {
					name: "order.opened",
					metadata: { safe: true, note: "n".repeat(300), "bad key": "drop" },
				},
			},
			"/fallback",
		);
		expect(context.pathname).toBe("/orders?state=open");
		expect(context.title).toHaveLength(200);
		expect(context.sections).toHaveLength(12);
		expect(context.entity).toEqual({
			type: "order",
			id: "123",
			label: "Repair",
		});
		expect(context.event?.metadata).toEqual({
			safe: true,
			note: "n".repeat(160),
		});
	});

	it("fails closed for privileged, cross-origin, and protocol-relative routes", () => {
		const origin = "https://customer.example";
		expect(safeEmbeddedHostRoute("/orders/1?tab=work#note", origin)).toBe(
			"/orders/1?tab=work#note",
		);
		for (const value of [
			null,
			undefined,
			"",
			"null",
			"undefined",
			"https://evil.example/orders/1",
			"//evil.example/orders/1",
			"/api/admin",
			"/auth/logout",
			"/widgets/mcp",
		]) {
			expect(safeEmbeddedHostRoute(value, origin)).toBeNull();
		}
	});
});

describe("normalizeEmbeddedLocale", () => {
	it("keeps a valid tag exactly as the host wrote it", () => {
		for (const tag of ["en-US", "es-MX", "en", "EN-us", "zh-Hans-CN"]) {
			expect(normalizeEmbeddedLocale(tag)).toBe(tag);
		}
	});

	/**
	 * The reachable crash: the mount path's `locale || … || "en-US"` chain only
	 * rejects falsy input, so a truthy non-string reaches `.toLowerCase()` and
	 * throws TypeError before the widget renders anything.
	 */
	it("falls back for a truthy non-string the || chain lets through", () => {
		for (const value of [123, {}, [], true, () => "en"]) {
			expect(normalizeEmbeddedLocale(value)).toBe(DEFAULT_EMBEDDED_LOCALE);
		}
	});

	/**
	 * `en_US` with an underscore is the common host mistake; it is truthy, so it
	 * survives the fallback chain and throws RangeError inside Intl.
	 */
	it("falls back for a structurally invalid tag", () => {
		for (const tag of ["en_US", "x", "", "   ", "e n"]) {
			expect(normalizeEmbeddedLocale(tag)).toBe(DEFAULT_EMBEDDED_LOCALE);
		}
	});

	it("honors an explicit fallback", () => {
		expect(normalizeEmbeddedLocale("en_US", "es-MX")).toBe("es-MX");
		expect(normalizeEmbeddedLocale(null, "es-MX")).toBe("es-MX");
	});

	/** Every result must be safe for the two calls that were throwing. */
	it("returns something Intl and toLowerCase both accept", () => {
		for (const value of [123, "en_US", "", null, undefined, "es-MX", {}]) {
			const locale = normalizeEmbeddedLocale(value);
			expect(() => locale.toLowerCase()).not.toThrow();
			expect(
				() => new Intl.DateTimeFormat(locale, { month: "short" }),
			).not.toThrow();
		}
	});
});

describe("resolveEmbeddedTranslation", () => {
	const bundles = {
		"en-US": { title: "Assistant" },
		es: { title: "Asistente" },
	};

	it("prefers an exact tag, case-insensitively", () => {
		expect(resolveEmbeddedTranslation(bundles, "EN-us")).toEqual({
			title: "Assistant",
		});
	});

	it("falls back to the base language", () => {
		expect(resolveEmbeddedTranslation(bundles, "es-MX")).toEqual({
			title: "Asistente",
		});
	});

	it("returns an empty bundle when nothing matches", () => {
		expect(resolveEmbeddedTranslation(bundles, "de-DE")).toEqual({});
	});

	it("tolerates junk in place of a bundle map", () => {
		for (const value of [null, undefined, "nope", 42]) {
			expect(resolveEmbeddedTranslation(value, "en-US")).toEqual({});
		}
	});

	/** A non-object entry must not be handed back for property access. */
	it("refuses a non-object bundle entry", () => {
		expect(
			resolveEmbeddedTranslation({ "en-US": "Assistant" }, "en-US"),
		).toEqual({});
	});

	/**
	 * An invalid locale must not throw. It normalizes to the default tag first,
	 * so the host gets the default language's bundle rather than nothing.
	 */
	it("resolves an invalid locale through the default tag", () => {
		expect(resolveEmbeddedTranslation(bundles, "en_US")).toEqual({
			title: "Assistant",
		});
		expect(resolveEmbeddedTranslation(bundles, 123 as never)).toEqual({
			title: "Assistant",
		});
	});
});
