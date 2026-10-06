import { describe, expect, it, vi } from "vite-plus/test";
import { fetchWidgetBranding, mergeWidgetBranding } from "./branding";

function jsonResponse(body: unknown, ok = true) {
	return {
		ok,
		json: async () => body,
	} as unknown as Response;
}

describe("mergeWidgetBranding", () => {
	it("applies published branding under its boot-option names", () => {
		expect(
			mergeWidgetBranding(
				{},
				{},
				{ title: "Acme Bot", accentColor: "#1594c7" },
			),
		).toEqual({ title: "Acme Bot", accent: "#1594c7" });
	});

	it("never overrides an explicit boot option", () => {
		expect(
			mergeWidgetBranding({ title: "Host" }, {}, { title: "Console" }).title,
		).toBe("Host");
	});

	it("never overrides an explicit data attribute", () => {
		const merged = mergeWidgetBranding(
			{},
			{ tedixAccent: "#000000", tedixTitle: "Host" },
			{ accentColor: "#ffffff", title: "Console", product: "Acme" },
		);
		expect(merged.accent).toBeUndefined();
		expect(merged.title).toBeUndefined();
		// A key the host did not set still comes from the console.
		expect(merged.product).toBe("Acme");
	});

	it("ignores null, undefined and a missing payload", () => {
		expect(mergeWidgetBranding({ a: 1 }, {}, null)).toEqual({ a: 1 });
		expect(
			mergeWidgetBranding({}, {}, { title: null, subtitle: undefined }),
		).toEqual({});
	});
});

describe("fetchWidgetBranding", () => {
	it("reads the published branding for a tenant", async () => {
		const request = vi.fn(async (_url: string, _init?: RequestInit) =>
			jsonResponse({ branding: { title: "Acme Bot" } }),
		);
		expect(
			await fetchWidgetBranding({
				tenant: "acme",
				origin: "https://api.tedix.dev",
				fetch: request as unknown as typeof fetch,
			}),
		).toEqual({ title: "Acme Bot" });
		expect(request).toHaveBeenCalledWith(
			"https://api.tedix.dev/widget/branding/acme",
			expect.objectContaining({ method: "GET" }),
		);
		// No `cache` mode at all: forcing revalidation here put a round trip in
		// front of every first paint.
		expect(request.mock.calls[0]?.[1]).not.toHaveProperty("cache");
	});

	it("carries the API effective locale alongside its catalog through the merge", async () => {
		const branding = await fetchWidgetBranding({
			tenant: "provider",
			origin: "https://api.tedix.dev",
			locale: "de-AT",
			fetch: vi.fn(async () =>
				jsonResponse({
					branding: { locale: "es-MX", title: "Assistant" },
					locale: "de-AT",
					catalog: { approve: "Genehmigen" },
				}),
			) as unknown as typeof fetch,
		});
		const options = mergeWidgetBranding({}, {}, branding);
		expect(options.locale).toBe("de-AT");
		expect(options.catalog).toEqual({ approve: "Genehmigen" });
	});

	it("refuses a tenant that is not a slug", async () => {
		const request = vi.fn();
		expect(
			await fetchWidgetBranding({
				tenant: "../admin",
				origin: "https://api.tedix.dev",
				fetch: request as unknown as typeof fetch,
			}),
		).toBeNull();
		expect(request).not.toHaveBeenCalled();
	});

	it("treats every failure as unbranded rather than as an outage", async () => {
		const cases: (() => Promise<Response>)[] = [
			async () => {
				throw new Error("network");
			},
			async () => jsonResponse({}, false),
			async () => jsonResponse({ branding: "nope" }),
			async () => jsonResponse({ branding: ["nope"] }),
			async () => jsonResponse(null),
		];
		for (const request of cases)
			expect(
				await fetchWidgetBranding({
					tenant: "acme",
					origin: "https://api.tedix.dev",
					fetch: request as unknown as typeof fetch,
				}),
			).toBeNull();
	});
});
