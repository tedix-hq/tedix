import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
const reads = vi.hoisted(() => ({ batch: vi.fn(), single: vi.fn() }));
vi.mock("@tedix/db/queries/app-records", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getAppsBySlugsWithTools: reads.batch,
	getAppBySlugWithTools: reads.single,
}));
import {
	getBySlugWithToolsProcedure,
	getBySlugsWithToolsProcedure,
} from "./apps";

function client(
	privileged?: "service-binding" | "platform",
	actor: Partial<BaseContext> = {},
) {
	const context = {
		authType: privileged === "service-binding" ? "service-binding" : "user",
		db: {},
		env: {},
		headers: new Headers(
			privileged === "service-binding" ? { "X-Service-Binding": "true" } : {},
		),
		url: new URL("https://api.example/rpc/apps"),
		organizationId: "org-caller",
		userId: "user-caller",
		tediScopes: privileged === "service-binding" ? ["apps:read"] : [],
		user:
			privileged === "service-binding"
				? undefined
				: {
						sub: "user-caller",
						permissions: ["apps:read"],
						roles: [],
						...(privileged === "platform" ? { scope: "platform:admin" } : {}),
					},
		...actor,
	} as unknown as BaseContext;
	return createRouterClient(
		{
			single: getBySlugWithToolsProcedure,
			batch: getBySlugsWithToolsProcedure,
		},
		{ context },
	);
}

beforeEach(() => {
	reads.batch.mockReset().mockResolvedValue([null]);
	reads.single.mockReset().mockResolvedValue(null);
});
describe("aggregate read caller boundary", () => {
	it.each([undefined, "org-privileged"])(
		"binds a tenant batch to its organization despite host %s",
		async (hostOrganizationId) => {
			await client().batch({
				apps: [{ slug: "foreign-private", hostOrganizationId }],
			});
			expect(reads.batch.mock.calls[0]?.[1]).toEqual([
				{ slug: "foreign-private", hostOrganizationId: "org-caller" },
			]);
		},
	);
	it.each([undefined, "org-privileged"])(
		"binds single-slug tenant reads to the same aggregate authority despite host %s",
		async (hostOrganizationId) => {
			await client().single({ slug: "foreign-private", hostOrganizationId });
			expect(reads.batch.mock.calls[0]?.[1]).toEqual([
				{ slug: "foreign-private", hostOrganizationId: "org-caller" },
			]);
			expect(reads.single).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ externalAgentPrincipalId: "agent-caller" },
		{ tediId: "tedi-caller" },
		{ gatewayEndUserId: "human-caller" },
	])(
		"does not give forwarded service actors unscoped discovery: %j",
		async (actor) => {
			await client("service-binding", actor).batch({
				apps: [{ slug: "private", hostOrganizationId: "org-privileged" }],
			});
			expect(reads.batch.mock.calls[0]?.[1]).toEqual([
				{ slug: "private", hostOrganizationId: "org-caller" },
			]);
		},
	);
	it.each(["service-binding", "platform"] as const)(
		"preserves trusted %s discovery",
		async (principal) => {
			await client(principal).batch({ apps: [{ slug: "shared" }] });
			expect(reads.batch.mock.calls[0]?.[1]).toEqual([{ slug: "shared" }]);
			await client(principal).single({ slug: "shared" });
			expect(reads.single).toHaveBeenCalledOnce();
		},
	);
});
