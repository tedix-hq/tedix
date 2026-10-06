import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	author: vi.fn(),
	attempt: vi.fn(),
	authority: vi.fn(),
	tedi: vi.fn(),
	fetch: vi.fn(),
}));

vi.mock("./policy-helpers", async (original) => ({
	...(await original<Record<string, unknown>>()),
	assertWorkItemAccess: mocks.access,
	requireOwnerAdminWorkItemAuthor: mocks.author,
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	getAuthoritativeWorkItemAttempt: mocks.attempt,
}));
vi.mock("@tedix/db/queries/workstations", () => ({
	getWorkstationInspectionAuthority: mocks.authority,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
}));

import { inspectAttemptRepository } from "./workstation-inspection";

const validResult = {
	baselineSha: "a".repeat(40),
	currentSha: "b".repeat(40),
	generationId: "generation-1",
	observedAt: "2026-09-22T00:00:00.000Z",
	nonAtomic: true,
	kind: "git",
	dataBase64: "",
	stderrBase64: "",
	exitCode: 0,
	timedOut: false,
	truncated: false,
	truncationReasons: [],
	hunks: [],
};

function args() {
	return {
		input: {
			id: "11111111-1111-4111-8111-111111111111",
			attemptId: "22222222-2222-4222-8222-222222222222",
			operation: "diff" as const,
			path: "src/index.ts",
		},
		context: {
			db: "db",
			user: { id: "owner-1" },
			userRole: "owner",
			env: { TEDI_SERVICE: { fetch: mocks.fetch } },
		},
	} as never;
}

describe("OS repository inspection proxy", () => {
	beforeEach(() => {
		mocks.access
			.mockReset()
			.mockResolvedValue({ id: "work-1", orgId: "org-1" });
		mocks.author.mockReset().mockResolvedValue("owner-1");
		mocks.attempt.mockReset().mockResolvedValue({
			id: "attempt-1",
			executorType: "tedi",
			executorId: "tedi-1",
		});
		mocks.tedi.mockReset().mockResolvedValue({ id: "tedi-1", slug: "cto" });
		mocks.authority.mockReset().mockResolvedValue({
			workstation: { id: "ws-1" },
			workstationLease: { id: "lease-1", bodyGenerationId: "generation-1" },
		});
		mocks.fetch.mockReset().mockResolvedValue(Response.json(validResult));
	});

	it("forwards only server-derived tenant, lease, Work and generation authority", async () => {
		await expect(inspectAttemptRepository(args())).resolves.toEqual(
			validResult,
		);
		const request = mocks.fetch.mock.calls[0]![0] as Request;
		expect(request.headers.get("X-Tedix-Org-Id")).toBe("org-1");
		expect(request.headers.get("X-Tedix-Tedi-Id")).toBe("tedi-1");
		expect(await request.json()).toMatchObject({
			leaseId: "lease-1",
			workItemId: "work-1",
			generationId: "generation-1",
		});
	});

	it.each(["status", "diff", "read"])(
		"denies an ordinary same-org reader before %s reaches the provider",
		async (operation) => {
			mocks.author.mockRejectedValue(new Error("owner/admin required"));
			const request = args() as Parameters<typeof inspectAttemptRepository>[0];
			request.input.operation = operation as typeof request.input.operation;
			if (operation === "read") request.input.path = ".env";
			if (operation === "diff") request.input.path = "secrets.txt";
			await expect(inspectAttemptRepository(request)).rejects.toThrow(
				"owner/admin required",
			);
			expect(mocks.attempt).not.toHaveBeenCalled();
			expect(mocks.fetch).not.toHaveBeenCalled();
		},
	);

	it("denies an owner without explicit secrets authority before provider execution", async () => {
		const request = args() as Parameters<typeof inspectAttemptRepository>[0];
		request.context.userRole = "member";
		await expect(inspectAttemptRepository(request)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.attempt).not.toHaveBeenCalled();
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("denies a machine principal despite broad read scopes", async () => {
		mocks.author.mockRejectedValue(new Error("human membership required"));
		const request = args() as Parameters<typeof inspectAttemptRepository>[0];
		request.context.user = undefined;
		await expect(inspectAttemptRepository(request)).rejects.toThrow(
			"human membership required",
		);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it.each([
		[
			"wrong organization access",
			() => mocks.access.mockRejectedValue(new Error("denied")),
		],
		[
			"wrong attempt",
			() => mocks.attempt.mockRejectedValue(new Error("not active")),
		],
		[
			"wrong executor",
			() => mocks.attempt.mockResolvedValue({ executorType: "external_agent" }),
		],
		[
			"ambiguous or expired lease",
			() => mocks.authority.mockResolvedValue(null),
		],
	])("rejects %s without provider execution", async (_label, arrange) => {
		arrange();
		await expect(inspectAttemptRepository(args())).rejects.toThrow();
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("rejects a malformed typed provider response", async () => {
		mocks.fetch.mockResolvedValue(Response.json({ ok: true }));
		await expect(inspectAttemptRepository(args())).rejects.toThrow(
			"Invalid repository inspection response",
		);
	});

	it("returns a typed conflict for a stale attempt before provider execution", async () => {
		mocks.attempt.mockRejectedValue(
			Object.assign(new Error("Attempt is no longer authoritative"), {
				name: "WorkFactoryError",
				code: "STALE_ATTEMPT",
			}),
		);
		await expect(inspectAttemptRepository(args())).rejects.toMatchObject({
			code: "CONFLICT",
			message: "Attempt is no longer authoritative",
		});
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("does not disguise unexpected storage failures as stale authority", async () => {
		const error = new Error("storage unavailable");
		mocks.attempt.mockRejectedValue(error);
		await expect(inspectAttemptRepository(args())).rejects.toBe(error);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
});
