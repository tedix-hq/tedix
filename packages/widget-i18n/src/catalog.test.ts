import { describe, expect, it } from "vite-plus/test";
import { buildTranslate, interpolate } from "./catalog";
import { resolveWidgetCatalog, WIDGET_CATALOGS } from "./catalogs";

const source = WIDGET_CATALOGS.en as Record<string, string>;
const tokens = (value: string) =>
	[...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();

describe("shipped catalogs", () => {
	/**
	 * The drift this package exists to prevent: a new key reaches a customer as
	 * a raw identifier, or a translated string loses the placeholder that
	 * carries the product or assistant name.
	 */
	for (const [locale, catalog] of Object.entries(WIDGET_CATALOGS)) {
		it(`${locale} covers every source key with the same placeholders`, () => {
			const missing = Object.keys(source).filter((key) => !catalog[key]);
			expect(missing).toEqual([]);
			const drifted = Object.keys(source).filter(
				(key) =>
					String(tokens(source[key] as string)) !==
					String(tokens(catalog[key] as string)),
			);
			expect(drifted).toEqual([]);
		});

		it(`${locale} ships no key the source dropped`, () => {
			expect(Object.keys(catalog).filter((key) => !source[key])).toEqual([]);
		});
	}

	it("ships English as the source language", () => {
		expect(Object.keys(WIDGET_CATALOGS)).toContain("en");
	});
});

describe("resolveWidgetCatalog", () => {
	it("matches on the language subtag", () => {
		expect(resolveWidgetCatalog("es-MX").locale).toBe("es");
		expect(resolveWidgetCatalog("de_AT").locale).toBe("de");
		expect(resolveWidgetCatalog("DE").locale).toBe("de");
	});

	it("falls back to the source for an unshipped or absent locale", () => {
		expect(resolveWidgetCatalog("ja").locale).toBe("en");
		expect(resolveWidgetCatalog(undefined).locale).toBe("en");
		expect(resolveWidgetCatalog("../etc").locale).toBe("en");
	});
});

describe("buildTranslate", () => {
	it("reads the locale first and the source second", () => {
		const t = buildTranslate({ approve: "Genehmigen" }, source);
		expect(t("approve")).toBe("Genehmigen");
		expect(t("close")).toBe(source.close);
	});

	it("renders an unknown key as itself rather than as blank chrome", () => {
		expect(buildTranslate({}, {})("nope")).toBe("nope");
	});

	it("interpolates only the tokens it was given", () => {
		expect(interpolate("Hi {{name}} and {{other}}", { name: "Ana" })).toBe(
			"Hi Ana and {{other}}",
		);
	});

	it("keeps a tenant override above the shipped catalog", () => {
		const t = buildTranslate(
			{ ...WIDGET_CATALOGS.es, approve: "Autorizar" },
			source,
		);
		expect(t("approve")).toBe("Autorizar");
	});
});

describe("default params", () => {
	/**
	 * A capacity failure rendered the literal "{{assistant}} no tiene capacidad
	 * disponible" to a shop owner, because `userFacingChatError` called `t(key)`
	 * with no params while `t("ask", { assistant })` passed one. Any string may
	 * name the assistant, so the name is a default rather than a call-site duty.
	 */
	const t = buildTranslate(
		{
			error_capacity: "{{assistant}} has no capacity available right now.",
			ask: "Ask {{assistant}}…",
			plain: "No tokens here",
		},
		null,
		{ assistant: "Acme Assistant" },
	);

	it("applies when the call site passes no params", () => {
		expect(t("error_capacity")).toBe(
			"Acme Assistant has no capacity available right now.",
		);
		expect(t("ask")).toBe("Ask Acme Assistant…");
	});

	it("leaves a template with no tokens untouched", () => {
		expect(t("plain")).toBe("No tokens here");
	});

	it("lets an explicit param win", () => {
		expect(t("error_capacity", { assistant: "Tedi" })).toBe(
			"Tedi has no capacity available right now.",
		);
	});

	it("does not drop defaults when another param is passed", () => {
		const withExtra = buildTranslate(
			{ both: "{{assistant}} found {{count}}" },
			null,
			{ assistant: "Acme Assistant" },
		);
		expect(withExtra("both", { count: 7 })).toBe("Acme Assistant found 7");
	});

	it("keeps the old behaviour when no defaults are supplied", () => {
		const bare = buildTranslate(
			{ error_capacity: "{{assistant}} is busy" },
			null,
		);
		expect(bare("error_capacity")).toBe("{{assistant}} is busy");
	});

	it("interpolates every shipped string that names the assistant", () => {
		// The real regression surface: any catalog key carrying the token must
		// resolve through a translate built with the default.
		const named = buildTranslate(source, null, { assistant: "Acme" });
		for (const [key, value] of Object.entries(source)) {
			if (!value.includes("{{assistant}}")) continue;
			expect(named(key)).not.toContain("{{assistant}}");
		}
	});
});
