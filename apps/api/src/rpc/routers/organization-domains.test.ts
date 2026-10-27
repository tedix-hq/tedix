import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizations, cmsDomainClaims } from "@tedix/db/schema";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { BaseContext } from "../orpc";
const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	challenge: vi.fn(),
	target: vi.fn(),
	create: vi.fn(),
	find: vi.fn(),
	get: vi.fn(),
	remove: vi.fn(),
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByCanonicalUserId: mocks.member,
	getMemberByUserId: mocks.member,
}));
vi.mock("../../services/cms-custom-hostnames", async (original) => ({
	...(await original<typeof import("../../services/cms-custom-hostnames")>()),
	verifyCmsDnsChallenge: mocks.challenge,
	verifyCmsDnsTarget: mocks.target,
	createCmsCustomHostname: mocks.create,
	findCmsCustomHostname: mocks.find,
	getCmsCustomHostname: mocks.get,
	deleteCmsCustomHostname: mocks.remove,
}));
import {
	getCustomDomain,
	beginCustomDomain,
	verifyCustomDomain,
	removeCustomDomain,
} from "./organization-domains";
import { resolveOrganizationHostname } from "@tedix/db/queries/organization-domains";

let sqlite: DatabaseSync;
function context(
	organizationId = "org-a",
	overrides: Partial<BaseContext> = {},
) {
	return {
		organizationId,
		authType: "user",
		db: createDbClient(createD1Facade(sqlite)),
		env: {
			ENVIRONMENT: "test",
			CF_OS_SAAS_ZONE_ID: "a".repeat(32),
			CF_OS_HOSTNAMES_TOKEN: "test-token",
			CF_OS_SAAS_TARGET_DOMAIN: "os.tedix.dev",
		},
		headers: new Headers(),
		url: new URL("https://api.example/rpc/organizations"),
		userRole: "admin",
		user: {
			sub: "owner",
			dct: organizationId,
			roles: ["admin"],
			permissions: ["settings:manage"],
		},
		...overrides,
	} as BaseContext;
}
function client(ctx = context()) {
	return createRouterClient(
		{
			getCustomDomain,
			beginCustomDomain,
			verifyCustomDomain,
			removeCustomDomain,
		},
		{ context: ctx },
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, cmsDomainClaims));
	sqlite.exec(`CREATE TABLE cms_sites (id TEXT PRIMARY KEY, custom_domain TEXT);
	INSERT INTO organizations (id,name,slug,features) VALUES ('org-a','Alpha','alpha','{"os":true}'),('org-b','Beta','beta','{"os":true}');`);
	mocks.member.mockResolvedValue({ status: "active", role: "owner" });
	mocks.challenge.mockResolvedValue(true);
	mocks.target.mockResolvedValue(true);
	mocks.find.mockResolvedValue(null);
	mocks.create.mockImplementation(async (_env, hostname) => ({
		id: "provider-a",
		hostname,
		status: "active",
		ssl: { status: "active" },
	}));
});
afterEach(() => sqlite.close());

