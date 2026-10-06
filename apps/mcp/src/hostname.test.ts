import { describe, expect, it } from "vite-plus/test";
import {
	extractAppFromHostname,
	getMcpBaseDomains,
	resolveRequestHostname,
} from "./hostname";

function envWithMcpUrl(mcpUrl: string): CloudflareEnv {
	return {
		MCP_URL: mcpUrl,
		ENVIRONMENT: mcpUrl.endsWith("tedix.dev") ? "production" : "development",
	} as unknown as CloudflareEnv;
}

describe("getMcpBaseDomains", () => {
	it("returns the MCP_URL host for production", () => {
		expect(getMcpBaseDomains(envWithMcpUrl("https://mcp.tedix.dev"))).toEqual([
			"mcp.tedix.dev",
		]);
	});

	it("returns the configured dev base domain", () => {
		expect(getMcpBaseDomains(envWithMcpUrl("https://mcp.tedix.tech"))).toEqual([
			"mcp.tedix.tech",
		]);
	});
});

describe("extractAppFromHostname", () => {
	const devEnv = envWithMcpUrl("https://mcp.tedix.tech");

	it("resolves a *.mcp.tedix.tech subdomain app", () => {
		expect(
			extractAppFromHostname("tedix-unified.mcp.tedix.tech", devEnv),
		).toEqual({
			type: "subdomain",
			appSlug: "tedix-unified",
		});
	});

	it("treats the configured dev base host as base_domain", () => {
		expect(extractAppFromHostname("mcp.tedix.tech", devEnv)).toEqual({
			type: "base_domain",
		});
	});

	it("routes the production-shaped OS service-binding host in remote development", () => {
		expect(
			extractAppFromHostname("tedix-unified.mcp.tedix.dev", devEnv),
		).toEqual({
			type: "subdomain",
			appSlug: "tedix-unified",
		});
	});

	it("does not add a Tedix production alias to a custom development domain", () => {
		const customEnv = {
			MCP_URL: "https://mcp.example.com",
			ENVIRONMENT: "development",
		} as unknown as CloudflareEnv;
		expect(
			extractAppFromHostname("tedix-unified.mcp.tedix.dev", customEnv),
		).toEqual({
			type: "custom",
			customDomain: "tedix-unified.mcp.tedix.dev",
		});
	});

	it("does not engage the dev domain in production", () => {
		const prodEnv = envWithMcpUrl("https://mcp.tedix.dev");
		expect(extractAppFromHostname("tedix.mcp.tedix.dev", prodEnv)).toEqual({
			type: "subdomain",
			appSlug: "tedix",
		});
		expect(extractAppFromHostname("tedix.mcp.tedix.tech", prodEnv)).toEqual({
			type: "custom",
			customDomain: "tedix.mcp.tedix.tech",
		});
	});
});

describe("isolated local MCP routing", () => {
	const local = envWithMcpUrl("http://localhost:3000");
	it("routes the local base and installed app host using canonical slug rules", () => {
		expect(extractAppFromHostname("localhost:3000", local)).toEqual({
			type: "base_domain",
		});
		expect(
			extractAppFromHostname("My-Local-Os-Unified.localhost:3000", local),
		).toEqual({ type: "subdomain", appSlug: "my-local-os-unified" });
	});
	it("does not reinterpret localhost in cloud or remote development", () => {
		for (const env of [
			envWithMcpUrl("https://mcp.tedix.dev"),
			envWithMcpUrl("https://mcp.tedix.tech"),
			{ ...local, ENVIRONMENT: "production" },
		]) {
			expect(extractAppFromHostname("acme.localhost", env)).toEqual({
				type: "custom",
				customDomain: "acme.localhost",
			});
		}
	});
	it("leaves malformed labels and unrelated custom domains out of local app routing", () => {
		for (const host of [
			"a.b.localhost",
			"-acme.localhost",
			"acme-.localhost",
			".localhost",
			`${"a".repeat(64)}.localhost`,
			"acme.example.com",
		]) {
			expect(extractAppFromHostname(host, local)).toEqual({
				type: "custom",
				customDomain: host,
			});
		}
	});
});

describe("resolveRequestHostname", () => {
	const url = new URL("http://127.0.0.1:8787/mcp");
	const dev = { ENVIRONMENT: "development" } as CloudflareEnv;
	const prod = { ENVIRONMENT: "production" } as CloudflareEnv;

	it("lets the documented X-Tedix-Host override win over the dev server's X-Forwarded-Host", () => {
		const headers = new Headers({
			host: "127.0.0.1:8787",
			"x-forwarded-host": "127.0.0.1:8787",
			"x-tedix-host": "pilot.localhost",
		});
		expect(resolveRequestHostname(headers, url, dev)).toBe("pilot.localhost");
	});

	it("keeps the proxy chain first in production", () => {
		const headers = new Headers({
			host: "mcp-worker.internal",
			"x-forwarded-host": "acme.mcp.tedix.dev",
			"x-tedix-host": "victim.mcp.tedix.dev",
		});
		expect(resolveRequestHostname(headers, url, prod)).toBe(
			"acme.mcp.tedix.dev",
		);
		headers.set("x-original-host", "globex.mcp.tedix.dev:443");
		expect(resolveRequestHostname(headers, url, prod)).toBe(
			"globex.mcp.tedix.dev",
		);
	});

	it("falls back to Host and then the URL when no routing header is set", () => {
		expect(
			resolveRequestHostname(
				new Headers({ host: "acme.mcp.tedix.tech" }),
				url,
				dev,
			),
		).toBe("acme.mcp.tedix.tech");
		expect(resolveRequestHostname(new Headers(), url, dev)).toBe("127.0.0.1");
	});
});
