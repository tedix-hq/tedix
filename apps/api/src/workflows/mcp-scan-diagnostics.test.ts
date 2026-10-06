import { describe, expect, it } from "vite-plus/test";
import {
	classifySuccessfulMcpScan,
	compactMcpListError,
	getMcpScanWorkflowListTruncation,
	isAuthLikeMcpListError,
	isScanInventoryAuthoritative,
	isScanListAuthoritative,
	summarizeMcpListErrors,
} from "./mcp-scan-diagnostics";

describe("MCP scan diagnostics", () => {
	it("degrades initialized endpoints that return no inventory", () => {
		const diagnostics = classifySuccessfulMcpScan({
			connectTimeMs: 230,
			toolCount: 0,
			resourceCount: 0,
			resourceTemplateCount: 0,
			promptCount: 0,
		});

		expect(diagnostics).toMatchObject({
			status: "degraded",
			authState: "none",
			hasInventory: false,
			methodErrorCount: 0,
			logSuffix: " (empty inventory)",
		});
		expect(diagnostics.errorMessage).toContain("did not report MCP tools");
		expect(diagnostics.errorClass).toBeUndefined();
	});

	it("marks empty inventory as auth-required when every list method is auth gated", () => {
		const diagnostics = classifySuccessfulMcpScan({
			connectTimeMs: 410,
			methodErrors: {
				tools: "HTTP 401: Unauthorized",
				resources: "OAuth token missing",
				prompts: "Authentication required",
			},
			toolCount: 0,
			resourceCount: 0,
			resourceTemplateCount: 0,
			promptCount: 0,
		});

		expect(diagnostics).toMatchObject({
			status: "requires_auth",
			authState: "required",
			errorClass: "auth",
			authGatedLists: true,
			logSuffix: " (auth-gated lists)",
		});
		expect(diagnostics.errorMessage).toContain("tools: HTTP 401");
	});

	it("does not treat vendor 404 session failures as auth just because a stack mentions an authorization filter", () => {
		const vendorError =
			'HTTP 404: Not Found - {"message":"Session not found: 25242817-8fb1-4c5d-8e1c-86af78b07965","stackTrace":[{"className":"org.springframework.security.web.access.intercept.AuthorizationFilter"}]}';

		expect(isAuthLikeMcpListError(vendorError)).toBe(false);
		expect(compactMcpListError(vendorError)).toBe(
			"HTTP 404: Not Found (Session not found: session-id)",
		);

		const diagnostics = classifySuccessfulMcpScan({
			connectTimeMs: 310,
			methodErrors: {
				tools: vendorError,
			},
			toolCount: 0,
			resourceCount: 0,
			resourceTemplateCount: 0,
			promptCount: 0,
		});

		expect(diagnostics).toMatchObject({
			status: "degraded",
			authState: "none",
			errorClass: "protocol",
			authGatedLists: false,
			logSuffix: " (list method errors)",
		});
		expect(diagnostics.errorMessage).toContain("Session not found: session-id");
		expect(diagnostics.errorMessage).not.toContain(
			"25242817-8fb1-4c5d-8e1c-86af78b07965",
		);
		expect(diagnostics.errorMessage).not.toContain("AuthorizationFilter");
	});

	it("degrades partial list failures even when some inventory was discovered", () => {
		const diagnostics = classifySuccessfulMcpScan({
			connectTimeMs: 180,
			methodErrors: {
				resourceTemplates: "RPC error -32600: Invalid Request",
			},
			toolCount: 12,
			resourceCount: 0,
			resourceTemplateCount: 0,
			promptCount: 0,
		});

		expect(diagnostics).toMatchObject({
			status: "degraded",
			authState: "none",
			errorClass: "protocol",
			hasInventory: true,
			logSuffix: " (list method errors)",
		});
		expect(diagnostics.errorMessage).toBe(
			"MCP list method errors: resourceTemplates: RPC error -32600: Invalid Request",
		);
	});

	it("keeps fast complete inventory healthy and slow complete inventory degraded", () => {
		expect(
			classifySuccessfulMcpScan({
				connectTimeMs: 900,
				toolCount: 1,
				resourceCount: 0,
				resourceTemplateCount: 0,
				promptCount: 0,
			}).status,
		).toBe("healthy");

		expect(
			classifySuccessfulMcpScan({
				connectTimeMs: 5100,
				toolCount: 1,
				resourceCount: 0,
				resourceTemplateCount: 0,
				promptCount: 0,
			}).status,
		).toBe("degraded");
	});

	it("degrades truncated catalogs without treating partial auth as complete", () => {
		const diagnostics = classifySuccessfulMcpScan({
			partialAuth: true,
			listsTruncated: {
				tools: false,
				resources: true,
				resourceTemplates: false,
				prompts: false,
			},
			connectTimeMs: 200,
			toolCount: 2,
			resourceCount: 0,
			resourceTemplateCount: 0,
			promptCount: 0,
		});

		expect(diagnostics.status).toBe("degraded");
		expect(diagnostics.authState).toBe("required");
		expect(diagnostics.authGatedLists).toBe(false);
	});

	it("summarizes and redacts list method diagnostics before persistence", () => {
		const summary = summarizeMcpListErrors({
			tools:
				'HTTP 404: Not Found - {"message":"Session not found: 25242817-8fb1-4c5d-8e1c-86af78b07965"}',
			resources: "RPC error -32600: Invalid Request",
		});

		expect(summary).toBe(
			"MCP list method errors: tools: HTTP 404: Not Found (Session not found: session-id); resources: RPC error -32600: Invalid Request",
		);
		expect(summary).not.toContain("25242817-8fb1-4c5d-8e1c-86af78b07965");
	});
});

