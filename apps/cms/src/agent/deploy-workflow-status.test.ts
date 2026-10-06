import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {},
	DurableObject: class {},
	WorkflowEntrypoint: class {},
}));
vi.mock("cloudflare:workflows", () => ({
	NonRetryableError: class extends Error {},
}));
vi.mock("@cloudflare/sandbox", () => ({ DirectoryBackupGateway: class {} }));
vi.mock("@tedix/container-runtime/sandbox", () => ({
	NativeContainerSandbox: class {},
}));
vi.mock("./deploy-workflow", () => ({
	DeployWorkflow: class {},
	deployStatusKey: (id: string) => id,
}));
vi.mock("./image-generation-workflow", () => ({
	ImageGenerationWorkflow: class {},
	imageGenerationStatusKey: vi.fn(),
}));
vi.mock("../container/site-builder-sandbox", () => ({
	SiteBuilderSandboxRuntime: class {},
}));
vi.mock("../sandbox", () => ({ getSiteBuilderSandbox: vi.fn() }));
const bundles = vi.hoisted(() => vi.fn());
vi.mock("@tedix/provisioning/cms", () => ({
	deprovisionCms: vi.fn(),
	listTenantBundleVersions: bundles,
}));
import { mapWorkflowStatus } from "../index";
function fixture(active: number, etag = "published", history: unknown[] = []) {
	bundles.mockResolvedValue([{ version: active, etag, isActive: true }]);
	return {
		DB: {},
		BUNDLES_BUCKET: {},
		DEPLOY_WORKFLOW: {
			get: async () => ({
				status: async () => ({
					status: "complete",
					output: { version: 3, etag: "published", url: "https://acme.test" },
				}),
			}),
		},
		SITE_BUILDER_STORAGE: {
			get: async () => ({
				json: async () => ({
					phase: "complete",
					message: "Deploy completed",
					history,
				}),
			}),
		},
	} as any;
}
describe("deployment status reflects activation", () => {
	it("rejects historical false completion after rollback", async () => {
		const status = await mapWorkflowStatus(fixture(2), "job", "acme");
		expect(status.status).toBe("failed");
		expect(status.output).toBeUndefined();
	});
	it("does not hide a health rollback behind later success callbacks", async () => {
		const status = await mapWorkflowStatus(
			fixture(4, "newer", [
				{
					phase: "health-check",
					status: "failed",
					details: { rolledBackTo: 2 },
				},
				{ phase: "health-check", status: "complete" },
			]),
			"job",
			"acme",
		);
		expect(status.status).toBe("failed");
		expect(status.output).toBeUndefined();
	});
	it("preserves historical success when a later deployment supersedes it", async () => {
		const status = await mapWorkflowStatus(fixture(4, "newer"), "job", "acme");
		expect(status.status).toBe("complete");
		expect(status.output?.version).toBe(3);
		expect(status.message).toContain("superseded");
		expect(status.details?.activeVersion).toBe(4);
	});
	it("projects internal Workflow etag out of the public status output", async () => {
		const status = await mapWorkflowStatus(fixture(3), "job", "acme");
		expect(status.output).toEqual({ version: 3, url: "https://acme.test" });
	});
	it("checks the etag of an active deployment", async () => {
		expect(
			(await mapWorkflowStatus(fixture(3, "different"), "job", "acme")).status,
		).toBe("failed");
		expect((await mapWorkflowStatus(fixture(3), "job", "acme")).status).toBe(
			"complete",
		);
	});
});
