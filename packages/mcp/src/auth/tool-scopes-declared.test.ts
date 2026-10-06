/**
 * Write capability is a declared column. These classifiers must read it rather
 * than `annotations` alone: a tool declared destructive with no upstream
 * annotations must not look harmless to them. Neither is an approval bypass;
 * they are wrong-answer surfaces. One picks the required scope tier, the other
 * decides whether a destructive call may be deferred to run asynchronously
 * under replayed authority.
 */

import { describe, expect, it } from "vite-plus/test";
import { resolveMcpToolRequiredScopes } from "./tool-scopes";
import { DOCS_TOOL_SCOPES } from "@tedix/api-contract/contracts/docs-tool-scopes";

it("enforces the exact Docs scope for every site-specific gateway tool", () => {
	for (const [name, scope] of Object.entries(DOCS_TOOL_SCOPES)) {
		for (const toolId of [name, `docs_tedix__${name}`]) {
			expect(
				resolveMcpToolRequiredScopes(
					{ toolId, authRequired: true },
					"docs_tedix",
					undefined,
				),
			).toEqual([scope]);
		}
	}
});

/** The row shape declared capability exists for: a declaration, no annotations. */
const declaredDestructive = {
	toolId: "cms_provision_service_key",
	annotations: null,
	writeCapability: "destructive",
} as never;

const undeclared = {
	toolId: "cms_provision_service_key",
	annotations: null,
	writeCapability: null,
} as never;

/**
 * A config that would hand this tool an empty scope set — i.e. no scope
 * required — unless something classifies it as dangerous.
 */
const permissiveConfig = { toolScopes: { "*": [] } };

describe("required scope tier follows the declaration", () => {
	it("requires memory write for a mutating tool with a read-like name", () => {
		const writeTool = {
			toolId: "tedix__gaps_resolve",
			annotations: { readOnlyHint: false },
			writeCapability: "write",
			authRequired: true,
		} as const;
		const readTool = {
			toolId: "tedix__search_memory_graph",
			annotations: { readOnlyHint: true },
			writeCapability: "read",
			authRequired: true,
		} as const;
		expect(
			resolveMcpToolRequiredScopes(writeTool, "memory", undefined),
		).toEqual(["mcp:memory.write"]);
		expect(
			resolveMcpToolRequiredScopes(
				{ ...writeTool, annotations: null },
				"memory",
				undefined,
			),
		).toEqual(["mcp:memory.write"]);
		expect(resolveMcpToolRequiredScopes(readTool, "memory", undefined)).toEqual(
			["mcp:memory.read"],
		);
		expect(
			resolveMcpToolRequiredScopes(writeTool, "memory", {
				toolScopes: { memory: ["mcp:memory.read"] },
			}),
		).toEqual(["mcp:memory.write"]);
		expect(
			resolveMcpToolRequiredScopes(writeTool, "memory", {
				toolScopes: { memory: ["mcp:memory.admin"] },
			}),
		).toEqual(["mcp:memory.admin"]);
		expect(
			resolveMcpToolRequiredScopes(
				{ ...writeTool, writeCapability: "destructive" },
				"memory",
				{ toolScopes: { memory: ["mcp:memory.read"] } },
			),
		).toEqual(["mcp:memory.admin"]);
		expect(
			resolveMcpToolRequiredScopes(
				{
					toolId: "content_create",
					annotations: { destructiveHint: true },
					writeCapability: "destructive",
				},
				"content",
				{ toolScopes: { content: ["mcp:content.read"] } },
			),
		).toEqual(["mcp:content.write"]);
	});

	it("does not hand a declared-destructive tool an empty scope set", () => {
		const scopes = resolveMcpToolRequiredScopes(
			declaredDestructive,
			"cms",
			permissiveConfig,
		);
		// Dangerous tools must not fall through to the permissive wildcard.
		expect(scopes).not.toEqual([]);
	});

	it("shows the same tool WITHOUT a declaration takes the permissive path", () => {
		// The contrast that makes the assertion above meaningful: the name regex
		// alone does not save this tool, which is the camelCase-class blind spot
		// the declared column closes.
		const scopes = resolveMcpToolRequiredScopes(
			undeclared,
			"cms",
			permissiveConfig,
		);
		expect(scopes).toEqual([]);
	});

	it("still honours an explicit destructiveHint when annotations exist", () => {
		const annotated = {
			toolId: "some_tool",
			annotations: { destructiveHint: true },
			writeCapability: null,
		} as never;
		expect(
			resolveMcpToolRequiredScopes(annotated, "cms", permissiveConfig),
		).not.toEqual([]);
	});
});
