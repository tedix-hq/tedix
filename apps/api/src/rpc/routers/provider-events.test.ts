import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, it, expect, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	load: vi.fn(),
	register: vi.fn(),
	tedi: vi.fn(),
	skill: vi.fn(),
	tenant: vi.fn(),
	instance: vi.fn(),
	namedToken: vi.fn(),
	defaultToken: vi.fn(),
}));
vi.mock("@tedix/db/queries/provider-events", () => ({
	listProviderEventSubscriptions: mocks.list,
}));
vi.mock("../../services/provider-events/subscriptions", () => ({
	registerSubscription: mocks.register,
	disableSubscription: vi.fn(),
	loadSubscription: mocks.load,
	statusProjection: (x: unknown) => x,
	queueReconciliation: vi.fn(),
}));
vi.mock("@tedix/auth/client", () => ({ getManagementClient: () => ({}) }));
vi.mock("@tedix/auth/connections", () => ({
	fetchNamedTenantConnectionToken: mocks.namedToken,
	fetchTenantConnectionTokenByScopes: mocks.defaultToken,
}));
vi.mock("@tedix/db/queries/connection-instances", () => ({
	getConnectionInstance: mocks.instance,
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationDescopeTenantId: mocks.tenant,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
}));
vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	getSkillEntry: mocks.skill,
}));
import { providerEventsContractRouter } from "./provider-events";
import { resolveProviderEventCredential } from "../../services/provider-events/credentials";
const id = "747fa260-ef68-4156-a8b0-f70375997f9a";
function context(scopes = ["integrations:manage"]): BaseContext {
	return {
		authType: "apikey",
		apiKey: { id: "key", name: "test", organizationId: "org-a", scopes },
		organizationId: "org-a",
		db: {},
		env: { ENVIRONMENT: "test" },
		headers: new Headers(),
		url: new URL("https://api.test/rpc/providerEvents"),
	} as BaseContext;
}
const subscription = {
	organizationId: "org-a",
	providerId: "google",
	connectionInstanceId: id,
	adapter: "google_calendar" as const,
	tediId: id,
	skillId: id,
	skillRevision: 3,
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.list.mockResolvedValue([]);
	mocks.tedi.mockResolvedValue({
		id,
		status: "active",
		runtimeState: "standby",
	});
	mocks.skill.mockResolvedValue({
		id,
		tediId: id,
		revision: 3,
		lifecycleState: "proven",
		files: { "scripts/workflow.ts": "export default {}" },
	});
	mocks.tenant.mockResolvedValue("tenant-a");
	mocks.instance.mockResolvedValue({
		id,
		organizationId: "org-a",
		tokenIds: ["vault-record"],
	});
	mocks.namedToken.mockResolvedValue({
		accessToken: "private-access",
		expiresAt: Date.now() / 1000 + 60,
	});
});
describe("provider event management auth planes", () => {
	it("rejects API keys with read-only scopes before inventory access", async () => {
		const client = createRouterClient(providerEventsContractRouter, {
			context: context(["apps:read"]),
		});
		await expect(client.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.list).not.toHaveBeenCalled();
	});
	it("does not accept caller-supplied organization scope", async () => {
		const client = createRouterClient(providerEventsContractRouter, {
			context: context(),
		});
		await expect(
			client.list({ organizationId: "org-b" } as never),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.list).not.toHaveBeenCalled();
	});
	it("reads only authenticated organization inventory", async () => {
		const client = createRouterClient(providerEventsContractRouter, {
			context: context(),
		});
		expect(await client.list({})).toEqual([]);
		expect(mocks.list).toHaveBeenCalledWith({}, "org-a");
	});
});
describe("standing provider credential authority", () => {
	it("derives named vault selector from organization-owned record and never tries personal fallback", async () => {
		expect(await resolveProviderEventCredential(context(), subscription)).toBe(
			"private-access",
		);
		expect(mocks.instance).toHaveBeenCalledWith(
			{},
			{ organizationId: "org-a" },
			id,
			"google",
		);
		expect(mocks.namedToken).toHaveBeenCalledWith(expect.anything(), {
			appId: "google",
			tenantId: "tenant-a",
			externalIdentifier: `tedix_${id}`,
			scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
		});
		expect(mocks.defaultToken).not.toHaveBeenCalled();
	});
	it("rejects missing or another owner's named account without fetching a token", async () => {
		mocks.instance.mockResolvedValue(undefined);
		await expect(
			resolveProviderEventCredential(context(), subscription),
		).rejects.toThrow("organization-owned");
		expect(mocks.namedToken).not.toHaveBeenCalled();
		expect(mocks.defaultToken).not.toHaveBeenCalled();
	});
	it("rejects different tedi, changed revision and non-executable or inactive workflow", async () => {
		for (const patch of [
			{ tediId: "other" },
			{ revision: 4 },
			{ files: {} },
			{ lifecycleState: "draft" },
		]) {
			mocks.skill.mockResolvedValue({
				id,
				tediId: id,
				revision: 3,
				lifecycleState: "active",
				files: { "scripts/workflow.ts": "source" },
				...patch,
			});
			await expect(
				resolveProviderEventCredential(context(), subscription),
			).rejects.toThrow("Active organization-owned");
		}
		expect(mocks.namedToken).not.toHaveBeenCalled();
	});
	it("rechecks revoked/expired credentials without retaining prior token", async () => {
		mocks.namedToken.mockResolvedValue({ accessToken: "old", expiresAt: 1 });
		await expect(
			resolveProviderEventCredential(context(), subscription),
		).rejects.toThrow("expired");
		mocks.namedToken.mockResolvedValue(null);
		await expect(
			resolveProviderEventCredential(context(), subscription),
		).rejects.toThrow("missing");
	});
});

it("rejects an unpinned legacy/default account without reading any default credential", async () => {
	await expect(
		resolveProviderEventCredential(context(), {
			...subscription,
			connectionInstanceId: null,
		}),
	).rejects.toThrow("default account fallback is disabled");
	expect(mocks.namedToken).not.toHaveBeenCalled();
	expect(mocks.defaultToken).not.toHaveBeenCalled();
});
it.each(["paused", "error", "provisioning", null])(
	"denies non-active tedi status %s",
	async (status) => {
		mocks.tedi.mockResolvedValue({ id, status, runtimeState: "active" });
		await expect(
			resolveProviderEventCredential(context(), subscription),
		).rejects.toThrow("Active organization-owned");
		expect(mocks.namedToken).not.toHaveBeenCalled();
	},
);
it("denies archived runtime regardless of active deployment status", async () => {
	mocks.tedi.mockResolvedValue({
		id,
		status: "active",
		runtimeState: "archived",
	});
	await expect(
		resolveProviderEventCredential(context(), subscription),
	).rejects.toThrow("Active organization-owned");
	expect(mocks.namedToken).not.toHaveBeenCalled();
});
