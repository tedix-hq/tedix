import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	output: vi.fn(),
	object: vi.fn(),
	member: vi.fn(),
	validate: vi.fn(),
	revision: vi.fn(),
	authorize: vi.fn(),
}));
vi.mock("./rpc/orpc", async (original) => ({
	...(await original<Record<string, unknown>>()),
	authorizeOsOutputExportRecipient: mocks.authorize,
}));
vi.mock("@tedix/auth/jwt", async (original) => ({
	...(await original<Record<string, unknown>>()),
	validateToken: mocks.validate,
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/query-client", () => ({ createDbQueryClient: () => ({}) }));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationByDescopeId: async () => ({ id: "local-org" }),
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
}));
vi.mock("@tedix/db/queries/os-workspaces/outputs", () => ({
	getOsOutput: mocks.output,
	getOsOutputRevisionByNumber: mocks.revision,
}));

import worker from "./worker-app";

const env = {
	API_URL: "http://localhost:8790",
	OS_URL: "http://localhost:3030",
	ENVIRONMENT: "development",
	DESCOPE_PROJECT_ID: "local-development-disabled",
	TEDIX_LOCAL_DEMO_ENABLED: "true",
	R2_BUCKET: { get: mocks.object },
	API_RATE_LIMITER: { limit: async () => ({ success: true }) },
};
const request = (
	overrides = {},
	headers: Record<string, string> = {
		Authorization: "Bearer tedix-local-demo",
	},
) =>
	worker.fetch(
		new Request("http://api/os-exports/output-1/rev-2.docx", { headers }),
		{ ...env, ...overrides } as unknown as CloudflareEnv,
		{} as ExecutionContext,
	);
beforeEach(() => {
	vi.clearAllMocks();
	mocks.validate.mockRejectedValue(new Error("invalid token"));
	mocks.output.mockResolvedValue({ id: "output-1" });
	mocks.revision.mockResolvedValue({
		id: "revision-2",
		accessEnvelope: '{"version":1,"sources":[]}',
	});
	mocks.authorize.mockResolvedValue(true);
	mocks.member.mockResolvedValue(null);
	mocks.object.mockResolvedValue({ body: "docx-bytes", size: 10 });
});
describe("authenticated output exports", () => {
	it("serves the local owner's export through the internal OS proxy", async () => {
		const response = await request();
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("docx-bytes");
		expect(response.headers.get("Content-Disposition")).toBe(
			'attachment; filename="rev-2.docx"',
		);
		expect(mocks.output).toHaveBeenCalledWith(
			{},
			{ organizationId: "local-org", outputId: "output-1" },
		);
		expect(mocks.object).toHaveBeenCalledWith(
			"os-exports/local-org/output-1/rev-2.docx",
		);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(mocks.validate).not.toHaveBeenCalled();
	});
	it("denies retained export bytes after source access is revoked", async () => {
		mocks.authorize.mockResolvedValue(false);
		expect((await request()).status).toBe(403);
		expect(mocks.object).not.toHaveBeenCalled();
	});
	it("requires the filename revision to belong to the output", async () => {
		mocks.revision.mockResolvedValue(undefined);
		expect((await request()).status).toBe(404);
		expect(mocks.authorize).not.toHaveBeenCalled();
		expect(mocks.object).not.toHaveBeenCalled();
	});
	it.each([
		{ ENVIRONMENT: "production" },
		{ DESCOPE_PROJECT_ID: "real-project" },
		{ TEDIX_LOCAL_DEMO_ENABLED: "false" },
	])(
		"rejects a demo credential outside the explicit local lane: %j",
		async (overrides) => {
			expect((await request(overrides)).status).toBe(401);
			expect(mocks.object).not.toHaveBeenCalled();
		},
	);
	it("requires a credential", async () => {
		expect((await request({}, {})).status).toBe(401);
	});
	it("does not read an export outside the resolved organization", async () => {
		mocks.output.mockResolvedValue(null);
		expect((await request()).status).toBe(404);
		expect(mocks.object).not.toHaveBeenCalled();
	});
	it("rejects a tenant override without membership", async () => {
		expect(
			(
				await request(
					{},
					{
						Authorization: "Bearer tedix-local-demo",
						"X-Tedix-Tenant-Id": "other-tenant",
					},
				)
			).status,
		).toBe(403);
		expect(mocks.object).not.toHaveBeenCalled();
	});
});
