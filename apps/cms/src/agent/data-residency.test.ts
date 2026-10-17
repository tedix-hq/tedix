import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ site: vi.fn(), policy: vi.fn() }));
vi.mock("./storage", () => ({ getCmsTemplateSelection: mocks.site }));
vi.mock("@tedix/db/queries/data-residency", () => ({
	getOrganizationResidencyPolicy: mocks.policy,
}));
import { requireUnrestrictedCmsModels } from "./data-residency";
beforeEach(() => {
	vi.resetAllMocks();
	mocks.site.mockResolvedValue({ organizationId: "org_lark" });
});
describe("CMS model residency boundary", () => {
	it("blocks unverified text/image models for the site's canonical owner", async () => {
		mocks.policy.mockResolvedValue({ mode: "eu" });
		await expect(
			requireUnrestrictedCmsModels({} as never, "fictional-site"),
		).rejects.toThrow("EU_PROVIDER_ROUTE_REQUIRED");
		expect(mocks.policy.mock.calls[0]?.[1]).toBe("org_lark");
	});
	it("keeps missing and unrestricted policies unchanged", async () => {
		mocks.policy.mockResolvedValue(null);
		await requireUnrestrictedCmsModels({} as never, "fictional-site");
		mocks.policy.mockResolvedValue({ mode: "unrestricted" });
		await requireUnrestrictedCmsModels({} as never, "fictional-site");
	});
	it("fails closed when policy or site ownership cannot be read", async () => {
		mocks.policy.mockRejectedValue(Error("read unavailable"));
		await expect(
			requireUnrestrictedCmsModels({} as never, "fictional-site"),
		).rejects.toThrow();
		mocks.site.mockResolvedValue(null);
		await expect(
			requireUnrestrictedCmsModels({} as never, "fictional-site"),
		).rejects.toThrow("verified site owner");
	});
});
