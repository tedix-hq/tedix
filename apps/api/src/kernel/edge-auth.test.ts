import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	authenticateKernelEdge,
	authenticateKernelSessionJwt,
	extractKernelEdgeToken,
} from "./edge-auth";
import { mintKernelWsToken, signKernelWsTokenPayload } from "./ws-token";
const mocks = vi.hoisted(() => ({
	validate: vi.fn(),
	user: vi.fn(),
	tenant: vi.fn(),
	org: vi.fn(),
	member: vi.fn(),
}));
vi.mock("@tedix/auth/jwt", () => ({
	validateToken: mocks.validate,
	isUserToken: mocks.user,
}));
vi.mock("@tedix/auth/types", () => ({ getTenantId: mocks.tenant }));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationByDescopeId: mocks.org,
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
}));
const ORG = "11111111-2222-3333-4444-555555555555";
const KEY = "test-platform-key";
const env = {
	DB: {},
	PLATFORM_SERVICE_TOKEN: KEY,
	DESCOPE_PROJECT_ID: "project",
} as unknown as CloudflareEnv;
const request = (token?: string, organization?: string) =>
	new Request(
		`https://api.tedix.dev/kernel/voice/input${organization ? `?organization=${organization}` : ""}`,
		{ headers: token ? { Authorization: `Bearer ${token}` } : {} },
	);
beforeEach(() => {
	vi.resetAllMocks();
	mocks.validate.mockResolvedValue({ sub: "user" });
	mocks.user.mockReturnValue(true);
	mocks.tenant.mockReturnValue("org_tedix");
	mocks.org.mockResolvedValue({ id: ORG });
	mocks.member.mockResolvedValue(null);
});
async function status(
	result: Awaited<ReturnType<typeof authenticateKernelEdge>>,
) {
	return result.ok ? 200 : result.response.status;
}
describe("kernel token extraction", () => {
	it.each([
		[
			{
				Authorization: "Bearer header",
				"Sec-WebSocket-Protocol": "bearer-protocol",
			},
			"header",
		],
		[{ "Sec-WebSocket-Protocol": "bearer, pair, bearer-prefixed" }, "prefixed"],
		[{ "Sec-WebSocket-Protocol": "bearer, pair" }, "pair"],
		[{ Cookie: "jwt=cookie" }, null],
	])(
		"uses header and protocol precedence without cookie fallback",
		(headers, expected) => {
			expect(
				extractKernelEdgeToken(
					new Request(
						"https://api.tedix.dev/kernel/voice/input?jwt=query&token=query",
						{ headers: headers as Record<string, string> },
					),
				),
			).toBe(expected);
		},
	);
});
describe("session organization authorization", () => {
	it.each([null, "org_tedix", ORG])(
		"normalizes the user's own organization %s",
		async (organization) => {
			expect(
				await authenticateKernelSessionJwt("session", organization, env),
			).toEqual({
				ok: true,
				identity: { descopeUserId: "user", organizationId: ORG },
			});
			expect(mocks.member).not.toHaveBeenCalled();
		},
	);
	it("requires membership for another canonical organization", async () => {
		expect(
			await status(
				await authenticateKernelSessionJwt("session", "other-org", env),
			),
		).toBe(403);
		mocks.member.mockResolvedValue({ id: "membership" });
		expect(
			await authenticateKernelSessionJwt("session", "other-org", env),
		).toMatchObject({ ok: true, identity: { organizationId: "other-org" } });
		expect(mocks.member).toHaveBeenLastCalledWith({}, "other-org", "user");
	});
	it("denies membership lookup failure", async () => {
		mocks.member.mockRejectedValue(new Error("unavailable"));
		expect(
			await status(
				await authenticateKernelSessionJwt("session", "other-org", env),
			),
		).toBe(403);
	});
	it.each([null, undefined])("denies absent claim tenant", async (tenant) => {
		mocks.tenant.mockReturnValue(tenant);
		expect(
			await status(await authenticateKernelSessionJwt("session", null, env)),
		).toBe(403);
	});
	it("denies unresolved own tenant alias", async () => {
		mocks.org.mockResolvedValue(null);
		expect(
			await status(
				await authenticateKernelSessionJwt("session", "org_tedix", env),
			),
		).toBe(403);
	});
	it("denies claim lookup failure", async () => {
		mocks.org.mockRejectedValue(new Error("unavailable"));
		expect(
			await status(await authenticateKernelSessionJwt("session", null, env)),
		).toBe(403);
	});
	it("rejects invalid, non-user and subjectless JWTs", async () => {
		mocks.validate.mockRejectedValueOnce(new Error("invalid"));
		expect(
			await status(await authenticateKernelSessionJwt("bad", null, env)),
		).toBe(401);
		mocks.user.mockReturnValueOnce(false);
		expect(
			await status(await authenticateKernelSessionJwt("machine", null, env)),
		).toBe(401);
		mocks.validate.mockResolvedValueOnce({ sub: "" });
		expect(
			await status(await authenticateKernelSessionJwt("empty", null, env)),
		).toBe(401);
	});
	it("does not change organization selection from host headers", async () => {
		const req = request("session");
		req.headers.set("X-Tedix-Tenant-Id", "other-org");
		expect(await authenticateKernelEdge(req, env)).toMatchObject({
			ok: true,
			identity: { organizationId: ORG },
		});
	});
});
describe("scoped voice tokens", () => {
	it("rejects absent credentials", async () => {
		expect(await status(await authenticateKernelEdge(request(), env))).toBe(
			401,
		);
		expect(mocks.validate).not.toHaveBeenCalled();
	});
	it.each([undefined, ORG, "org_tedix"])(
		"accepts exact scope or an alias resolving to the same org: %s",
		async (organization) => {
			const { token } = await mintKernelWsToken({
				organizationId: ORG,
				descopeUserId: "scoped-user",
				platformServiceToken: KEY,
			});
			expect(
				await authenticateKernelEdge(request(token, organization), env),
			).toMatchObject({
				ok: true,
				identity: { organizationId: ORG, descopeUserId: "scoped-user" },
			});
			expect(mocks.validate).not.toHaveBeenCalled();
		},
	);
	it("rejects a different org and failed alias lookup without JWT fallback", async () => {
		const { token } = await mintKernelWsToken({
			organizationId: ORG,
			descopeUserId: "user",
			platformServiceToken: KEY,
		});
		mocks.org.mockResolvedValueOnce({ id: "other" });
		expect(
			await status(await authenticateKernelEdge(request(token, "other"), env)),
		).toBe(403);
		mocks.org.mockRejectedValueOnce(new Error("unavailable"));
		expect(
			await status(await authenticateKernelEdge(request(token, "other"), env)),
		).toBe(403);
		expect(mocks.validate).not.toHaveBeenCalled();
	});
	it.each(["expired", "signature", "scope"])(
		"rejects %s tokens when user JWT validation also fails",
		async (kind) => {
			const now = Date.now();
			const token = await signKernelWsTokenPayload(
				{
					scope: kind === "scope" ? "wrong" : "kernel:ws",
					organizationId: ORG,
					descopeUserId: "user",
					v: 1,
					exp: Math.floor(now / 1000) + (kind === "expired" ? -1 : 60),
				},
				kind === "signature" ? "other-key" : KEY,
			);
			mocks.validate.mockRejectedValueOnce(new Error("invalid session"));
			expect(
				await status(await authenticateKernelEdge(request(token), env)),
			).toBe(401);
			expect(mocks.validate).toHaveBeenCalledWith(token, expect.anything());
		},
	);
});
