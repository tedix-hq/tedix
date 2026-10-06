import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { McpClientManager } from "../src/client-manager";
import type { McpServerConfig } from "../src/types";

const CONFIG: McpServerConfig = { url: "https://skills.example/mcp" };

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

async function connectWithSkillText(text: string): Promise<McpClientManager> {
	const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
		const parsed = JSON.parse(String(init.body)) as {
			method: string;
			params?: { uri?: string };
		};

		if (parsed.method === "server/discover") {
			return jsonResponse({
				jsonrpc: "2.0",
				id: "discover",
				result: { supportedVersions: ["2026-07-28"], capabilities: {} },
			});
		}
		if (parsed.method === "tools/list") {
			return jsonResponse({
				jsonrpc: "2.0",
				id: "tools",
				result: { tools: [] },
			});
		}
		if (parsed.method === "resources/list") {
			return jsonResponse({
				jsonrpc: "2.0",
				id: "resources",
				result: {
					resources: [
						{
							uri: "skill://deploy-review/SKILL.md",
							name: "Fallback deploy review",
							description: "Fallback description",
							mimeType: "text/markdown",
						},
					],
				},
			});
		}
		if (parsed.method === "resources/templates/list") {
			return jsonResponse({
				jsonrpc: "2.0",
				id: "templates",
				result: { resourceTemplates: [] },
			});
		}
		if (parsed.method === "prompts/list") {
			return jsonResponse({
				jsonrpc: "2.0",
				id: "prompts",
				result: { prompts: [] },
			});
		}
		if (parsed.method === "resources/read") {
			return jsonResponse({
				jsonrpc: "2.0",
				id: "read",
				result: { contents: [{ type: "text", text }] },
			});
		}

		throw new Error(`Unexpected MCP method ${parsed.method}`);
	});
	vi.stubGlobal("fetch", fetchMock);

	const manager = new McpClientManager();
	await manager.connectStatelessSnapshot("skills", CONFIG);
	return manager;
}

afterEach(() => vi.unstubAllGlobals());

describe("guidance frontmatter", () => {
	it("parses YAML scalar, inline-list, and block-list metadata", async () => {
		const manager = await connectWithSkillText(`---
title: "Deploy: Review"
summary: "Roll forward safely"
description: |
  Checks deploy state before shipping.
version: 2.1
tags:
  - mcp
  - "release:prod"
dependencies: ["git", "wrangler"]
provenance: https://example.com/deploy-review
source: tedix
---

Use this before deploys.`);

		const { guidance } = await manager.readGuidance(
			"skills",
			"skill://deploy-review/SKILL.md",
		);

		expect(guidance.name).toBe("Deploy: Review");
		expect(guidance.description).toBe("Checks deploy state before shipping.");
		expect(guidance.metadata).toMatchObject({
			title: "Deploy: Review",
			summary: "Roll forward safely",
			description: "Checks deploy state before shipping.",
			version: "2.1",
			tags: ["mcp", "release:prod"],
			dependencies: ["git", "wrangler"],
			provenance: "https://example.com/deploy-review",
			source: "tedix",
		});
	});

	it("ignores non-scalar YAML list entries instead of stringifying objects", async () => {
		const manager = await connectWithSkillText(`---
title: Cleanup Guide
tags:
  - useful
  - nested: nope
dependencies: git, wrangler
---

Body.`);

		const { guidance } = await manager.readGuidance(
			"skills",
			"skill://deploy-review/SKILL.md",
		);

		expect(guidance.metadata?.tags).toEqual(["useful"]);
		expect(guidance.metadata?.dependencies).toEqual(["git", "wrangler"]);
	});

	it("falls back to resource metadata when frontmatter is malformed", async () => {
		const manager = await connectWithSkillText(`---
title: [unterminated
---

Body.`);

		const { guidance } = await manager.readGuidance(
			"skills",
			"skill://deploy-review/SKILL.md",
		);

		expect(guidance.name).toBe("Fallback deploy review");
		expect(guidance.description).toBe("Fallback description");
		expect(guidance.metadata).toMatchObject({
			title: "Fallback deploy review",
			description: "Fallback description",
		});
	});
});
