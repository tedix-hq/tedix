import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveConnectionResourceAccess } from "@tedix/api-contract/utils/connection-resource-policy";
import type { ConnectionAllowedResources } from "@tedix/api-contract/schemas/connections";
import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { ToolHandler, type ToolExecutionContext } from "./handler";
import { resetUpstreamEraCache } from "./upstream-mcp-client";

afterEach(() => {
	vi.unstubAllGlobals();
	resetUpstreamEraCache();
});

const args = {
	owner: "example",
	repo: "repo-x",
	method: "update",
	issue_number: 1,
	title: "Updated",
};
const sourceConfig = {
	transport: "mcp",
	mcpServerUrl: "https://api.githubcopilot.com/mcp/",
	mcpToolName: "issue_write",
	auth: {
		type: "connection",
		connectionId: "github",
		credentialScope: "tenant",
	},
};

function fixture({
	aggregate = false,
	tedi = false,
	named = false,
	pause = false,
	revoke = false,
} = {}) {
	let allowedResources: ConnectionAllowedResources = [
		{ resourceType: "github_repository", resourceId: "example/repo-x" },
	];
	let writes = 0;
	let calls = 0;
	const api = vi.fn(async (request: Request) => {
		const input = (
			(await request.json()) as {
				json: { delegatedToolUse: { appId: string; arguments: unknown } };
			}
		).json;
		expect(input.delegatedToolUse.appId).toBe("source-app");
		expect(request.headers.get("X-Tedix-Mcp-Tool-Id")).toBe("update_issue");
		const decision = resolveConnectionResourceAccess({
			allowedResources,
			providerId: "github",
			config: sourceConfig,
			arguments: input.delegatedToolUse.arguments,
		});
		return decision.allowed
			? Response.json({ json: { accessToken: "test-token" } })
			: Response.json(
					{ message: "Outside allowed resources" },
					{ status: 403 },
				);
	});
	const provider = vi.fn(async (_input: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		if (body.method === "server/discover")
			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					resultType: "complete",
					supportedVersions: ["2026-07-28"],
					capabilities: { tools: {} },
				},
			});
		if (body.method === "tools/call") {
			calls++;
			if (pause && calls === 1) {
				if (revoke) allowedResources = [];
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						resultType: "input_required",
						inputRequests: {
							approval: {
								type: "elicitation",
								mode: "form",
								message: "Confirm",
								requestedSchema: {
									type: "object",
									properties: {
										reason: { type: "string", default: "approved" },
									},
									required: ["reason"],
								},
							},
						},
						requestState: "pending-x",
					},
				});
			}
			writes++;
		}
		return Response.json({
			jsonrpc: "2.0",
			id: body.id,
			result: {
				resultType: "complete",
				content: [{ type: "text", text: "updated" }],
			},
		});
	});
	vi.stubGlobal("fetch", provider);
	const ctx = {
		appId: aggregate ? "gateway-app" : "source-app",
		app: {
			id: "source-app",
			slug: "github-test",
			name: "GitHub",
			organizationId: "org-example",
		},
		appCapabilities: {},
		env: { ENVIRONMENT: "test", API_SERVICE: { fetch: api } },
		config: {
			...sourceConfig,
			...(named
				? {
						auth: {
							...sourceConfig.auth,
							connectionInstanceId: "10000000-0000-4000-8000-000000000001",
						},
					}
				: {}),
			...(aggregate ? { _sourceAppId: "source-app" } : {}),
		},
		toolId: aggregate ? "github__update_issue" : "update_issue",
		requestId: "test-request",
		callerIdentity: {
			authType: tedi ? "tedi" : "oauth",
			organizationId: "org-example",
			...(tedi ? { tediId: "tedi-example" } : { userId: "user-example" }),
			homeApprovedCall: true,
		},
	} as unknown as ToolExecutionContext<ToolConfig>;
	return {
		ctx,
		api,
		provider,
		revoke: () => {
			allowedResources = [];
		},
		writes: () => writes,
		calls: () => calls,
	};
}

describe("repository policy across gateway transports and approval replay", () => {
	it.each([
		{ aggregate: false, tedi: false, named: false },
		{ aggregate: true, tedi: false, named: false },
		{ aggregate: false, tedi: true, named: true },
		{ aggregate: true, tedi: true, named: true },
	])("checks X, Y and revoked replay through %j", async (options) => {
		const f = fixture(options);
		const handler = new ToolHandler();
		expect(
			(await handler.execute({ ...args, repo: "repo-y" }, f.ctx)).status,
		).toBe(403);
		expect(f.provider).not.toHaveBeenCalled();
		expect((await handler.execute(args, f.ctx)).status).toBe(200);
		expect(f.writes()).toBe(1);
		f.revoke();
		const callsBefore = f.provider.mock.calls.length;
		expect((await handler.execute(args, f.ctx)).status).toBe(403);
		expect(f.writes()).toBe(1);
		expect(f.provider).toHaveBeenCalledTimes(callsBefore);
	});
	it.each([false, true])(
		"rechecks a provider approval continuation (revoked=%s)",
		async (revoke) => {
			const f = fixture({ aggregate: true, pause: true, revoke });
			const result = await new ToolHandler().execute(args, f.ctx);
			expect(result.status).toBe(revoke ? 403 : 200);
			expect(f.api).toHaveBeenCalledTimes(2);
			expect(f.calls()).toBe(revoke ? 1 : 2);
			expect(f.writes()).toBe(revoke ? 0 : 1);
		},
	);
	it.each(["rpc", "rest", "code", "catalog"])(
		"refuses connection credentials on unsupported %s transport",
		async (transport) => {
			const f = fixture();
			f.ctx.config = { ...f.ctx.config, transport } as ToolConfig;
			expect(
				(await new ToolHandler().execute({ ...args, repo: "repo-y" }, f.ctx))
					.status,
			).toBe(403);
			expect(f.provider).not.toHaveBeenCalled();
		},
	);
	it("refuses an unreviewed external transport before provider access", async () => {
		const f = fixture();
		f.ctx.config = {
			...f.ctx.config,
			transport: "external",
			method: "PATCH",
			baseUrl: "https://api.github.com",
			endpoint: "/repos/{owner}/{repo}/issues/{issue_number}",
		} as ToolConfig;
		f.api.mockImplementation(async () =>
			Response.json(
				{ message: "Unsupported resource boundary" },
				{ status: 403 },
			),
		);
		expect(
			(await new ToolHandler().execute({ ...args, repo: "repo-y" }, f.ctx))
				.status,
		).toBe(403);
		expect(f.provider).not.toHaveBeenCalled();
	});
});
