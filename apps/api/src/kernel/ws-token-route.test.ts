import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handleKernelWsToken } from "./ws-token-route";
import { mintKernelWsToken, verifyKernelWsToken } from "./ws-token";
const mocks = vi.hoisted(() => ({
	validate: vi.fn(),
	org: vi.fn(),
	member: vi.fn(),
}));
vi.mock("@tedix/auth/jwt", () => ({
	validateToken: mocks.validate,
	isUserToken: (p: { sub?: string; type?: string }) => p.type === "user",
}));
vi.mock("@tedix/auth/types", () => ({ getTenantId: () => "org_tedix" }));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationByDescopeId: mocks.org,
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
}));
const ORG = "11111111-2222-3333-4444-555555555555",
	KEY = "test-key";
const env = { DB: {}, PLATFORM_SERVICE_TOKEN: KEY } as unknown as CloudflareEnv;
const req = (token?: string, suffix = "") =>
	new Request(`https://api.tedix.dev/kernel/ws-token${suffix}`, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
beforeEach(() => {
	vi.resetAllMocks();
	mocks.validate.mockResolvedValue({ sub: "user", type: "user" });
	mocks.org.mockResolvedValue({ id: ORG });
	mocks.member.mockResolvedValue(null);
	mocks.member.mockResolvedValue(null);
});
describe("handleKernelWsToken", () => {
	it("rejects absent and URL-only credentials", async () => {
		expect((await handleKernelWsToken(req(), env)).status).toBe(401);
		expect(
			(
				await handleKernelWsToken(
					req(undefined, "?jwt=secret&token=secret"),
					env,
				)
			).status,
		).toBe(401);
		expect(mocks.validate).not.toHaveBeenCalled();
	});
	it.each(["", `?organization=${ORG}`, "?organization=org_tedix"])(
		"mints the same canonical scope for %s",
		async (suffix) => {
			const before = Date.now();
			const response = await handleKernelWsToken(req("session", suffix), env);
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			const result = (await response.json()) as {
				token: string;
				expiresAt: number;
				organizationId: string;
			};
			expect(result.organizationId).toBe(ORG);
			expect(result.expiresAt).toBeGreaterThan(before + 590000);
			expect(await verifyKernelWsToken(result.token, KEY)).toMatchObject({
				scope: "kernel:ws",
				organizationId: ORG,
				descopeUserId: "user",
			});
			expect(mocks.member).not.toHaveBeenCalled();
		},
	);
	it("requires a user JWT rather than accepting a locally valid scoped token", async () => {
		const { token } = await mintKernelWsToken({
			organizationId: ORG,
			descopeUserId: "user",
			platformServiceToken: KEY,
		});
		mocks.validate.mockRejectedValueOnce(new Error("Not a Descope JWT"));
		expect((await handleKernelWsToken(req(token), env)).status).toBe(401);
		expect(mocks.validate).toHaveBeenCalledWith(token, expect.anything());
	});
	it("rejects machine or subjectless credentials", async () => {
		mocks.validate.mockResolvedValueOnce({ sub: "machine", type: "m2m" });
		expect((await handleKernelWsToken(req("machine"), env)).status).toBe(401);
		mocks.validate.mockResolvedValueOnce({ type: "user" });
		expect((await handleKernelWsToken(req("subjectless"), env)).status).toBe(
			401,
		);
	});
	it("returns 503 when signing is unavailable", async () => {
		expect(
			(await handleKernelWsToken(req("session"), { DB: {} } as CloudflareEnv))
				.status,
		).toBe(503);
	});
	it("denies unauthorized organizations", async () => {
		expect(
			(await handleKernelWsToken(req("session", "?organization=other"), env))
				.status,
		).toBe(403);
	});
});
