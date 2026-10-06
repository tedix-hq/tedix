import { describe, expect, it, vi } from "vite-plus/test";

const workerEnv = vi.hoisted(() => ({
	DEFAULT_LOCALE: "es",
	ORG_SLUG: "garage",
	PUBLIC_SITE_URL: "https://garage.example.test",
}));

vi.mock("cloudflare:workers", () => ({
	env: workerEnv,
}));

const getEmDashCollection = vi.hoisted(() =>
	vi.fn(async (type: string, filter: { locale: string }) => {
		const entries = {
			pages: {
				es: [
					{ id: "home", data: { id: "home", slug: "home", title: "Inicio" } },
					{
						id: "contact",
						data: { id: "contact", slug: "contact-us", title: "Contacto" },
					},
				],
				en: [
					{
						id: "en/home",
						data: { id: "home-en", slug: "home", title: "Home" },
					},
					{
						id: "en/privacy-policy",
						data: {
							id: "privacy-en",
							slug: "privacy-policy",
							title: "Privacy",
						},
					},
				],
				de: [],
			},
			posts: {
				es: [
					{
						id: "guide",
						data: {
							id: "guide",
							slug: "guide",
							title: "Guía",
							excerpt: "Un taller mejor",
						},
					},
					{
						id: "welcome",
						data: {
							id: "welcome",
							slug: "hola-mundo",
							title: "¡Hola Mundo!",
						},
					},
				],
				en: [
					{
						id: "en/guide",
						data: { id: "guide-en", slug: "guide", title: "Guide" },
					},
				],
				de: [],
			},
		};
		return {
			entries:
				entries[type as "pages" | "posts"][
					filter.locale as "es" | "en" | "de"
				] ?? [],
		};
	}),
);

const getEmDashEntry = vi.hoisted(() =>
	vi.fn(async (_type: string, id: string) => {
		const details: Record<
			string,
			{ id: string; data: Record<string, unknown> }
		> = {
			home: { id: "home", data: { slug: "home", title: "Inicio" } },
			contact: {
				id: "contact",
				data: { slug: "contact-us", title: "Contacto" },
			},
			"home-en": { id: "home-en", data: { slug: "home", title: "Home" } },
			"privacy-en": {
				id: "privacy-en",
				data: {
					slug: "privacy-policy",
					title: "Privacy",
					seo: { noIndex: true },
				},
			},
			guide: {
				id: "guide",
				data: { slug: "guide", title: "Guía", excerpt: "Un taller mejor" },
			},
			welcome: {
				id: "welcome",
				data: {
					slug: "hola-mundo",
					title: "¡Hola Mundo!",
					seo: { noIndex: true },
				},
			},
			"guide-en": { id: "guide-en", data: { slug: "guide", title: "Guide" } },
		};
		return { entry: details[id] ?? null };
	}),
);

vi.mock("emdash", () => ({
	getEmDashCollection,
	getEmDashEntry,
	getI18nConfig: () => ({ defaultLocale: "es", locales: ["es", "en", "de"] }),
	getSiteSettings: async () => ({
		title: "Garage",
		tagline: "Software para talleres",
	}),
	getCollectionInfo: async (collection: string) => ({
		urlPattern: collection === "posts" ? "/posts/{slug}" : "/{slug}",
	}),
}));

import { GET } from "../templates/marketing/src/pages/llms.txt";

describe("marketing llms.txt", () => {
	it("keeps the archived Tedix overview scoped to tedix.dev", async () => {
		workerEnv.PUBLIC_SITE_URL = "https://tedix.dev";
		getEmDashCollection.mockClear();
		try {
			const response = await GET({} as never);
			const body = await response.text();
			expect(response.headers.get("content-type")).toBe(
				"text/markdown; charset=utf-8",
			);
			expect(body).toContain(
				"> Tedix is a platform for autonomous digital workers (tedis)",
			);
			expect(body).toContain(
				"## Blog\n\n- [Blog](https://blog.tedix.dev/posts/)",
			);
			expect(body).toContain("## Platform");
			expect(body).toContain("## MCP Apps");
			expect(body).not.toContain("## Pages (");
			expect(getEmDashCollection).not.toHaveBeenCalled();
		} finally {
			workerEnv.PUBLIC_SITE_URL = "https://garage.example.test";
		}
	});

	it("lists published indexable content in every populated locale with public URLs", async () => {
		const response = await GET({
			locals: { org: { siteTitle: "Fallback" } },
		} as never);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain("## Pages (es)");
		expect(body).toContain("[Inicio](https://garage.example.test/)");
		expect(body).toContain("[Home](https://garage.example.test/en/)");
		expect(body).toContain(
			"[Contacto](https://garage.example.test/contact-us)",
		);
		expect(body).toContain("https://garage.example.test/posts/guide.md");
		expect(body).toContain("https://garage.example.test/en/posts/guide.md");
		expect(body).not.toContain("¡Hola Mundo!");
		expect(body).not.toContain("Privacy");
		expect(body).not.toContain("(de)");
		expect(getEmDashCollection).toHaveBeenCalledTimes(6);
		expect(getEmDashEntry).toHaveBeenCalledTimes(7);
		expect(getEmDashEntry).toHaveBeenCalledWith("posts", "guide-en", {
			locale: "en",
		});
	});
});
