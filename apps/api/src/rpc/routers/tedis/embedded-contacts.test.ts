import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
const mocks = vi.hoisted(() => ({
	resolve: vi.fn(),
	identify: vi.fn(),
	list: vi.fn(),
	company: vi.fn(),
	user: vi.fn(),
}));
vi.mock("@tedix/db/queries/embedded-contacts", () => ({
	resolveProviderContactInstallation: mocks.resolve,
	identifyEmbeddedContact: mocks.identify,
	listEmbeddedContacts: mocks.list,
	getEmbeddedContactCompany: mocks.company,
	getEmbeddedContactUser: mocks.user,
}));
import {
	identifyEmbeddedProviderContact,
	listWidgetContacts,
	getWidgetContact,
} from "./embedded-contacts";
import { tedisOs } from "./helpers";
const ORG = "11111111-1111-4111-8111-111111111111",
	INSTALLATION = "22222222-2222-4222-8222-222222222222",
	KEY = "33333333-3333-4333-8333-333333333333";
const company = {
	installationId: INSTALLATION,
	externalTenantId: "367",
	companyProfile: null,
	fallbackName: "Acme",
};
const user = {
	installationId: INSTALLATION,
	externalTenantId: "367",
	hostUserId: "1743",
	name: "Daniel",
	email: "demo@acme.example",
	role: null,
	customAttributes: {},
	firstSeenAt: "2026-09-12T00:00:00Z",
	lastSeenAt: "2026-09-12T00:00:00Z",
};
const input = {
	externalTenantId: "367",
	hostUserId: "1743",
	profile: { user: { name: "Daniel", email: "demo@acme.example" } },
};
function context(scopes = ["embedded:session"]): BaseContext {
	return {
		authType: "apikey",
		organizationId: ORG,
		apiKey: { id: KEY, name: "host", organizationId: ORG, scopes },
		db: {},
		env: { ENVIRONMENT: "test" },
		headers: new Headers(),
		url: new URL("https://api.example/rpc"),
	} as BaseContext;
}
const router = tedisOs.router({
	identifyEmbeddedProviderContact,
	listWidgetContacts,
	getWidgetContact,
});
const client = (ctx = context()) =>
	createRouterClient(router, { context: ctx });
beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolve.mockResolvedValue({ id: INSTALLATION, status: "paused" });
	mocks.identify.mockResolvedValue({ user, company });
	mocks.company.mockResolvedValue(company);
	mocks.user.mockResolvedValue(user);
	mocks.list.mockResolvedValue({
		people: [user],
		companies: [company],
		total: 2,
	});
});
describe("embedded durable contact API", () => {
	it("allows free paused-business identification only through the scoped host key", async () => {
		await expect(
			client().identifyEmbeddedProviderContact(input),
		).resolves.toMatchObject({
			installationId: INSTALLATION,
			user: { name: "Daniel", email: "demo@acme.example" },
			company: { name: "Acme" },
		});
		expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), {
			providerOrganizationId: ORG,
			providerApiKeyId: KEY,
			externalTenantId: "367",
		});
		expect(mocks.identify).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				providerOrganizationId: ORG,
				installationId: INSTALLATION,
				hostUserId: "1743",
			}),
		);
	});
	it.each(
		[["apps:write"], ["*"], ["platform:admin"], ["embedded:session", "*"]].map(
			(scopes) => ({ scopes }),
		),
	)("rejects broader or unrelated credentials $scopes", async ({ scopes }) => {
		await expect(
			client(context(scopes)).identifyEmbeddedProviderContact(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.identify).not.toHaveBeenCalled();
	});
	it("rejects human callers and foreign/missing installations", async () => {
		await expect(
			client({
				...context(),
				authType: "user",
				apiKey: undefined,
				user: { sub: "human", permissions: ["settings:manage"], roles: [] },
			} as BaseContext).identifyEmbeddedProviderContact(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		mocks.resolve.mockResolvedValue(undefined);
		await expect(
			client().identifyEmbeddedProviderContact(input),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.identify).not.toHaveBeenCalled();
	});
	it("rejects attempted authority fields in profile or caller-selected installation", async () => {
		for (const forged of [
			{ ...input, installationId: INSTALLATION },
			{
				...input,
				profile: { user: { name: "Other", permissions: ["admin"] } },
			},
		])
			await expect(
				client().identifyEmbeddedProviderContact(forged as typeof input),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.identify).not.toHaveBeenCalled();
	});
	it("keeps the host key out of the provider directory", async () => {
		await expect(
			client().listWidgetContacts({ kind: "people" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("scopes paginated search to the caller and returns associated companies", async () => {
		const result = await client(context(["apps:read"])).listWidgetContacts({
			kind: "people",
			search: "demo@",
			limit: 1,
		});
		expect(result).toMatchObject({
			people: [user],
			companies: [{ name: "Acme" }],
			total: 2,
			nextOffset: 1,
		});
		expect(mocks.list).toHaveBeenCalledWith(expect.anything(), {
			providerOrganizationId: ORG,
			kind: "people",
			search: "demo@",
			offset: 0,
			limit: 1,
		});
	});
	it("does not reveal a person when the company is outside the provider", async () => {
		mocks.company.mockResolvedValue(undefined);
		await expect(
			client(context(["apps:read"])).getWidgetContact({
				installationId: INSTALLATION,
				hostUserId: "1743",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.user).not.toHaveBeenCalled();
	});
	it("requires a business for bulk selected user IDs", async () => {
		await expect(
			client(context(["apps:read"])).listWidgetContacts({
				kind: "people",
				hostUserIds: ["1743"],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
