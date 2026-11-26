import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as apps from "@tedix/db/queries/app-records";
import * as tools from "@tedix/db/queries/tools";
import * as organizations from "@tedix/db/queries/organizations";
import * as credentials from "./policy-resolution";
import type { BaseContext } from "../../orpc";
import { fetchPoppyToken } from "./poppy-credentials";

type App = NonNullable<
	Awaited<ReturnType<typeof apps.getAppByIdForOrganization>>
>;
type Tool = NonNullable<
	Awaited<ReturnType<typeof tools.getToolByAppAndToolIdForOrganization>>
>;
type Organization = NonNullable<
	Awaited<ReturnType<typeof organizations.getOrganizationById>>
>;
type Credential = Awaited<
	ReturnType<typeof credentials.resolveCredentialChain>
>;

const orgId = "10000000-0000-4000-8000-000000000001";
const appId = "20000000-0000-4000-8000-000000000001";
const input = {
	organizationId: orgId,
	appId,
	providerId: "example",
	toolId: "search_products",
	mcpServerUrl: "https://provider.example/mcp",
	mcpToolName: "search",
	arguments: { query: "shoes" },
};
const allowance = {
	providerId: "example",
	mcpServerUrl: input.mcpServerUrl,
	tools: { [input.toolId]: input.mcpToolName },
};
const app = () => ({
	id: appId,
	organizationId: orgId,
	visibility: "public",
	metadata: { mcpConfig: { authMode: "public", poppyConnection: allowance } },
});
const tool = () => ({
	enabled: true,
	config: {
		transport: "mcp",
		mcpServerUrl: input.mcpServerUrl,
		mcpToolName: input.mcpToolName,
		auth: {
			type: "connection",
			connectionId: "example",
			credentialScope: "tenant",
		},
	},
});
const context = () =>
	({
		db: {},
		env: {},
		serviceBindingPrincipal: "mcp-edge",
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Auth-Poppy-App-Id": appId,
			"X-Tedix-Org-Id": orgId,
			"X-Tedix-Mcp-Tool-Id": input.toolId,
		}),
	}) as BaseContext;

beforeEach(() => vi.restoreAllMocks());

describe("Poppy organization credential allowance", () => {
	it("rechecks the installed app and tool before using the existing tenant credential restrictions", async () => {
		const lookup = vi
			.spyOn(apps, "getAppByIdForOrganization")
			.mockResolvedValue(app() as App);
		vi.spyOn(tools, "getToolByAppAndToolIdForOrganization").mockResolvedValue(
			tool() as Tool,
		);
		vi.spyOn(organizations, "getOrganizationById").mockResolvedValue({
			id: orgId,
			descopeTenantId: "tenant-example",
			features: { os: true },
		} as Organization);
		const resolve = vi
			.spyOn(credentials, "resolveCredentialChain")
			.mockResolvedValue({ accessToken: "fixture-token" } as Credential);
		await expect(
			call(fetchPoppyToken, input, { context: context() }),
		).resolves.toEqual({ accessToken: "fixture-token" });
		expect(lookup).toHaveBeenCalledWith(expect.anything(), appId, orgId);
		expect(resolve).toHaveBeenCalledWith(expect.anything(), {
			organizationId: orgId,
			descopeTenantId: "tenant-example",
			providerId: "example",
			scope: "tenant",
			delegatedToolUse: { appId, arguments: input.arguments },
		});
		lookup.mockResolvedValue({
			...app(),
			metadata: { mcpConfig: { authMode: "public" } },
		} as App);
		await expect(
			call(fetchPoppyToken, input, { context: context() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it.each([
		"no-session",
		"foreign-app",
		"foreign-org",
		"wrong-tool",
		"different-provider",
		"personal-credential",
		"disabled-tool",
		"different-account",
		"direct-http",
		"wrong-worker",
		"changed-server",
		"changed-upstream-tool",
	])("refuses %s before touching the vault", async (boundary) => {
		const ctx = context();
		const storedApp = app();
		const storedTool = tool();
		const args = { ...input };
		if (boundary === "no-session")
			ctx.headers.delete("X-Tedix-Auth-Poppy-App-Id");
		if (boundary === "foreign-app")
			ctx.headers.set("X-Tedix-Auth-Poppy-App-Id", orgId);
		if (boundary === "foreign-org") ctx.headers.set("X-Tedix-Org-Id", appId);
		if (boundary === "wrong-tool") args.toolId = "delete_product";
		if (boundary === "different-provider") args.providerId = "other";
		if (boundary === "personal-credential")
			storedTool.config.auth.credentialScope = "user";
		if (boundary === "disabled-tool") storedTool.enabled = false;
		if (boundary === "different-account")
			Object.assign(args, { connectionInstanceId: orgId });
		if (boundary === "direct-http") ctx.headers.delete("X-Service-Binding");
		if (boundary === "wrong-worker") ctx.serviceBindingPrincipal = undefined;
		if (boundary === "changed-server")
			storedTool.config.mcpServerUrl = "https://other.example/mcp";
		if (boundary === "changed-upstream-tool")
			storedTool.config.mcpToolName = "delete_product";
		vi.spyOn(apps, "getAppByIdForOrganization").mockResolvedValue(
			storedApp as App,
		);
		vi.spyOn(tools, "getToolByAppAndToolIdForOrganization").mockResolvedValue(
			storedTool as Tool,
		);
		const resolve = vi.spyOn(credentials, "resolveCredentialChain");
		await expect(
			call(fetchPoppyToken, args, { context: ctx }),
		).rejects.toMatchObject({
			code: boundary === "direct-http" ? "UNAUTHORIZED" : "FORBIDDEN",
		});
		expect(resolve).not.toHaveBeenCalled();
	});
});