describe("owner organization domains", () => {
	it("requires TXT proof before provider provisioning, and both active hostname and certificate", async () => {
		const api = client();
		const claim = await api.beginCustomDomain({
			hostname: "Share.Example.com.",
		});
		expect(claim).toMatchObject({
			hostname: "share.example.com",
			status: "pending",
			txtName: "_tedix-os.share.example.com",
			cnameTarget: "os.tedix.dev",
		});
		mocks.challenge.mockResolvedValueOnce(false);
		await expect(
			api.verifyCustomDomain({ claimId: claim.claimId }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.create).not.toHaveBeenCalled();
		mocks.create.mockImplementationOnce(async (_env, hostname) => ({
			id: "provider-a",
			hostname,
			status: "active",
			ssl: { status: "pending" },
		}));
		expect(
			await api.verifyCustomDomain({ claimId: claim.claimId }),
		).toMatchObject({ status: "pending" });
		expect(
			await resolveOrganizationHostname(context().db, claim.hostname),
		).toBeNull();
		mocks.get.mockResolvedValue({
			id: "provider-a",
			hostname: claim.hostname,
			status: "active",
			ssl: { status: "active" },
		});
		expect(
			await api.verifyCustomDomain({ claimId: claim.claimId }),
		).toMatchObject({ status: "active" });
		expect(
			await resolveOrganizationHostname(context().db, claim.hostname),
		).toMatchObject({ organizationId: "org-a" });
	});
	it("refuses cross-org verification/removal and releases a removed domain", async () => {
		const api = client();
		const claim = await api.beginCustomDomain({
			hostname: "share.example.com",
		});
		const other = client(context("org-b"));
		await expect(
			other.verifyCustomDomain({ claimId: claim.claimId }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			other.removeCustomDomain({ claimId: claim.claimId }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.create).not.toHaveBeenCalled();
		await api.verifyCustomDomain({ claimId: claim.claimId });
		mocks.get.mockResolvedValue({ id: "provider-a", hostname: claim.hostname });
		await expect(
			api.removeCustomDomain({ claimId: claim.claimId }),
		).resolves.toEqual({ success: true });
		expect(mocks.remove).toHaveBeenCalledWith(
			expect.objectContaining({ CF_CMS_SAAS_ZONE_ID: "a".repeat(32) }),
			"provider-a",
			claim.hostname,
		);
		expect(await api.getCustomDomain({})).toBeNull();
		expect(
			await resolveOrganizationHostname(context().db, claim.hostname),
		).toBeNull();
		expect(
			await other.beginCustomDomain({ hostname: claim.hostname }),
		).toMatchObject({ status: "pending" });
	});
	it("fails closed on provider identity mismatch, cleanup errors and DNS target mismatch", async () => {
		const api = client();
		const claim = await api.beginCustomDomain({
			hostname: "share.example.com",
		});
		mocks.target.mockResolvedValueOnce(false);
		expect(
			await api.verifyCustomDomain({ claimId: claim.claimId }),
		).toMatchObject({ status: "pending" });
		mocks.get.mockResolvedValue({
			id: "other-provider",
			hostname: claim.hostname,
			status: "active",
			ssl: { status: "active" },
		});
		await expect(
			api.verifyCustomDomain({ claimId: claim.claimId }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			api.removeCustomDomain({ claimId: claim.claimId }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.remove).not.toHaveBeenCalled();
		expect(
			await resolveOrganizationHostname(context().db, claim.hostname),
		).toBeNull();
	});
	it.each(["member", "viewer"])(
		"refuses %s despite settings permission",
		async (role) => {
			mocks.member.mockResolvedValue({ status: "active", role });
			await expect(
				client().beginCustomDomain({ hostname: "share.example.com" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);
	it("refuses inactive admins, machine principals, platform hostnames and URLs", async () => {
		mocks.member.mockResolvedValueOnce({ status: "inactive", role: "admin" });
		await expect(client().getCustomDomain({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			client(
				context("org-a", {
					authType: "apikey",
					apiKey: { scopes: ["apps:write"] },
				} as Partial<BaseContext>),
			).beginCustomDomain({ hostname: "share.example.com" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		for (const hostname of [
			"os.tedix.dev",
			"https://share.example.com",
			"*.example.com",
		])
			await expect(
				client().beginCustomDomain({ hostname }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

it("retains a timed-out provider reservation until verified recovery, and retries cleanup safely", async () => {
	const api = client();
	const claim = await api.beginCustomDomain({ hostname: "share.example.com" });
	mocks.create.mockRejectedValueOnce(new Error("provider create timed out"));
	await expect(
		api.verifyCustomDomain({ claimId: claim.claimId }),
	).rejects.toThrow("provider create timed out");
	await expect(
		api.removeCustomDomain({ claimId: claim.claimId }),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(
		await resolveOrganizationHostname(context().db, claim.hostname),
	).toBeNull();
	sqlite
		.prepare("UPDATE cms_domain_claims SET updated_at=? WHERE id=?")
		.run("2000-01-01T00:00:00.000Z", claim.claimId);
	const provider = {
		id: "provider-a",
		hostname: claim.hostname,
		status: "active",
		ssl: { status: "active" },
	};
	mocks.find.mockResolvedValueOnce(provider);
	expect(
		await api.verifyCustomDomain({ claimId: claim.claimId }),
	).toMatchObject({ status: "active" });
	mocks.get.mockResolvedValue(provider);
	mocks.remove.mockRejectedValueOnce(new Error("provider unavailable"));
	await expect(
		api.removeCustomDomain({ claimId: claim.claimId }),
	).rejects.toThrow("provider unavailable");
	expect(
		await resolveOrganizationHostname(context().db, claim.hostname),
	).toBeNull();
	await expect(
		api.removeCustomDomain({ claimId: claim.claimId }),
	).resolves.toEqual({ success: true });
});

it("keeps removal available during provider outages and does not recreate a missing provider ID", async () => {
	const api = client();
	const claim = await api.beginCustomDomain({ hostname: "share.example.com" });
	await api.verifyCustomDomain({ claimId: claim.claimId });
	mocks.get.mockRejectedValueOnce(new Error("provider unavailable"));
	expect(await api.getCustomDomain({})).toMatchObject({
		claimId: claim.claimId,
		status: "active",
	});
	mocks.get.mockResolvedValue(null);
	await expect(
		api.verifyCustomDomain({ claimId: claim.claimId }),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(mocks.create).toHaveBeenCalledTimes(1);
	await expect(
		api.removeCustomDomain({ claimId: claim.claimId }),
	).resolves.toEqual({ success: true });
});
