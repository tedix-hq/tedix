import {
	hashMcpEndpoint,
	normalizeMcpEndpoint,
} from "@tedix/db/queries/catalog/endpoint-normalization";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	evaluateExternalMcpCatalogGate,
	isTedixInternalMcpHost,
} from "./mcp-credential-catalog-gate";

const CATALOG_APP_ID = "catalog-app-1";
const LISTED_ENDPOINT = "https://mcp.example.com/mcp";

async function listedHash(): Promise<string> {
	const normalized = normalizeMcpEndpoint(LISTED_ENDPOINT);
	if (!normalized) throw new Error("normalization failed in test setup");
	return hashMcpEndpoint(normalized);
}

/** Catalog lookup that knows exactly one endpoint hash. */
async function singleRowLookup(hash: string): Promise<string | null> {
	return hash === (await listedHash()) ? CATALOG_APP_ID : null;
}

describe("MCP catalog-allowlist gate", () => {
	describe("Tedix-internal bypass", () => {
		// The retired staging domain must NOT bypass the catalog allowlist.
		// tedi.club serves nothing (zero Worker routes), so treating it as
		// internal would hand a free bypass to a name nobody controls a route
		// for. Falling through to the catalog check is the safe direction.
		it.each(["github.mcp.tedi.club", "cto.tedi.tedi.club"])(
			"does not treat retired %s as internal",
			(host) => {
				expect(isTedixInternalMcpHost(host)).toBe(false);
			},
		);

		it.each([
			"github.mcp.tedix.dev",
			"cto.tedi.tedix.dev",
			"github.mcp.tedix.tech",
			"github.mcp.localhost",
			"cto.tedi.localhost",
			"GitHub.MCP.Tedix.DEV",
		])("treats %s as internal", (host) => {
			expect(isTedixInternalMcpHost(host)).toBe(true);
		});

		it.each([
			"mcp.example.com",
			"evil.mcp.tedix.dev.attacker.com",
			"github.mcp.tedix.io",
			"mcp.tedix.dev",
			"deep.github.mcp.tedix.dev",
		])("treats %s as external", (host) => {
			expect(isTedixInternalMcpHost(host)).toBe(false);
		});

		it("bypasses the gate for internal hosts without a catalog lookup", async () => {
			const lookup = vi.fn(async () => null);
			const decision = await evaluateExternalMcpCatalogGate(
				"https://missing-app.mcp.tedix.dev/mcp",
				lookup,
			);
			expect(decision).toEqual({ kind: "internal" });
			expect(lookup).not.toHaveBeenCalled();
		});
	});

	describe("catalog hit", () => {
		it("allows an endpoint with a catalog row and returns its id", async () => {
			const decision = await evaluateExternalMcpCatalogGate(
				LISTED_ENDPOINT,
				singleRowLookup,
			);
			expect(decision).toEqual({
				kind: "allowed",
				catalogAppId: CATALOG_APP_ID,
				normalizedEndpoint: LISTED_ENDPOINT,
			});
		});

		it("looks up by the hash of the normalized endpoint", async () => {
			const lookup = vi.fn(async () => CATALOG_APP_ID);
			await evaluateExternalMcpCatalogGate(LISTED_ENDPOINT, lookup);
			expect(lookup).toHaveBeenCalledWith(await listedHash());
		});
	});

	describe("URL normalization", () => {
		it.each([
			["lowercases the host", "https://MCP.Example.COM/mcp"],
			["strips trailing slashes", "https://mcp.example.com/mcp///"],
			["strips the https default port", "https://mcp.example.com:443/mcp"],
			["strips fragments", "https://mcp.example.com/mcp#frag"],
			[
				"upgrades http to https with the port dropped",
				"http://mcp.example.com:443/mcp",
			],
		])("%s to match the catalog row", async (_label, variant) => {
			const decision = await evaluateExternalMcpCatalogGate(
				variant,
				singleRowLookup,
			);
			expect(decision).toEqual({
				kind: "allowed",
				catalogAppId: CATALOG_APP_ID,
				normalizedEndpoint: LISTED_ENDPOINT,
			});
		});

		it("does not match a different path", async () => {
			const decision = await evaluateExternalMcpCatalogGate(
				"https://mcp.example.com/other",
				singleRowLookup,
			);
			expect(decision).toMatchObject({ kind: "refused" });
		});

		it("does not let a routed tenant query match an unscoped catalog row", async () => {
			const decision = await evaluateExternalMcpCatalogGate(
				"https://mcp.example.com/mcp?tenant=a",
				singleRowLookup,
			);
			expect(decision).toMatchObject({
				kind: "refused",
				refusal: {
					endpoint: "https://mcp.example.com/mcp?tenant=a",
					reason: "not_in_catalog",
				},
			});
		});

		it("does not match a non-default port", async () => {
			const decision = await evaluateExternalMcpCatalogGate(
				"https://mcp.example.com:8443/mcp",
				singleRowLookup,
			);
			expect(decision).toMatchObject({ kind: "refused" });
		});
	});

	describe("catalog miss → typed fail-closed refusal", () => {
		it("refuses an external endpoint with no catalog row", async () => {
			const decision = await evaluateExternalMcpCatalogGate(
				"https://rogue.example.net/mcp",
				async () => null,
			);
			expect(decision).toEqual({
				kind: "refused",
				refusal: {
					endpoint: "https://rogue.example.net/mcp",
					reason: "not_in_catalog",
				},
			});
		});

		it("reports the normalized endpoint in the refusal", async () => {
			const decision = await evaluateExternalMcpCatalogGate(
				"https://Rogue.Example.NET:443/mcp/?x=1",
				async () => null,
			);
			expect(decision).toEqual({
				kind: "refused",
				refusal: {
					endpoint: "https://rogue.example.net/mcp?x=1",
					reason: "not_in_catalog",
				},
			});
		});

		it("refuses an unparseable URL without a catalog lookup", async () => {
			const lookup = vi.fn(async () => CATALOG_APP_ID);
			const decision = await evaluateExternalMcpCatalogGate(
				"not-a-url",
				lookup,
			);
			expect(decision).toEqual({
				kind: "refused",
				refusal: { endpoint: "not-a-url", reason: "invalid_url" },
			});
			expect(lookup).not.toHaveBeenCalled();
		});
	});
});
