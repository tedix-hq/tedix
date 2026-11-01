import { call, os } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { stripServiceBindingMarker } from "@tedix/worker-kit/request-auth";
import { requireOrgId, requireTediRequestIdentity } from "./org-scope";
import { type BaseContext, withTediAuth } from "./orpc";

const organizations = vi.hoisted(() => ({
	byId: vi.fn(),
	byDescopeId: vi.fn(),
}));
vi.mock("@tedix/db/queries/organizations", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: organizations.byId,
	getOrganizationByDescopeId: organizations.byDescopeId,
}));

const guarded = os
	.$context<BaseContext>()
	.use(withTediAuth)
	.handler(({ context }) => {
		requireTediRequestIdentity(context, "tedi");
		return requireOrgId(context);
	});

function context(headers: Record<string, string> = {}): BaseContext {
	return {
		db: {},
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Tedi-Id": "tedi",
			...headers,
		}),
	} as BaseContext;
}

beforeEach(() => {
	vi.clearAllMocks();
	organizations.byId.mockResolvedValue({ id: "canonical-org" });
	organizations.byDescopeId.mockResolvedValue({ id: "canonical-org" });
});

describe("tedi service-binding organization scope", () => {
	it("resolves a trusted binding's organization before record guards run", async () => {
		const ctx = context({ "X-Tedix-Org-Id": "requested-org" });
		await expect(call(guarded, undefined, { context: ctx })).resolves.toBe(
			"canonical-org",
		);
		expect(organizations.byId).toHaveBeenCalledWith(ctx.db, "requested-org");
		expect(ctx.authType).toBe("service-binding");
		expect(ctx.organizationId).toBe("canonical-org");
	});

	it("resolves a tenant header to its canonical organization", async () => {
		const ctx = context({ "X-Tedix-Org-Id": "org_fixture" });
		await expect(call(guarded, undefined, { context: ctx })).resolves.toBe(
			"canonical-org",
		);
		expect(organizations.byDescopeId).toHaveBeenCalledWith(
			ctx.db,
			"org_fixture",
		);
	});

	it("never replaces an organization already established by the caller", async () => {
		const ctx = context({ "X-Tedix-Org-Id": "another-org" });
		ctx.organizationId = "established-org";
		await expect(call(guarded, undefined, { context: ctx })).resolves.toBe(
			"established-org",
		);
		expect(organizations.byId).not.toHaveBeenCalled();
		expect(organizations.byDescopeId).not.toHaveBeenCalled();
	});

	it("does not invent organization scope when the header is absent", async () => {
		await expect(
			call(guarded, undefined, { context: context() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(organizations.byId).not.toHaveBeenCalled();
	});

	it("still rejects a different tedi identity", async () => {
		const ctx = context({
			"X-Tedix-Org-Id": "requested-org",
			"X-Tedix-Tedi-Id": "another-tedi",
		});
		await expect(
			call(guarded, undefined, { context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("does not trust organization headers from public ingress", async () => {
		const ctx = context({ "X-Tedix-Org-Id": "requested-org" });
		ctx.headers = stripServiceBindingMarker(
			new Request("https://api.example/rpc/test", { headers: ctx.headers }),
		).headers;
		await expect(
			call(guarded, undefined, { context: ctx }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(organizations.byId).not.toHaveBeenCalled();
	});
});
