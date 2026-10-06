import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	getAuthority: vi.fn(),
	getAttempt: vi.fn(),
	inspect: vi.fn(),
}));

vi.mock("@tedix/db/client", () => ({ createDbClient: () => "db" }));
vi.mock("@tedix/db/queries/workstations", () => ({
	getWorkstationInspectionAuthority: mocks.getAuthority,
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	getAuthoritativeWorkItemAttempt: mocks.getAttempt,
}));
vi.mock("../../workstation/computer-body", () => ({
	inspectWorkstationRepository: mocks.inspect,
}));

import { inspectRepositoryRoute } from "./workstation-inspection";

const authority = (overrides: Record<string, unknown> = {}) => ({
	workstation: { id: "ws-1" },
	workstationLease: {
		id: "lease-1",
		bodyGenerationId: "generation-1",
		bodyInstanceName: "body-1",
		repositoryPath: "tedix/tedix",
		preparedStartSha: "a".repeat(40),
		...overrides,
	},
});

function context(body: Record<string, unknown>) {
	const values: Record<string, unknown> = {
		tediConfig: { id: "tedi-1", organizationId: "org-1" },
		workstationBodyInstance: { name: "body-1" },
		sandbox: "sandbox",
	};
	return {
		req: { json: async () => body },
		env: { DB: "binding" },
		get: (key: string) => values[key],
		json: (value: unknown, status = 200) => Response.json(value, { status }),
	} as never;
}

const request = (overrides: Record<string, unknown> = {}) => ({
	operation: "diff",
	path: "src/index.ts",
	leaseId: "lease-1",
	workItemId: "work-1",
	attemptId: "attempt-1",
	generationId: "generation-1",
	...overrides,
});

describe("workstation repository inspection authority", () => {
	beforeEach(() => {
		mocks.getAuthority.mockReset();
		mocks.getAttempt.mockReset().mockResolvedValue({ id: "attempt-1" });
		mocks.inspect.mockReset().mockResolvedValue({ kind: "git" });
		mocks.getAuthority.mockResolvedValue(authority());
	});

	it("uses only the server-bound path and baseline on a valid read", async () => {
		const response = await inspectRepositoryRoute(
			context(
				request({
					repositoryPath: "attacker/repo",
					baselineSha: "b".repeat(40),
				}),
			),
		);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as Record<string, unknown>;
		expect(payload).toMatchObject({
			baselineSha: "a".repeat(40),
			generationId: "generation-1",
			nonAtomic: true,
		});
		expect(mocks.inspect).toHaveBeenCalledWith("sandbox", {
			operation: "diff",
			path: "src/index.ts",
			repositoryPath: "tedix/tedix",
			baselineSha: "a".repeat(40),
		});
	});

	it.each([
		["legacy/unbound", authority({ preparedStartSha: null })],
		["stale generation", authority({ bodyGenerationId: "old" })],
		["stale body", authority({ bodyInstanceName: "other" })],
	])("rejects %s authority before native execution", async (_label, value) => {
		mocks.getAuthority.mockResolvedValue(value);
		const response = await inspectRepositoryRoute(context(request()));
		expect(response.status).toBe(409);
		expect(mocks.inspect).not.toHaveBeenCalled();
	});

	it("rejects an attempt with the wrong executor", async () => {
		mocks.getAttempt.mockRejectedValue(new Error("executor mismatch"));
		const response = await inspectRepositoryRoute(context(request()));
		expect(response.status).toBe(409);
		expect(mocks.getAttempt).toHaveBeenCalledWith(
			"db",
			expect.objectContaining({
				orgId: "org-1",
				workItemId: "work-1",
				attemptId: "attempt-1",
				executor: { type: "tedi", id: "tedi-1" },
			}),
		);
	});

	it("discards native output when authority changes during inspection", async () => {
		mocks.getAuthority
			.mockResolvedValueOnce(authority())
			.mockResolvedValueOnce(authority({ preparedStartSha: "c".repeat(40) }));
		const response = await inspectRepositoryRoute(context(request()));
		expect(response.status).toBe(409);
	});
});
