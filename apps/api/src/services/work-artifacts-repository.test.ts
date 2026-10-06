import { describe, expect, it, vi } from "vite-plus/test";
import { provisionWorkAttemptRepository } from "./work-artifacts-repository";

const IDS = {
	workItemId: "22222222-2222-4222-8222-222222222222",
	admissionId: "33333333-3333-4333-8333-333333333333",
	attemptId: "11111111-1111-4111-8111-111111111111",
};

function params(overrides: Record<string, unknown> = {}) {
	return {
		artifacts: undefined,
		enabled: true,
		request: { mode: "create" as const },
		...IDS,
		workItemVersion: 4,
		admissionSpecRevision: "spec-4",
		observedAt: "2026-10-01T00:00:00.000Z",
		...overrides,
	};
}

describe("Work Attempt Artifacts repositories", () => {
	it("creates a deterministic repo and discards its initial token", async () => {
		const create = vi.fn().mockResolvedValue({
			id: "repo-1",
			name: `work-22222222-${IDS.attemptId}`,
			remote: "https://example.artifacts.cloudflare.net/git/tedix/repo.git",
			defaultBranch: "main",
			token: "secret-token",
		});
		const get = vi.fn().mockRejectedValue({ code: "NOT_FOUND" });
		const result = await provisionWorkAttemptRepository(
			params({ artifacts: { create, get } }),
		);
		expect(result).toMatchObject({
			status: "ready",
			repositoryId: "repo-1",
			attemptId: IDS.attemptId,
			baseRevision: null,
		});
		expect(result).not.toHaveProperty("token");
		expect(create).toHaveBeenCalledWith(
			`work-22222222-${IDS.attemptId}`,
			expect.objectContaining({ setDefaultBranch: "main" }),
		);
	});

	it("forks the exact resolved source revision", async () => {
		const fork = vi.fn().mockResolvedValue({
			id: "repo-fork",
			name: `work-22222222-${IDS.attemptId}`,
			remote: "https://example.artifacts.cloudflare.net/git/tedix/fork.git",
			defaultBranch: "main",
			token: "secret-token",
		});
		const source = {
			log: vi.fn().mockResolvedValue([{ hash: "a".repeat(40) }]),
			fork,
			info: vi.fn().mockResolvedValue({ defaultBranch: "main" }),
		};
		const get = vi
			.fn()
			.mockRejectedValueOnce({ code: "NOT_FOUND" })
			.mockResolvedValueOnce(source);
		const result = await provisionWorkAttemptRepository(
			params({
				artifacts: { create: vi.fn(), get },
				request: {
					mode: "fork",
					sourceRepositoryName: "tedix-main",
					sourceRef: "main",
					expectedBaseRevision: "a".repeat(40),
				},
			}),
		);
		expect(result).toMatchObject({
			status: "ready",
			baseRevision: "a".repeat(40),
			sourceRepositoryName: "tedix-main",
		});
		expect(fork).toHaveBeenCalledWith(
			`work-22222222-${IDS.attemptId}`,
			expect.objectContaining({ defaultBranchOnly: true }),
		);
	});

	it("fails closed when disabled or when the source revision moved", async () => {
		const disabled = await provisionWorkAttemptRepository(
			params({ enabled: false }),
		);
		expect(disabled).toMatchObject({
			status: "unavailable",
			reason: "Work Attempt Artifacts repositories are disabled",
		});

		const source = {
			log: vi.fn().mockResolvedValue([{ hash: "b".repeat(40) }]),
			fork: vi.fn(),
			info: vi.fn().mockResolvedValue({ defaultBranch: "main" }),
		};
		const moved = await provisionWorkAttemptRepository(
			params({
				artifacts: {
					create: vi.fn(),
					get: vi
						.fn()
						.mockRejectedValueOnce({ code: "NOT_FOUND" })
						.mockResolvedValueOnce(source),
				},
				request: {
					mode: "fork",
					sourceRepositoryName: "tedix-main",
					sourceRef: "main",
					expectedBaseRevision: "a".repeat(40),
				},
			}),
		);
		expect(moved).toMatchObject({
			status: "unavailable",
			reason: "Source ref changed before repository provisioning",
		});
		expect(source.fork).not.toHaveBeenCalled();
	});
});
