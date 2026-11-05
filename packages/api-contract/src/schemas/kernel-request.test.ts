import { describe, expect, it } from "vite-plus/test";
import { KernelRequestPolicySchema } from "./kernel-request";

const reference = {
	organizationId: "org-example",
	providerId: "github-pat-key",
	scope: "tenant",
	accountRevisionDigest: "a".repeat(64),
};
const target = {
	id: "api",
	repository: "example/product",
	shipRepository: "example/ops",
	workflowId: "ship.yml",
	surface: "api",
	liveManifestUrl: "https://api.example.com/release-manifest.json",
	maxAgeMs: 60000,
};
const policy = {
	version: 1,
	enabled: true,
	nextOwner: "kernel",
	retryMs: 1000,
	probeTimeoutMs: 1000,
	maxProbeAttempts: 3,
	runBudgetMs: 1000,
	repositoryTargets: [target],
};

describe("registered default tenant credential", () => {
	it("accepts an explicit revision-pinned organization default without changing anonymous or named targets", () => {
		expect(KernelRequestPolicySchema.safeParse(policy).success).toBe(true);
		expect(
			KernelRequestPolicySchema.safeParse({
				...policy,
				repositoryTargets: [{ ...target, connectionInstanceId: "named-slot" }],
			}).success,
		).toBe(true);
		expect(
			KernelRequestPolicySchema.safeParse({
				...policy,
				repositoryTargets: [{ ...target, defaultTenantCredential: reference }],
			}).success,
		).toBe(true);
	});
	it.each([
		{ ...reference, accountRevisionDigest: undefined },
		{ ...reference, scope: "user", userId: "user-ada" },
		{
			...reference,
			connectionInstanceId: "00000000-0000-4000-8000-000000000001",
		},
		{ ...reference, secret: "must-not-be-accepted" },
	])(
		"refuses an unpinned, personal, named, or unknown reference",
		(defaultTenantCredential) => {
			expect(
				KernelRequestPolicySchema.safeParse({
					...policy,
					repositoryTargets: [{ ...target, defaultTenantCredential }],
				}).success,
			).toBe(false);
		},
	);
	it("rejects mixed default and named selection", () => {
		expect(
			KernelRequestPolicySchema.safeParse({
				...policy,
				repositoryTargets: [
					{
						...target,
						defaultTenantCredential: reference,
						connectionInstanceId: "named-slot",
					},
				],
			}).success,
		).toBe(false);
	});
});
