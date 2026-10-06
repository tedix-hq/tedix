import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	getAttempt: vi.fn(),
	getLease: vi.fn(),
	getOrganization: vi.fn(),
	getTedi: vi.fn(),
}));

vi.mock("@tedix/db/client", () => ({ createDbClient: () => "db" }));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.getOrganization,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.getTedi,
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	getAuthoritativeWorkItemAttempt: mocks.getAttempt,
}));
vi.mock("@tedix/db/queries/workstations", () => ({
	getWorkstationLeaseBundle: mocks.getLease,
}));

import { githubCredentialAuthority } from "./github-credential-authority";

const BODY = {
	attemptId: "attempt_test",
	installationId: 987,
	leaseId: "lease_test",
	organizationId: "org_test",
	repository: "tedix/tedix",
	repositoryId: 123,
	tediId: "tedi_test",
	workItemId: "work_test",
	workstationId: "ws_test",
};

function request(overrides: Record<string, unknown> = {}) {
	return new Request("https://tedi/internal/workstation/github/authorize", {
		body: JSON.stringify({ ...BODY, ...overrides }),
		headers: {
			"Content-Type": "application/json",
			"X-Service-Binding": "true",
		},
		method: "POST",
	});
}

describe("GitHub credential authority", () => {
	beforeEach(() => {
		mocks.getAttempt.mockReset().mockResolvedValue({ id: "attempt_test" });
		mocks.getOrganization.mockReset().mockResolvedValue({
			id: "org_test",
			metadata: { githubWorkstationCredentials: { enabled: true } },
		});
		mocks.getTedi.mockReset().mockResolvedValue({
			id: "tedi_test",
			repoConfig: {
				branch: "main",
				githubAppEnabled: true,
				githubInstallationId: 987,
				githubRepositoryId: 123,
				repoUrl: "https://github.com/tedix/tedix.git",
			},
			retiredAt: null,
			status: "active",
		});
		mocks.getLease.mockReset().mockResolvedValue({
			workstation: { id: "ws_test" },
			workstationLease: {
				attemptId: "attempt_test",
				orgId: "org_test",
				participants: [{ status: "active", tediId: "tedi_test" }],
				status: "active",
				workItemId: "work_test",
				workstationId: "ws_test",
			},
		});
	});

	it("authorizes only the exact live lease, attempt fence, and repository IDs", async () => {
		const response = await githubCredentialAuthority.request(
			request(),
			undefined,
			{
				DB: {} as D1Database,
				ENVIRONMENT: "test",
			} as never,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			authorized: true,
			installationId: 987,
			repositoryId: 123,
		});
		expect(mocks.getAttempt).toHaveBeenCalledWith("db", {
			attemptId: "attempt_test",
			executor: { id: "tedi_test", type: "tedi" },
			orgId: "org_test",
			workItemId: "work_test",
		});
	});

	it("fails closed when the admitted attempt fence is no longer authoritative", async () => {
		mocks.getAttempt.mockRejectedValue(new Error("stale fence"));
		const response = await githubCredentialAuthority.request(
			request(),
			undefined,
			{
				DB: {} as D1Database,
				ENVIRONMENT: "test",
			} as never,
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			authorized: false,
			reason: "attempt_not_authoritative",
		});
	});

	it.each([
		["organization", { enabled: false }, "organization_disabled"],
		[
			"installation",
			{ enabled: true, disabledInstallationIds: [987] },
			"installation_disabled",
		],
		[
			"repository",
			{ enabled: true, disabledRepositoryIds: [123] },
			"repository_disabled",
		],
	] as const)(
		"enforces the %s kill control",
		async (_label, controls, reason) => {
			mocks.getOrganization.mockResolvedValue({
				id: "org_test",
				metadata: { githubWorkstationCredentials: controls },
			});
			const response = await githubCredentialAuthority.request(
				request(),
				undefined,
				{
					DB: {} as D1Database,
					ENVIRONMENT: "test",
				} as never,
			);

			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				authorized: false,
				reason,
			});
		},
	);
});
