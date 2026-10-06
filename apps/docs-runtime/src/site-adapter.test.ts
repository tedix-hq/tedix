import { getRuntimeDocsSiteBySlug as queryRuntimeDocsSiteBySlug } from "@tedix/db/queries/docs-sites/sites";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getRuntimeDocsSiteBySlug } from "./site-adapter";

vi.mock("@tedix/db/queries/docs-sites/sites", () => ({
	getRuntimeDocsSiteBySlug: vi.fn(),
}));

const query = vi.mocked(queryRuntimeDocsSiteBySlug);
const db = {} as Parameters<typeof getRuntimeDocsSiteBySlug>[0];

describe("getRuntimeDocsSiteBySlug", () => {
	beforeEach(() => {
		query.mockReset();
	});

	it("maps the inferred persistence row to the serving-plane view", async () => {
		query.mockResolvedValue({
			id: "site-1",
			orgSlug: "acme",
			slug: "handbook",
			status: "active",
			accessMode: "organization",
			activeBuildId: "build-1",
			descopeTenantId: "org_acme",
		});

		await expect(getRuntimeDocsSiteBySlug(db, "handbook")).resolves.toEqual({
			id: "site-1",
			orgSlug: "acme",
			slug: "handbook",
			status: "active",
			accessMode: "organization",
			activeBuildId: "build-1",
			descopeTenantId: "org_acme",
		});
		expect(query).toHaveBeenCalledWith(db, "handbook");
	});

	it("preserves a missing site", async () => {
		query.mockResolvedValue(null);
		await expect(getRuntimeDocsSiteBySlug(db, "missing")).resolves.toBeNull();
	});
});
