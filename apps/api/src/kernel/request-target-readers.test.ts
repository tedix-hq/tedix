import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { KernelRequestPolicy } from "@tedix/api-contract/schemas/kernel-request";
import type { BaseContext } from "../rpc/orpc";
import { kernelAcceptanceReader } from "./request-target-readers";
const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	access: vi.fn(),
	output: vi.fn(),
	workspace: vi.fn(),
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
}));
vi.mock("./conversation-access", () => ({
	resolveKernelConversationAccess: mocks.access,
}));
vi.mock("@tedix/db/queries/os-workspaces/outputs", () => ({
	getOsOutput: mocks.output,
}));
vi.mock("@tedix/db/queries/os-workspaces/workspaces", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/os-workspaces/workspaces")
	>()),
	getOsWorkspace: mocks.workspace,
}));
const source = {
	organizationId: "org-example",
	ownerUserId: "user-ada",
	conversationId: "home-one",
};
const context = { db: {} } as BaseContext;
const sha = "a".repeat(40);
const policy: KernelRequestPolicy = {
	version: 1,
	enabled: true,
	nextOwner: "kernel",
	retryMs: 1000,
	probeTimeoutMs: 1000,
	maxProbeAttempts: 3,
	runBudgetMs: 1000,
	repositoryTargets: [
		{
			id: "repo-one",
			repository: "example/product",
			shipRepository: "example/operations",
			workflowId: "ship.yml",
			surface: "app",
			liveManifestUrl: "https://app.example.com/build.json",
			maxAgeMs: 60_000,
		},
	],
};
const outputCheck = {
	kind: "os_output_revision" as const,
	outputId: "output-one",
	revisionId: "revision-one",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.member.mockResolvedValue({ status: "active" });
	mocks.access.mockResolvedValue({ allowed: true });
	mocks.output.mockResolvedValue({
		id: "output-one",
		status: "active",
		workspaceId: "workspace-one",
		currentRevisionId: "revision-one",
	});
	mocks.workspace.mockResolvedValue({
		id: "workspace-one",
		visibility: "private",
		ownerUserId: source.ownerUserId,
	});
});
describe("trusted request target readers", () => {
	it("reads actual OS state under the current tenant and private workspace ACL", async () => {
		const reader = kernelAcceptanceReader(context, source, policy);
		expect((await reader.readOutputRevision(outputCheck)).revisionId).toBe(
			"revision-one",
		);
		expect(mocks.output).toHaveBeenCalledWith(context.db, {
			organizationId: source.organizationId,
			outputId: outputCheck.outputId,
		});
		mocks.workspace.mockResolvedValue({
			id: "workspace-one",
			visibility: "private",
			ownerUserId: "user-other",
		});
		await expect(reader.readOutputRevision(outputCheck)).rejects.toThrow(
			"denied",
		);
	});
	it("rejects revoked membership and source conversation access before reading targets", async () => {
		const reader = kernelAcceptanceReader(context, source, policy);
		mocks.member.mockResolvedValue({ status: "inactive" });
		await expect(reader.readOutputRevision(outputCheck)).rejects.toThrow(
			"active member",
		);
		mocks.member.mockResolvedValue({ status: "active" });
		mocks.access.mockResolvedValue({ allowed: false });
		await expect(reader.readOutputRevision(outputCheck)).rejects.toThrow(
			"revoked",
		);
		expect(mocks.output).not.toHaveBeenCalled();
	});
	it("ties successful Ship logs to the exact product SHA and live deployment manifest", async () => {
		const fetchFn = vi.fn(async (url: string | URL | Request) => {
			const path = String(url);
			if (path.endsWith("/commits/main")) return Response.json({ sha });
			if (path.includes("/runs?"))
				return Response.json({
					workflow_runs: [
						{
							id: 7,
							conclusion: "success",
							html_url: "https://github.com/example/operations/actions/runs/7",
							updated_at: new Date().toISOString(),
						},
					],
				});
			if (path.endsWith("build.json"))
				return Response.json({
					repository: "example/product",
					commitSha: sha,
					surface: "app",
					deploymentRunId: 7,
				});
			if (path.includes("/jobs?"))
				return Response.json({ jobs: [{ id: 9, conclusion: "success" }] });
			if (path.endsWith("/logs"))
				return new Response(`timestamp verified: app is live on ${sha}\n`);
			throw new Error("unexpected target");
		}) as typeof fetch;
		const reader = kernelAcceptanceReader(context, source, policy, fetchFn);
		expect(
			await reader.readRepositoryDelivery({
				kind: "repository_delivery",
				targetId: "repo-one",
				commitSha: sha,
				surface: "app",
			}),
		).toMatchObject({
			mainSha: sha,
			shipSha: sha,
			liveSha: sha,
			surface: "app",
			shipStatus: "success",
		});
	});
	it("does not accept an unconfigured target or generic healthy response as deployment proof", async () => {
		const fetchFn = vi.fn(async () =>
			Response.json({ healthy: true }),
		) as typeof fetch;
		const reader = kernelAcceptanceReader(context, source, policy, fetchFn);
		await expect(
			reader.readRepositoryDelivery({
				kind: "repository_delivery",
				targetId: "other",
				commitSha: sha,
				surface: "app",
			}),
		).rejects.toThrow("not configured");
		expect(fetchFn).not.toHaveBeenCalled();
		await expect(
			reader.readRepositoryDelivery({
				kind: "repository_delivery",
				targetId: "repo-one",
				commitSha: sha,
				surface: "app",
			}),
		).rejects.toThrow();
	});
});
