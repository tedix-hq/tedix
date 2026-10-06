import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import {
	agentUnreachableCapabilityFieldsTouched,
	updateTediProcedure,
} from "./crud";
import { requireTediAccess } from "./helpers";

const { getTediById } = vi.hoisted(() => ({ getTediById: vi.fn() }));
vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTediById,
}));
const target = { id: "customer-worker", organizationId: "customer-org" };
function context(overrides: Partial<BaseContext> = {}): BaseContext {
	getTediById.mockResolvedValue(target);
	return {
		organizationId: "provider-org",
		db: {},
		...overrides,
	} as BaseContext;
}

describe("Tedi access uses canonical platform authority", () => {
	it.each([
		{
			authType: "user",
			user: { sub: "operator", roles: [], scope: "platform:admin" },
		},
		{ authType: "user", user: { sub: "operator", roles: ["platform-admin"] } },
		{ authType: "apikey", apiKey: { scopes: ["platform:admin"] } },
		{ authType: "apikey", apiKey: { scopes: ["*"] } },
		{ authType: "m2m", serviceAccount: { scope: "platform:admin" } },
		{ authType: "tedi", tediScopes: ["platform:admin"] },
	] as Partial<BaseContext>[])(
		"admits cross-organization platform principal %j",
		async (principal) => {
			await expect(
				requireTediAccess(context(principal), target.id),
			).resolves.toEqual(target);
		},
	);
	it.each([
		{
			authType: "user",
			user: { sub: "tenant-owner", roles: ["owner"], scope: "mcp:tedis.admin" },
		},
		{ authType: "apikey", apiKey: { scopes: ["mcp:tedis.admin"] } },
		{ authType: "m2m", serviceAccount: { scope: "mcp:tedis.write" } },
		{ authType: "tedi", tediScopes: ["mcp:tedis.admin"] },
		{ authType: "service-binding" },
	] as Partial<BaseContext>[])(
		"keeps tenant-only principal denied cross-organization %j",
		async (principal) => {
			await expect(
				requireTediAccess(context(principal), target.id),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);
	it("preserves same-organization and system service binding access", async () => {
		await expect(
			requireTediAccess(context({ organizationId: "customer-org" }), target.id),
		).resolves.toEqual(target);
		await expect(
			requireTediAccess(
				context({ organizationId: "system", authType: "service-binding" }),
				target.id,
			),
		).resolves.toEqual(target);
		await expect(
			requireTediAccess(
				context({ organizationId: "system", authType: "user" }),
				target.id,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("still requires an organization and an existing tedi", async () => {
		await expect(
			requireTediAccess(
				context({ organizationId: undefined, tediScopes: ["platform:admin"] }),
				target.id,
			),
		).rejects.toThrow();
		const actor = context({ tediScopes: ["platform:admin"] });
		getTediById.mockResolvedValue(null);
		await expect(requireTediAccess(actor, target.id)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});
	it.each(["tedi", "m2m", "service-binding"] as const)(
		"platform %s access cannot bypass the autonomous budget mutation gate",
		async (authType) => {
			const actor = context({ authType, tediScopes: ["platform:admin"] });
			await expect(requireTediAccess(actor, target.id)).resolves.toEqual(
				target,
			);
			expect(
				agentUnreachableCapabilityFieldsTouched(authType, {
					budgets: { dailyTokenLimit: 1_000_000, dailyMessageLimit: 500 },
				}),
			).toEqual(["budgets"]);
		},
	);
});

it("rejects an actual cross-org platform tedi budget update before persistence", async () => {
	const actor = context({
		authType: undefined,
		organizationId: "provider-org",
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Org-Id": "provider-org",
			"X-Tedix-Tedi-Id": "platform-worker",
			"X-Tedix-Tedi-Scopes":
				"platform:admin mcp:tedis.write tedis:write apps:write",
		}),
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		url: new URL("https://api.tedix.test/rpc/tedis/update"),
	});
	const client = createRouterClient(
		{ update: updateTediProcedure },
		{ context: actor },
	);
	await expect(
		client.update({
			tediId: "00000000-0000-4000-8000-000000000001",
			budgets: { dailyTokenLimit: 1_000_000, dailyMessageLimit: 500 },
		}),
	).rejects.toThrow(
		/Capability\/policy field.*budgets.*require a human operator/,
	);
});
