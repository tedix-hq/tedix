import { describe, expect, it, vi } from "vite-plus/test";

const getOrganizationBySlug = vi.fn();
vi.mock("@tedix/db/client", () => ({ createDbClient: (db: unknown) => db }));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationBySlug: (...args: unknown[]) => getOrganizationBySlug(...args),
}));
const listToolInvocationLabelsForOrganization = vi.fn(async () => []);
vi.mock("@tedix/db/queries/tools", () => ({
	listToolInvocationLabelsForOrganization: (...args: unknown[]) =>
		listToolInvocationLabelsForOrganization(...(args as [])),
}));

const { handleWidgetBranding } = await import("./widget-branding");

const database = {} as D1Database;

const published = {
	version: 1,
	title: "Karbot",
	product: "Acme",
	accentColor: "#1594c7",
	launcherIconUrl: "https://www.acme.example/logo.png",
	conversationStarters: ["¿Qué necesita atención?"],
	// Never publishable: audience policy, funding and the tool projection.
	analyticsEnabled: true,
	webMcpProfile: { routes: [{ id: "orders", tools: ["acme.orders_list"] }] },
	audience: { mode: "selected", userIds: ["1743"] },
};

/** A stand-in for the colo cache, keyed the way the real one is: by URL. */
function edgeCache() {
	const entries = new Map<string, Response>();
	const pending: Promise<unknown>[] = [];
	const cache = {
		match: async (request: Request) => entries.get(request.url)?.clone(),
		put: async (request: Request, response: Response) => {
			entries.set(request.url, response);
		},
	};
	Object.defineProperty(globalThis, "caches", {
		value: { default: cache },
		configurable: true,
	});
	return {
		entries,
		settled: () => Promise.all(pending),
		for: (url: string, method = "GET") => ({
			request: new Request(url, { method }),
			waitUntil: (work: Promise<unknown>) => void pending.push(work),
		}),
	};
}

