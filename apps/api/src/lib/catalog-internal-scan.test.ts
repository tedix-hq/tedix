import { describe, expect, it } from "vite-plus/test";
import {
	isTedixControlMcpEndpoint,
	isTedixTenantMcpEndpoint,
	resolveTedixInternalScanHeaders,
} from "./catalog-internal-scan";

describe("catalog first-party MCP scan auth", () => {
	it.each([
		"https://builder.tedix.dev/mcp",
		"https://docs-admin.tedix.dev/mcp?org=tedix",
	])("recognizes an exact Tedix control endpoint: %s", (endpoint) => {
		expect(isTedixControlMcpEndpoint(endpoint)).toBe(true);
	});

	it.each([
		"http://docs-admin.tedix.dev/mcp",
		"https://docs-admin.tedix.dev/not-mcp",
		"https://studio.tedix.dev/mcp",
		"https://studio.tedix.tech/mcp",
		"https://attacker.example/mcp",
		"https://docs-admin.tedix.dev.attacker.example/mcp",
	])("rejects an untrusted scan endpoint: %s", (endpoint) => {
		expect(isTedixControlMcpEndpoint(endpoint)).toBe(false);
	});

	it("adds the platform token only for a trusted control endpoint", () => {
		expect(
			resolveTedixInternalScanHeaders({
				endpoint: "https://docs-admin.tedix.dev/mcp?org=tedix",
				platformServiceToken: "platform-token",
			}),
		).toEqual({
			Authorization: "Bearer platform-token",
			"X-Tedix-Actor-Id": "catalog-scanner",
			"X-Tedix-Actor-Type": "service",
			"X-Tedix-Connection-Label": "tedix",
			"X-Tedix-Delegated-Scope": "mcp:content.read",
		});
		expect(
			resolveTedixInternalScanHeaders({
				endpoint: "https://attacker.example/mcp",
				platformServiceToken: "platform-token",
			}),
		).toBeUndefined();
	});

	it("does not attach Docs delegation headers to the Site Builder endpoint", () => {
		expect(
			resolveTedixInternalScanHeaders({
				endpoint: "https://builder.tedix.dev/mcp",
				platformServiceToken: "platform-token",
			}),
		).toEqual({
			Authorization: "Bearer platform-token",
			"X-Tedix-Connection-Label": "tedix-landing",
		});
	});

	it.each([
		"https://wise.mcp.tedix.dev/mcp",
		"https://acme-api.mcp.tedix.tech/mcp/",
	])("recognizes an exact Tedix tenant MCP endpoint: %s", (endpoint) => {
		expect(isTedixTenantMcpEndpoint(endpoint)).toBe(true);
	});

	it.each([
		"http://wise.mcp.tedix.dev/mcp",
		"https://wise.mcp.tedix.dev/not-mcp",
		"https://deep.wise.mcp.tedix.dev/mcp",
		"https://wise.mcp.tedix.dev.attacker.example/mcp",
	])("rejects an untrusted tenant scan endpoint: %s", (endpoint) => {
		expect(isTedixTenantMcpEndpoint(endpoint)).toBe(false);
	});

	it("marks trusted tenant scans for service-binding authentication", () => {
		expect(
			resolveTedixInternalScanHeaders({
				endpoint: "https://wise.mcp.tedix.dev/mcp",
				platformServiceToken: "platform-token",
			}),
		).toEqual({
			Authorization: "Bearer platform-token",
			"X-Service-Binding": "true",
		});
	});
});
