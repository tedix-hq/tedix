import { call, os } from "@orpc/server";
import { type BaseContext, withAuth } from "./orpc";
import { describe, expect, it, vi } from "vite-plus/test";
import { requireTediAccess } from "./tedi-access";
import { tediAccessContext } from "./tedi-access-test-cases";

const reads = vi.hoisted(() => ({ global: vi.fn(), tenant: vi.fn() }));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediById: reads.global,
	getTediByIdForOrganization: reads.tenant,
}));

describe.each(["exclusive", "self-or-platform"] as const)(
	"%s caller scope",
	(tediIdentity) => {
		it.each(["existing-target", "missing-target"])(
			"rejects missing organization before reading %s",
			async (id) => {
				vi.clearAllMocks();
				await expect(
					requireTediAccess(tediAccessContext({ authType: "user" }), id, {
						scope: "principal",
						tediIdentity,
						platformAuthority: "platform-principal",
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				expect(reads.global).not.toHaveBeenCalled();
				expect(reads.tenant).not.toHaveBeenCalled();
			},
		);
		it.each(["existing-target", "missing-target"])(
			"rejects another tedi identity before reading %s",
			async (id) => {
				vi.clearAllMocks();
				await expect(
					requireTediAccess(
						tediAccessContext({
							authType: "tedi",
							tediId: "caller",
							organizationId: "org",
						}),
						id,
						{
							scope: "principal",
							tediIdentity,
							platformAuthority: "platform-principal",
						},
					),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				expect(reads.global).not.toHaveBeenCalled();
				expect(reads.tenant).not.toHaveBeenCalled();
			},
		);
	},
);

it.each([undefined, "mcp-edge"] as const)(
	"authenticates system-header tedi reads only for the configured MCP principal: %s",
	async (principal) => {
		vi.clearAllMocks();
		reads.global.mockResolvedValue({
			id: "target",
			organizationId: "org-target",
		});
		const guarded = os
			.$context<BaseContext>()
			.use(withAuth)
			.handler(({ context }) =>
				requireTediAccess(context, "target", {
					scope: "organization",
					missingOrganizationCode: "FORBIDDEN",
					platformAuthority: "platform-principal",
					allowMcpIdentityResolve: true,
				}),
			);
		const context = tediAccessContext({
			env: { ENVIRONMENT: "production" } as CloudflareEnv,
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": "system",
				"X-Tedix-Service-Principal": "mcp-edge",
			}),
			serviceBindingPrincipal: principal,
		});
		const result = call(guarded, undefined, { context });
		if (principal)
			await expect(result).resolves.toMatchObject({ id: "target" });
		else {
			await expect(result).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(reads.global).not.toHaveBeenCalled();
		}
	},
);