describe("isScanInventoryAuthoritative", () => {
	// Regression: an auth-gated scan returns an EMPTY tools list rather than an
	// error (initialize succeeds, tools/list 401s). The catalog sync reads an
	// empty array as "the upstream removed everything" and soft-removes every
	// tool row — and its default "full" mode rewrites a missing inputSchema to
	// the empty schema. Letting a credential-starved scan write inventory
	// therefore silently destroys good tool schemas for EVERY org consuming the
	// (global) catalog app. It must not be treated as authoritative.
	it("refuses to treat an auth-gated scan as authoritative", () => {
		expect(isScanInventoryAuthoritative("requires_auth")).toBe(false);
	});

	it("trusts scans that actually reached the upstream", () => {
		expect(isScanInventoryAuthoritative("healthy")).toBe(true);
		expect(isScanInventoryAuthoritative("degraded")).toBe(true);
		// An unhealthy/blocked scan returns no tools array at all, so the caller's
		// Array.isArray() check already skips the write; authority is unchanged.
		expect(isScanInventoryAuthoritative("unhealthy")).toBe(true);
		expect(isScanInventoryAuthoritative(undefined)).toBe(true);
	});
});

describe("isScanListAuthoritative", () => {
	const truncated = {
		tools: true,
		resources: false,
		resourceTemplates: false,
		prompts: true,
	};

	it("preserves only failed or truncated lists while reconciling complete lists", () => {
		expect(isScanListAuthoritative("degraded", "tools", truncated)).toBe(false);
		expect(isScanListAuthoritative("degraded", "resources", truncated)).toBe(
			true,
		);
		expect(
			isScanListAuthoritative("degraded", "resourceTemplates", truncated),
		).toBe(true);
		expect(isScanListAuthoritative("degraded", "prompts", truncated)).toBe(
			false,
		);
	});

	it("does not trust any list when the whole scan is auth-gated", () => {
		expect(
			isScanListAuthoritative("requires_auth", "resources", truncated),
		).toBe(false);
	});

	it("treats workflow limits of 200/200/100/100 as complete at the boundary", () => {
		expect(
			getMcpScanWorkflowListTruncation({
				tools: 200,
				resources: 200,
				resourceTemplates: 100,
				prompts: 100,
				skills: 100,
			}),
		).toEqual({
			tools: false,
			resources: false,
			resourceTemplates: false,
			prompts: false,
			skills: false,
		});
	});

	it("marks over-limit lists incomplete independently and preserves authority for others", () => {
		const truncated = getMcpScanWorkflowListTruncation({
			tools: 201,
			resources: 200,
			resourceTemplates: 101,
			prompts: 100,
			skills: 101,
		});

		expect(truncated).toEqual({
			tools: true,
			resources: false,
			resourceTemplates: true,
			prompts: false,
			skills: true,
		});
		expect(isScanListAuthoritative("degraded", "tools", truncated)).toBe(false);
		expect(isScanListAuthoritative("degraded", "resources", truncated)).toBe(
			true,
		);
		expect(
			isScanListAuthoritative("degraded", "resourceTemplates", truncated),
		).toBe(false);
		expect(isScanListAuthoritative("degraded", "prompts", truncated)).toBe(
			true,
		);
	});

	it("keeps upstream truncation even when the workflow list is under its cap", () => {
		expect(
			getMcpScanWorkflowListTruncation(
				{
					tools: 1,
					resources: 1,
					resourceTemplates: 1,
					prompts: 1,
					skills: 1,
				},
				{ resources: true },
			),
		).toMatchObject({ resources: true, tools: false });
	});
});
