import { call, os } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import { AUTHZ, type BaseContext } from "./orpc";

const useHome = os
	.$context<BaseContext>()
	.use(AUTHZ.homeUse)
	.handler(() => "ok");
const configure = os
	.$context<BaseContext>()
	.use(AUTHZ.tedisWrite)
	.handler(() => "ok");

describe("conversation use without worker configuration", () => {
	it("lets a member use Home while denying worker configuration", async () => {
		const context = {
			authType: "user",
			userRole: "member",
			user: { sub: "member", roles: ["member"], permissions: [] },
		} as BaseContext;
		await expect(call(useHome, undefined, { context })).resolves.toBe("ok");
		await expect(call(configure, undefined, { context })).rejects.toMatchObject(
			{ code: "FORBIDDEN" },
		);
	});
	it.each([[], ["os:read"], ["tedis:update"]])(
		"denies a caller without conversation-use permission: %j",
		async (permissions) => {
			const context = {
				authType: "user",
				user: { sub: "viewer", roles: [], permissions },
			} as BaseContext;
			await expect(call(useHome, undefined, { context })).rejects.toMatchObject(
				{ code: "FORBIDDEN" },
			);
		},
	);
	it("does not inherit another tenant's os:run claim", async () => {
		const context = {
			authType: "user",
			crossTenantOverrideActive: true,
			user: { sub: "foreign", roles: ["member"], permissions: ["os:run"] },
		} as BaseContext;
		await expect(call(useHome, undefined, { context })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("preserves the machine write scope instead of granting apps-only keys chat", async () => {
		for (const scopes of [["tedis:read"], ["apps:write"], []]) {
			await expect(
				call(useHome, undefined, {
					context: { authType: "apikey", apiKey: { scopes } } as BaseContext,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		await expect(
			call(useHome, undefined, {
				context: {
					authType: "apikey",
					apiKey: { scopes: ["tedis:write"] },
				} as BaseContext,
			}),
		).resolves.toBe("ok");
	});
});