describe("handleWidgetBranding", () => {
	it("returns only the published branding allowlist", async () => {
		getOrganizationBySlug.mockResolvedValue({
			metadata: { tediWidget: published },
		});
		const body = (await (
			await handleWidgetBranding("acme", database)
		).json()) as { branding: Record<string, unknown>; version: number };

		expect(body.branding.title).toBe("Karbot");
		expect(body.branding.launcherIconUrl).toBe(
			"https://www.acme.example/logo.png",
		);
		expect(body.branding.conversationStarters).toEqual([
			"¿Qué necesita atención?",
		]);
		expect(body.version).toBe(1);
		expect(body.branding.webMcpProfile).toBeUndefined();
		expect(body.branding.audience).toBeUndefined();
		expect(body.branding.analyticsEnabled).toBeUndefined();
	});

	it("publishes the tenant's own words for each tool, and only those", async () => {
		getOrganizationBySlug.mockResolvedValue({
			id: "org-1",
			metadata: { tediWidget: published },
		});
		listToolInvocationLabelsForOrganization.mockResolvedValueOnce([
			{
				toolId: "search_orders",
				invocationStatus: { invoking: " Revisando órdenes… ", invoked: "" },
			},
			// Authored as blank on both sides: the widget must fall back to its
			// generic product line rather than publish an empty label.
			{ toolId: "list_parts", invocationStatus: { invoking: "  " } },
		] as never);
		const body = (await (
			await handleWidgetBranding("acme", database)
		).json()) as { toolLabels: Record<string, unknown> };

		expect(body.toolLabels).toEqual({
			search_orders: { invoking: "Revisando órdenes…" },
		});
	});

	it("serves the copy catalog for the visitor's language", async () => {
		getOrganizationBySlug.mockResolvedValue({
			metadata: { tediWidget: { locale: "es-MX" } },
		});
		const german = (await (
			await handleWidgetBranding("acme", database, "de-AT")
		).json()) as { locale: string; catalog: Record<string, string> };
		expect(german.locale).toBe("de-AT");
		expect(german.catalog.approve).toBe("Genehmigen");

		// With no hint, the tenant's configured locale decides.
		const configured = (await (
			await handleWidgetBranding("acme", database)
		).json()) as { locale: string; catalog: Record<string, string> };
		expect(configured.locale).toBe("es-MX");

		// An unshipped language reads in the source language, never in keys.
		const japanese = (await (
			await handleWidgetBranding("acme", database, "ja")
		).json()) as { locale: string; catalog: Record<string, string> };
		expect(japanese.locale).toBe("ja");
		expect(japanese.catalog.approve).toBe("Approve");
	});

	it("uses one locale for catalog and branding, falling back from invalid hints", async () => {
		getOrganizationBySlug.mockResolvedValue({
			metadata: { tediWidget: { locale: "es-MX" } },
		});
		for (const [hint, locale, approve] of [
			["de-AT", "de-AT", "Genehmigen"],
			["en_US", "es-MX", "Aprobar"],
			[undefined, "es-MX", "Aprobar"],
		]) {
			const body = (await (
				await handleWidgetBranding("acme", database, hint)
			).json()) as {
				locale: string;
				branding: { locale: string };
				catalog: Record<string, string>;
			};
			expect(body.locale).toBe(locale);
			expect(body.branding.locale).toBe(locale);
			expect(body.catalog.approve).toBe(approve);
		}
	});

	it("withholds starter prompts written in another language", async () => {
		getOrganizationBySlug.mockResolvedValue({
			metadata: {
				tediWidget: {
					locale: "es-MX",
					conversationStarters: ["¿Qué necesita atención hoy?"],
					translations: {
						"de-DE": { conversationStarters: ["Was ist offen?"] },
					},
				},
			},
		});
		const french = (await (
			await handleWidgetBranding("acme", database, "fr")
		).json()) as { branding: Record<string, unknown> };
		expect(french.branding.conversationStarters).toBeUndefined();

		// Localized suggestions stay in translations; never leak the base copy.
		const german = (await (
			await handleWidgetBranding("acme", database, "de")
		).json()) as { branding: Record<string, unknown> };
		expect(german.branding.conversationStarters).toBeUndefined();
		expect(german.branding.translations).toEqual({
			"de-DE": { conversationStarters: ["Was ist offen?"] },
		});

		// The tenant's own language keeps them too.
		const spanish = (await (
			await handleWidgetBranding("acme", database, "es-419")
		).json()) as { branding: Record<string, unknown> };
		expect(spanish.branding.conversationStarters).toHaveLength(1);
	});

	it("stays cacheable on the first-paint path and cross-origin readable", async () => {
		// An unconditional revalidation here is an unbranded launcher on every
		// page load: nothing can paint until this answers.
		getOrganizationBySlug.mockResolvedValue({ metadata: {} });
		const response = await handleWidgetBranding("acme", database);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Cache-Control")).toBe(
			"public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
		);
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("answers a repeat request from the colo cache instead of D1", async () => {
		// `s-maxage` alone is inert: Cloudflare does not CDN-cache a Worker's own
		// responses, so without this every visitor's first load woke apps/api.
		getOrganizationBySlug.mockResolvedValue({
			metadata: { tediWidget: published },
		});
		const cache = edgeCache();
		const url = "https://api.tedix.dev/widget/branding/acme?locale=es-MX";
		getOrganizationBySlug.mockClear();
		await handleWidgetBranding("acme", database, "es-MX", cache.for(url));
		await cache.settled();
		expect(getOrganizationBySlug).toHaveBeenCalledTimes(1);

		const second = await handleWidgetBranding(
			"acme",
			database,
			"es-MX",
			cache.for(url),
		);
		expect(getOrganizationBySlug).toHaveBeenCalledTimes(1);
		expect(
			((await second.json()) as { branding: Record<string, unknown> }).branding
				.title,
		).toBe("Karbot");
	});

	it("keys the cache by locale, not by tenant alone", async () => {
		getOrganizationBySlug.mockResolvedValue({
			metadata: { tediWidget: published },
		});
		const cache = edgeCache();
		getOrganizationBySlug.mockClear();
		await handleWidgetBranding(
			"acme",
			database,
			"es-MX",
			cache.for("https://api.tedix.dev/widget/branding/acme?locale=es-MX"),
		);
		await handleWidgetBranding(
			"acme",
			database,
			"de-DE",
			cache.for("https://api.tedix.dev/widget/branding/acme?locale=de-DE"),
		);
		await cache.settled();
		expect(getOrganizationBySlug).toHaveBeenCalledTimes(2);
		expect(cache.entries.size).toBe(2);
	});

	it("leaves the cache alone for a HEAD probe, which the Cache API rejects", async () => {
		getOrganizationBySlug.mockResolvedValue({
			metadata: { tediWidget: published },
		});
		const cache = edgeCache();
		const url = "https://api.tedix.dev/widget/branding/acme";
		await handleWidgetBranding("acme", database, undefined, cache.for(url));
		await cache.settled();
		getOrganizationBySlug.mockClear();
		await handleWidgetBranding(
			"acme",
			database,
			undefined,
			cache.for(url, "HEAD"),
		);
		expect(getOrganizationBySlug).toHaveBeenCalledTimes(1);
	});

	it("still answers when no execution context is available to cache with", async () => {
		getOrganizationBySlug.mockResolvedValue({ metadata: {} });
		const response = await handleWidgetBranding("acme", database);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(
			expect.objectContaining({ branding: {} }),
		);
	});

	it("answers an unknown or malformed tenant without disclosing either", async () => {
		getOrganizationBySlug.mockResolvedValue(undefined);
		for (const tenant of ["does-not-exist", "../admin", "", "A".repeat(80)]) {
			const response = await handleWidgetBranding(tenant, database);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(
				expect.objectContaining({ branding: {} }),
			);
		}
	});

	it("never queries the database for a malformed slug", async () => {
		getOrganizationBySlug.mockClear();
		await handleWidgetBranding("../admin", database);
		expect(getOrganizationBySlug).not.toHaveBeenCalled();
	});
});
