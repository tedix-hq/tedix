import { describe, expect, it } from "vite-plus/test";
import { appIconCandidates, domainFaviconUrl, usableLogoUrl } from "./app-icon";

const OWN = "https://cdn.example/own.png";
const BASE = "https://cdn.example/base.png";
const PROVIDER = "https://cdn.example/provider.png";
const FAVICON = "https://www.google.com/s2/favicons?domain=acme.example&sz=128";

describe("appIconCandidates", () => {
	it("orders own, inherited, provider, then domain favicon", () => {
		expect(
			appIconCandidates({
				logoUrl: OWN,
				inheritedLogoUrl: BASE,
				providerLogoUrl: PROVIDER,
				domain: "acme.example",
			}),
		).toEqual([OWN, BASE, PROVIDER, FAVICON]);
	});

	it("falls through each missing source", () => {
		expect(
			appIconCandidates({ inheritedLogoUrl: BASE, domain: "acme.example" }),
		).toEqual([BASE, FAVICON]);
		expect(
			appIconCandidates({ logoUrl: " ", providerLogoUrl: PROVIDER }),
		).toEqual([PROVIDER]);
		expect(appIconCandidates({ domain: "https://acme.example/docs" })).toEqual([
			FAVICON,
		]);
	});

	it("is empty when nothing renders, so the caller shows letters", () => {
		expect(
			appIconCandidates({
				logoUrl: "javascript:alert(1)",
				inheritedLogoUrl: "not a url",
				providerLogoUrl: null,
				domain: "localhost",
			}),
		).toEqual([]);
	});

	it("drops duplicates so a failed image is not retried", () => {
		expect(appIconCandidates({ logoUrl: OWN, inheritedLogoUrl: OWN })).toEqual([
			OWN,
		]);
	});
});

describe("logo helpers", () => {
	it("keeps data images and http(s) URLs only", () => {
		expect(usableLogoUrl("data:image/png;base64,AAAA")).toBe(
			"data:image/png;base64,AAAA",
		);
		expect(usableLogoUrl("ftp://cdn.example/a.png")).toBeNull();
	});

	it("builds a favicon from a bare domain or a URL", () => {
		expect(domainFaviconUrl("acme.example")).toBe(FAVICON);
		expect(domainFaviconUrl(null)).toBeNull();
	});
});
