// @ts-nocheck - package test type dependencies are not part of the db tsconfig.
import { describe, expect, it } from "vite-plus/test";
import { catalogToolSourcePolicy } from "./catalog/mcp-tools";
import { createToolTestOutputPreview } from "./catalog/tool-tests";

describe("createToolTestOutputPreview", () => {
	it("preserves small output objects", () => {
		const output = { ok: true };
		expect(createToolTestOutputPreview(output)).toBe(output);
	});

	it("stores oversized output as a safe JSON preview", () => {
		const output = { data: "x".repeat(12_000) };
		const preview = createToolTestOutputPreview(output);

		expect(preview?._truncated).toBe(true);
		expect(preview?._originalLength).toBe(JSON.stringify(output).length);
		expect(typeof preview?._preview).toBe("string");
		expect(preview?._preview).toHaveLength(10_000);
		expect(() => JSON.stringify(preview)).not.toThrow();
		expect(preview).not.toHaveProperty("data");
	});
});

describe("catalogToolSourcePolicy", () => {
	it("treats connector-only service listings as catalog evidence, not endpoint drift", () => {
		const policy = catalogToolSourcePolicy({
			toolSource: "upstream_mcp",
			healthStatus: "unknown",
			connectorType: "SERVICE",
			mcpToolCount: 0,
		});

		expect(policy).toMatchObject({
			requiresBaseApp: false,
			requiresMcpEndpoint: false,
			emptySnapshotIsIntegrityIssue: false,
			generatedSnapshotRequiresMetadata: false,
		});
	});

	it("still requires endpoint and snapshot health for real MCP catalog rows", () => {
		const policy = catalogToolSourcePolicy({
			toolSource: "upstream_mcp",
			healthStatus: "unknown",
			connectorType: "MCP",
			mcpToolCount: 0,
		});

		expect(policy).toMatchObject({
			requiresBaseApp: false,
			requiresMcpEndpoint: true,
			emptySnapshotIsIntegrityIssue: true,
			generatedSnapshotRequiresMetadata: false,
		});
	});
});
