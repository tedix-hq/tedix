import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { verifyGatewayBrowserToken } from "@tedix/auth/gateway-browser-token";
import type { BaseContext } from "../../orpc";
import { createEmbeddedSessionProcedure } from "./gateway";

const mocks = vi.hoisted(() => ({
	getTedi: vi.fn(),
	getTedis: vi.fn(),
	getOrganization: vi.fn(),
}));
vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTediById: mocks.getTedi,
	getTedisByOrganization: mocks.getTedis,
}));
vi.mock("@tedix/db/queries/organizations", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.getOrganization,
}));
vi.mock("../../../services/model-catalog-projection", () => ({
	buildModelCatalogProjection: async () => ({ models: [] }),
}));

const TEDI = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const ORG = "22222222-2222-4222-8222-222222222222";
const SECRET = "member-session-test-secret";
const tedi = {
	id: TEDI,
	organizationId: ORG,
	slug: "acme",
	name: "Acme",
	status: "active",
	retiredAt: null,
};
const input = {
	tediId: TEDI,
	allowedOrigin: "https://acme.os.tedix.dev",
	conversationId: "11111111-1111-4111-8111-111111111111",
	hostOrganizationId: ORG,
	hostUserId: "member",
	surface: "os" as const,
};
const context = (): BaseContext =>
	({
		authType: "user",
		userRole: "member",
		user: { sub: "member", roles: ["member"], permissions: [] },
		organizationId: ORG,
		headers: new Headers(),
		url: new URL("https://api.example/rpc/tedis/createEmbeddedSession"),
		db: {},
		env: { ENVIRONMENT: "test", SECRETS_MASTER_KEY: SECRET },
	}) as BaseContext;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getTedi.mockResolvedValue(tedi);
	mocks.getTedis.mockResolvedValue([tedi]);
	mocks.getOrganization.mockResolvedValue({
		id: ORG,
		descopeTenantId: "tenant-acme",
		metadata: {
			tediWidget: {
				tediSelection: { defaultTediId: TEDI, allowedTediIds: [TEDI] },
			},
		},
	});
});

describe("member embedded session admission", () => {
	it("mints a conversation token for an allowed tedi without configuration permission", async () => {
		const session = await call(createEmbeddedSessionProcedure, input, {
			context: context(),
		});
		const claims = await verifyGatewayBrowserToken(session.token, {
			expectedTediId: TEDI,
			secret: SECRET,
		});
		expect(claims.tediId).toBe(TEDI);
		expect(session.tediSelection?.tedis).toEqual([{ id: TEDI, name: "Acme" }]);
		expect(mocks.getTedis).toHaveBeenCalledWith(expect.anything(), ORG);
	});

	it("rejects a tedi owned by another organization", async () => {
		mocks.getTedi.mockResolvedValue({ ...tedi, organizationId: "foreign-org" });
		await expect(
			call(createEmbeddedSessionProcedure, input, { context: context() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getOrganization).not.toHaveBeenCalled();
	});

	it("rejects an owned tedi outside the widget allowlist", async () => {
		mocks.getOrganization.mockResolvedValue({
			id: ORG,
			metadata: {
				tediWidget: {
					tediSelection: { defaultTediId: OTHER, allowedTediIds: [OTHER] },
				},
			},
		});
		await expect(
			call(createEmbeddedSessionProcedure, input, { context: context() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getTedis).not.toHaveBeenCalled();
	});

	it.each(["host", undefined] as const)(
		"does not let a member bypass the allowlist using surface %s",
		async (surface) => {
			await expect(
				call(
					createEmbeddedSessionProcedure,
					{ ...input, surface },
					{ context: context() },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.getTedi).not.toHaveBeenCalled();
		},
	);

	it("preserves host session configuration authority and its machine scope", async () => {
		const operator = context();
		operator.userRole = undefined;
		operator.user = {
			sub: "operator",
			roles: [],
			permissions: ["tedis:update"],
		};
		await expect(
			call(
				createEmbeddedSessionProcedure,
				{ ...input, surface: "host" },
				{ context: operator },
			),
		).resolves.toHaveProperty("token");
		const machine = context();
		machine.authType = "apikey";
		machine.user = undefined;
		machine.apiKey = { scopes: ["apps:write"] } as BaseContext["apiKey"];
		await expect(
			call(
				createEmbeddedSessionProcedure,
				{ ...input, surface: "host" },
				{ context: machine },
			),
		).resolves.toHaveProperty("token");
		await expect(
			call(createEmbeddedSessionProcedure, input, { context: machine }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rejects callers without conversation permission", async () => {
		const actor = context();
		actor.userRole = undefined;
		actor.user = { sub: "viewer", roles: [], permissions: ["os:read"] };
		await expect(
			call(createEmbeddedSessionProcedure, input, { context: actor }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getTedi).not.toHaveBeenCalled();
	});
});
