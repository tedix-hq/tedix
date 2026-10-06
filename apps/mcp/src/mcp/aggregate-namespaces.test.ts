/**
 * `configuredAggregateNamespaces` is the evidence that a missing Code Mode
 * binding is an upstream hydration failure rather than a typo. It must agree
 * with the namespaces `filterAggregateAppsForCodeNamespaces` hydrates for —
 * including the prefix/override/peer-alias forms and the platform-operator
 * admin app's endpoint-derived namespaces.
 */

import { describe, expect, it } from "vite-plus/test";

import {
	aggregateAppNamespaceCandidates,
	aggregateTediNamespace,
	configuredAggregateNamespaces,
} from "./aggregate-namespaces";

describe("aggregateAppNamespaceCandidates", () => {
	it("sanitizes the slug and prefers an explicit prefix", () => {
		expect([
			...aggregateAppNamespaceCandidates({ slug: "descope-tedix" }),
		]).toEqual(["descope_tedix"]);
		expect([
			...aggregateAppNamespaceCandidates({
				slug: "descope-tedix",
				prefix: "descope_api_tedix",
			}),
		]).toEqual(["descope_api_tedix"]);
	});

	it("includes D1 codeModeNamespaces overrides", () => {
		const candidates = aggregateAppNamespaceCandidates(
			{ slug: "peec-tedix" },
			{ peec_tedix: "seo" },
		);
		expect(candidates.has("peec_tedix")).toBe(true);
		expect(candidates.has("seo")).toBe(true);
	});

	it("includes the peer alias so app/apps both hydrate the entry", () => {
		const candidates = aggregateAppNamespaceCandidates({ slug: "apps" });
		expect(candidates.has("apps")).toBe(true);
		expect(candidates.has("app")).toBe(true);
	});
});

describe("aggregateTediNamespace", () => {
	it("defaults to the slug and honours an explicit namespace", () => {
		expect(aggregateTediNamespace({ slug: "cto" })).toBe("cto");
		expect(
			aggregateTediNamespace({ slug: "client-engagement", namespace: "cro" }),
		).toBe("cro");
	});
});

describe("configuredAggregateNamespaces", () => {
	it("returns an empty set for an app with no aggregate config", () => {
		expect(configuredAggregateNamespaces(null).size).toBe(0);
		expect(configuredAggregateNamespaces({}).size).toBe(0);
	});

	it("collects app, tedi, override and alias namespaces", () => {
		const namespaces = configuredAggregateNamespaces({
			aggregateApps: [
				{ slug: "descope-api-tedix", prefix: "descope_api_tedix" },
				{ slug: "apps" },
			],
			aggregateTedis: [
				{ slug: "cto" },
				{ slug: "client-engagement", namespace: "cro" },
			],
			codeModeNamespaces: { apps: "app_surface" },
		});
		expect(namespaces.has("descope_api_tedix")).toBe(true);
		expect(namespaces.has("apps")).toBe(true);
		expect(namespaces.has("app")).toBe(true);
		expect(namespaces.has("app_surface")).toBe(true);
		expect(namespaces.has("cto")).toBe(true);
		expect(namespaces.has("cro")).toBe(true);
		expect(namespaces.has("nope")).toBe(false);
	});

	it("expands the platform-operator admin app to its endpoint-derived namespaces", () => {
		const namespaces = configuredAggregateNamespaces({
			aggregateApps: [{ slug: "tedix" }],
		});
		// Derived from endpoint prefixes ("tedis/list" → tedis), not from the slug.
		expect(namespaces.has("tedis")).toBe(true);
		expect(namespaces.has("workflows")).toBe(true);
	});

	it("includes the explicit D1 control-plane namespaces", () => {
		const namespaces = configuredAggregateNamespaces({
			aggregateApps: [{ slug: "tedix" }],
		});
		for (const namespace of ["organizations", "projects", "skills", "work"]) {
			expect(namespaces.has(namespace)).toBe(true);
		}
	});

	it("ignores malformed entries instead of throwing", () => {
		const namespaces = configuredAggregateNamespaces({
			aggregateApps: [{}, { slug: "" }, { slug: "good" }],
			aggregateTedis: "not-an-array",
		});
		expect(namespaces.has("good")).toBe(true);
		expect(namespaces.size).toBe(1);
	});
});
