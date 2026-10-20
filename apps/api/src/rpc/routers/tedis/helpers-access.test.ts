import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import {
	TEDI_ACCESS_CASES,
	TEDI_ACCESS_TARGET,
	type TediAccessCaseName,
	type TediAccessOutcome,
	lookupTediAccessTarget,
	tediAccessContext,
} from "../../tedi-access-test-cases";
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

/**
 * Tedis router: the caller must carry an organization (UNAUTHORIZED
 * otherwise). Any platform principal crosses the tenant boundary, as does the
 * internal `system` service binding; the tedi identity on the context is not
 * consulted, so a tedi reaches every tedi in its own organization.
 */
const EXPECTED: Record<TediAccessCaseName, TediAccessOutcome> = {
	"same-org user": "allow",
	"cross-org user": "FORBIDDEN",
	"cross-org user with platform-admin role": "allow",
	"cross-org user with platform:admin scope": "allow",
	"cross-org api key with platform:admin": "allow",
	"cross-org api key with wildcard scope": "allow",
	"cross-org api key with tenant scopes": "FORBIDDEN",
	"cross-org m2m with platform:admin": "allow",
	"system service binding": "allow",
	"system organization on a user call": "FORBIDDEN",
	"cross-org service binding": "FORBIDDEN",
	"cross-org service binding forwarding a platform tedi": "allow",
	"cross-org service binding from the operator MCP app": "FORBIDDEN",
	"operator MCP app slug on a user call": "FORBIDDEN",
	"self tedi": "allow",
	"self tedi without organization": "UNAUTHORIZED",
	"self tedi with a cross-org context": "FORBIDDEN",
	"sibling tedi in the same org": "allow",
	"sibling platform tedi in the same org": "allow",
	"cross-org tedi": "FORBIDDEN",
	"user without organization": "UNAUTHORIZED",
	"platform-admin user without organization": "UNAUTHORIZED",
	"platform api key without organization": "UNAUTHORIZED",
	"missing tedi for a same-org user": "NOT_FOUND",
	"missing tedi for a cross-org user": "NOT_FOUND",
	"missing tedi for a user without organization": "UNAUTHORIZED",
	"missing tedi for a platform api key without organization": "UNAUTHORIZED",
};

describe("tedis requireTediAccess matrix", () => {
	it.each(TEDI_ACCESS_CASES)("$name", async (row) => {
		getTediById.mockImplementation(lookupTediAccessTarget);
		const call = requireTediAccess(
			tediAccessContext(row.context),
			"tediId" in row ? row.tediId : TEDI_ACCESS_TARGET.id,
		);
		const outcome = EXPECTED[row.name];
		if (outcome === "allow") {
			await expect(call).resolves.toMatchObject({ id: TEDI_ACCESS_TARGET.id });
		} else {
			await expect(call).rejects.toMatchObject({ code: outcome });
		}
	});
});
