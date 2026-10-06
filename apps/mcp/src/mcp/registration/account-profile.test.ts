import { describe, expect, it } from "vite-plus/test";
import {
	accountProfileInputSchema,
	accountProfileResult,
	accountProfileSchema,
	accountProfileTool,
	registerAccountProfile,
} from "./account-profile";
import type { CallerIdentity, ServerContext } from "../server-context";

const caller = {
	authType: "oauth",
	userId: "U-stable-subject",
	email: "owner@example.test",
	organizationId: "org-one",
} as NonNullable<CallerIdentity>;
describe("credential-scoped account profile", () => {
	it("returns the standard profile and matching JSON text without authorization inventory", () => {
		const result = accountProfileResult(caller, {});
		expect(result.structuredContent).toEqual({
			id: "U-stable-subject",
			email: "owner@example.test",
			nickname: "owner@example.test",
		});
		expect(JSON.parse(result.content[0]!.text)).toEqual(
			result.structuredContent,
		);
		expect(
			accountProfileSchema.safeParse(result.structuredContent).success,
		).toBe(true);
	});
	it("preserves identity across org, scope and label changes; distinguishes another user", () => {
		const original = accountProfileResult(caller, {}).structuredContent!.id;
		expect(
			accountProfileResult(
				{
					...caller,
					organizationId: "org-two",
					email: "changed@example.test",
					scopes: [],
				},
				{},
			).structuredContent!.id,
		).toBe(original);
		expect(
			accountProfileResult({ ...caller, userId: "U-other" }, {})
				.structuredContent!.id,
		).not.toBe(original);
	});
	it.each([
		undefined,
		{ ...caller, authType: "service" },
		{ ...caller, authType: "tedi" },
		{ ...caller, authType: "external_agent" },
		{ ...caller, userId: " " },
	])("fails closed without a personal credential", (identity) => {
		const result = accountProfileResult(identity as CallerIdentity, {});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		expect(result._meta?.["mcp/www_authenticate"]).toBeDefined();
	});
	it("rejects account selectors and publishes a strict empty schema", () => {
		expect(
			accountProfileInputSchema.safeParse({ userId: "U-other" }).success,
		).toBe(false);
		expect(accountProfileResult(caller, { userId: "U-other" }).isError).toBe(
			true,
		);
		expect(accountProfileTool._meta["openai/profile"]).toBe(true);
		expect(accountProfileTool.securitySchemes).toEqual([
			{ type: "oauth2", scopes: [] },
		]);
	});
	it("registers the same profile contract and captures only the current request's caller", async () => {
		let callback: (args: unknown) => unknown;
		const agent = {
			appMetadata: { mcpConfig: { authMode: "authenticated" } },
			callerIdentity: caller,
			registeredTools: new Map(),
			authRequiredTools: new Set(),
			server: {
				registerTool(
					name: string,
					config: Record<string, unknown>,
					handler: typeof callback,
				) {
					expect(name).toBe("get_profile");
					expect(config._meta).toEqual(accountProfileTool._meta);
					callback = handler;
					return {};
				},
			},
		} as unknown as ServerContext;
		registerAccountProfile(agent);
		expect(
			((await callback!({})) as ReturnType<typeof accountProfileResult>)
				.structuredContent!.id,
		).toBe(caller.userId);
	});
});
