import { call, os } from "@orpc/server";
import { expect, it } from "vite-plus/test";
import { apiKeyContext, userContext } from "./test-context";
import { AUTHZ, assertOsApprovalAuthorization, type BaseContext } from "./orpc";

const canonical = os
	.$context<BaseContext>()
	.use(AUTHZ.osApprove)
	.handler(() => true);

const cases: Array<{ name: string; context: BaseContext; allowed: boolean }> = [
	{
		name: "operational member",
		context: userContext({ permissions: ["tedis:update"] }),
		allowed: false,
	},
	{
		name: "author and runner",
		context: userContext({ permissions: ["os:author", "os:run"] }),
		allowed: false,
	},
	{
		name: "explicit approver",
		context: userContext({ permissions: ["os:approve"] }),
		allowed: true,
	},
	{
		name: "settings administrator",
		context: userContext({ permissions: ["settings:manage"] }),
		allowed: true,
	},
	{
		name: "approver missing OIDC scope",
		context: {
			...userContext({ permissions: ["os:approve"] }),
			oidcScopes: ["mcp:tedis.write"],
		},
		allowed: false,
	},
	{
		name: "scoped OIDC approver",
		context: {
			...userContext({ permissions: ["os:approve"] }),
			oidcScopes: ["mcp:memory.admin"],
		},
		allowed: true,
	},
	{
		name: "machine operator",
		context: apiKeyContext({ scopes: ["tedis:write"] }),
		allowed: false,
	},
	{
		name: "machine approver",
		context: apiKeyContext({ scopes: ["mcp:memory.admin"] }),
		allowed: true,
	},
	{
		name: "M2M operator",
		context: {
			authType: "m2m",
			serviceAccount: { scope: "tedis:write" },
		} as BaseContext,
		allowed: false,
	},
	{
		name: "M2M approver",
		context: {
			authType: "m2m",
			serviceAccount: { scope: "mcp:memory.admin" },
		} as BaseContext,
		allowed: true,
	},
	{
		name: "bare service transport",
		context: { authType: "service-binding" } as BaseContext,
		allowed: false,
	},
	{
		name: "delegated service scope",
		context: {
			authType: "service-binding",
			tediScopes: ["mcp:memory.admin"],
		} as BaseContext,
		allowed: true,
	},
	{
		name: "foreign tenant role",
		context: userContext({
			permissions: ["os:approve"],
			roles: ["admin"],
			userRole: "member",
			crossTenantOverrideActive: true,
		}),
		allowed: false,
	},
];

it.each(cases)(
	"matches the canonical approval guard for $name",
	async ({ context, allowed }) => {
		if (allowed) {
			expect(() => assertOsApprovalAuthorization(context)).not.toThrow();
			await expect(call(canonical, undefined, { context })).resolves.toBe(true);
		} else {
			expect(() => assertOsApprovalAuthorization(context)).toThrow();
			await expect(
				call(canonical, undefined, { context }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
	},
);
