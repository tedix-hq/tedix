import { describe, expect, it, vi } from "vite-plus/test";
import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { ToolHandler, type ToolExecutionContext } from "./handler";
import {
	buildCredentialErrorData,
	buildCredentialErrorMessage,
} from "./handler-connection-credentials";
import { sha256Hex } from "@tedix/worker-kit/crypto";

const selection = {
	providerId: "fictional-mail",
	connectionInstanceId: "11111111-1111-4111-8111-111111111111",
	scope: "user",
	scopes: ["mail.read", "mail.send"],
};

describe("unconfigured MCP capabilities", () => {
	it("refuses stale reviewed tool configuration before credential resolution", async () => {
		const handler = new ToolHandler();
		const credentials = vi.spyOn(
			handler as unknown as { fetchConnectionToken: () => Promise<unknown> },
			"fetchConnectionToken",
		);
		const result = await handler.execute({}, {
			config: { transport: "mcp" },
			requestMeta: { "tedix/expectedToolConfig": "stale-review" },
		} as unknown as ToolExecutionContext<ToolConfig>);
		expect(result).toEqual({
			status: 409,
			data: { error: "Reviewed tool configuration changed" },
		});
		expect(credentials).not.toHaveBeenCalled();
	});
	it.each(["external", "mcp"])(
		"includes a Set up link before %s provider execution",
		async (transport) => {
			const handler = new ToolHandler();
			vi.spyOn(
				handler as unknown as {
					fetchConnectionToken: () => Promise<{ token: null; status: number }>;
				},
				"fetchConnectionToken",
			).mockResolvedValue({ token: null, status: 404 });
			const ctx = {
				appId: "fictional-app",
				app: { id: "fictional-app", organizationId: "fictional-org" },
				appCapabilities: {},
				env: {},
				toolId: "read_mail",
				requestId: "request",
				traceId: "trace",
				executionId: "execution",
				callerIdentity: {
					authType: "oauth",
					organizationId: "fictional-org",
					userId: "fictional-user",
				},
				config: {
					transport,
					baseUrl: "https://mail.example.test",
					endpoint: "/messages",
					method: "GET",
					mcpServerUrl: "https://mail.example.test/mcp",
					mcpToolName: "read_mail",
					auth: {
						type: "connection",
						connectionId: selection.providerId,
						credentialScope: "user",
						scopes: selection.scopes,
					},
				} as ToolConfig,
			} as unknown as ToolExecutionContext<ToolConfig>;
			ctx.requestMeta = {
				"tedix/expectedToolConfig": await sha256Hex(JSON.stringify(ctx.config)),
			};
			const result = await handler.execute({}, ctx);
			expect(result.status).toBe(401);
			expect(result.data).toMatchObject({
				capability: {
					state: "not_configured",
					requiredScopes: selection.scopes,
					verified: true,
					setupUrl: expect.stringContaining(
						"/account/connections?connect=fictional-mail",
					),
				},
			});
			expect(result.data).toMatchObject({
				error: expect.stringContaining("Set up: /account/connections?"),
			});
		},
	);

	it("preserves the selected account and scopes in setup links", () => {
		const result = buildCredentialErrorData(
			{ token: null, status: 404 },
			selection,
		);
		const url = new URL(result.capability!.setupUrl, "https://example.test");
		expect(url.searchParams.get("connectionInstanceId")).toBe(
			selection.connectionInstanceId,
		);
		expect(url.searchParams.get("scopes")).toBe("mail.read,mail.send");
	});

	it.each([
		[undefined, "/account/connections"],
		["user-first", "/account/connections"],
		["tenant-first", "/admin/connections"],
	] as const)(
		"routes hybrid setup with preference %s to the correct owner",
		(preference, path) => {
			const result = buildCredentialErrorData(
				{ token: null, status: 404 },
				{ ...selection, scope: "hybrid", preference },
			);
			expect(
				new URL(result.capability!.setupUrl, "https://example.test").pathname,
			).toBe(path);
		},
	);

	it.each([undefined, 401, 403, 409, 429, 500, 503])(
		"does not report lookup failure %s as unconfigured",
		(status) => {
			expect(
				buildCredentialErrorData({ token: null, status }, selection),
			).not.toHaveProperty("capability");
		},
	);

	it("explains a consumer grant refusal without exposing the RPC envelope", () => {
		const message = buildCredentialErrorMessage({
			token: null,
			status: 403,
			detail:
				'{"code":"FORBIDDEN","message":"Not granted for this connection. Request access from an administrator in /admin/connections."}',
		});
		expect(message).toBe(
			"This tedi or skill revision is not allowed to use this organization connection. Ask an administrator to grant access in Admin > Connections.",
		);
		expect(message).not.toContain("FORBIDDEN");
		expect(
			buildCredentialErrorData(
				{ token: null, status: 403, detail: message },
				selection,
			),
		).not.toHaveProperty("capability");
	});
});
