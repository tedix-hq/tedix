import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import { ensureProviderInstallationGateway } from "./provider-installation-gateway";

const mocks = vi.hoisted(() => ({
	source: vi.fn(),
	tedi: vi.fn(),
	apps: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	tools: vi.fn(),
	acquire: vi.fn(),
	release: vi.fn(),
	servers: vi.fn(),
	register: vi.fn(),
	grant: vi.fn(),
	sync: vi.fn(),
}));
vi.mock("@tedix/db/queries/app-records", () => ({
	getAppByIdForOrganization: mocks.source,
	getAppMetadataJson: (app: { metadata: unknown }) => app.metadata,
	createAppWithId: mocks.create,
	updateAppMetadata: mocks.update,
}));
vi.mock("@tedix/db/queries/apps", () => ({
	getAppsByOrganization: mocks.apps,
}));
vi.mock("@tedix/db/queries/app-gating", () => ({
	getPortableWebMcpToolAdmissions: mocks.tools,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
	tryAcquireTediRuntimeLease: mocks.acquire,
	releaseTediRuntimeLease: mocks.release,
}));
vi.mock("@tedix/auth/aih-client", () => ({
	loadAllDescopeMcpServers: mocks.servers,
	registerDescopeMcpResource: mocks.register,
}));
vi.mock("@tedix/auth/client", () => ({ getManagementClient: () => ({}) }));
vi.mock("@tedix/auth/fga", () => ({ grantAppOperator: mocks.grant }));
vi.mock("../lib/tedi-aih-client-sync", () => ({
	ensureTediAihClientForApp: mocks.sync,
}));
const installation = {
	id: "11111111-1111-4111-8111-111111111111",
	status: "active",
	providerOrganizationId: "provider",
	providerAppId: "source",
	customerOrganizationId: "customer",
	primaryTediId: "worker",
	hostTenantNamespace: "vendor",
} as Parameters<typeof ensureProviderInstallationGateway>[1];
const context = {
	db: {},
	env: {
		DESCOPE_PROJECT_ID: "project",
		DESCOPE_MANAGEMENT_KEY: "key",
		SECRETS_MASTER_KEY: "secret",
	},
} as BaseContext;
let rows: Array<any>;
beforeEach(() => {
	vi.resetAllMocks();
	rows = [];
	mocks.source.mockResolvedValue({
		id: "source",
		slug: "provider-source",
		organizationId: "provider",
		visibility: "private",
	});
	mocks.tedi.mockResolvedValue({
		id: "worker",
		name: "Worker",
		slug: "worker",
		organizationId: "customer",
		descopeUserId: "identity",
		status: "active",
	});
	mocks.apps.mockImplementation(async () => rows);
	mocks.create.mockImplementation(async (_db, row) => {
		rows.push(row);
		return row;
	});
	mocks.update.mockImplementation(async (_db, id, metadata) => {
		const row = rows.find((x) => x.id === id);
		row.metadata = { ...row.metadata, ...metadata };
		return row;
	});
	mocks.tools.mockResolvedValue([
		{ toolId: "read_record", writeCapability: "read" },
		{ toolId: "delete_record", writeCapability: "destructive" },
		{ toolId: "edit_record", writeCapability: "write" },
	]);
	mocks.acquire.mockResolvedValue(true);
	mocks.servers.mockResolvedValue([]);
	mocks.register.mockResolvedValue({ id: "resource" });
	mocks.sync.mockResolvedValue({ status: "created" });
});
describe("installation gateway provisioning", () => {
	it("creates a single read-only source gateway and exact worker assignment, converging on retry", async () => {
		await ensureProviderInstallationGateway(context, installation);
		await ensureProviderInstallationGateway(context, installation);
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.register).toHaveBeenCalledTimes(1);
		expect(rows[0].metadata.mcpConfig.aggregateApps).toEqual([
			{ slug: "provider-source", prefix: "vendor", readOnly: true },
		]);
		expect(rows[0].metadata.mcpConfig.assignmentConfig.mode).toBe("manual");
		expect(mocks.grant).toHaveBeenLastCalledWith(
			{},
			"identity",
			installation.id,
		);
		expect(mocks.sync).toHaveBeenCalledTimes(2);
		expect(mocks.source).toHaveBeenCalledWith(context.db, "source", "provider");
		expect(mocks.tedi).toHaveBeenCalledWith(context.db, "worker", "customer");
	});
	it("reuses a customized existing single-source gateway, keeping its branding", async () => {
		rows = [
			{
				id: "custom",
				slug: "custom",
				name: "Custom",
				organizationId: "customer",
				visibility: "private",
				metadata: {
					branding: { color: "blue" },
					mcpConfig: {
						descopeResourceId: "existing",
						aggregateApps: [
							{
								slug: "provider-source",
								prefix: "vendor",
								toolIds: ["read_record"],
							},
						],
					},
				},
			},
		];
		await ensureProviderInstallationGateway(context, installation);
		// Adoption keeps everything the operator customized; only the mount rule
		// is normalized off the stale enumerated snapshot.
		expect(rows[0].metadata.branding).toEqual({ color: "blue" });
		expect(rows[0].metadata.mcpConfig.descopeResourceId).toBe("existing");
		expect(rows[0].metadata.mcpConfig.aggregateApps).toEqual([
			{ slug: "provider-source", prefix: "vendor", readOnly: true },
		]);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.grant).toHaveBeenCalledWith({}, "identity", "custom");
	});
	it("migrates an enumerated allowlist to the read rule", async () => {
		rows = [
			{
				id: "legacy",
				slug: `embedded-gateway-${installation.id}`,
				name: "Legacy",
				organizationId: "customer",
				visibility: "private",
				metadata: {
					mcpConfig: {
						descopeResourceId: "existing",
						aggregateApps: [
							{
								slug: "provider-source",
								prefix: "vendor",
								toolIds: ["read_record"],
							},
						],
					},
				},
			},
		];
		await ensureProviderInstallationGateway(context, installation);
		// The snapshot is what went stale, so it is removed rather than refreshed.
		expect(rows[0].metadata.mcpConfig.aggregateApps).toEqual([
			{ slug: "provider-source", prefix: "vendor", readOnly: true },
		]);
		expect(mocks.create).not.toHaveBeenCalled();

		// A source that gains a read tool now needs no gateway rewrite at all.
		const updatesAfterMigration = mocks.update.mock.calls.length;
		mocks.tools.mockResolvedValue([
			{ toolId: "read_record", writeCapability: "read" },
			{ toolId: "search_records", writeCapability: "read" },
		]);
		await ensureProviderInstallationGateway(context, installation);
		expect(mocks.update.mock.calls.length).toBe(updatesAfterMigration);
	});

	it("ignores malformed unrelated app configuration", async () => {
		rows = [
			{
				id: "unrelated",
				slug: "unrelated",
				organizationId: "customer",
				metadata: { mcpConfig: { aggregateApps: "invalid" } },
			},
		];
		await ensureProviderInstallationGateway(context, installation);
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(rows[1].metadata.mcpConfig.aggregateApps[0].readOnly).toBe(true);
	});
	it("recovers external registration after interrupted metadata persistence", async () => {
		mocks.update.mockRejectedValueOnce(new Error("D1 unavailable"));
		await expect(
			ensureProviderInstallationGateway(context, installation),
		).rejects.toThrow("D1 unavailable");
		mocks.servers.mockResolvedValue([
			{
				id: "resource",
				tags: [`app:embedded-gateway-${installation.id}`],
				audienceWhitelist: [
					`https://embedded-gateway-${installation.id}.mcp.tedix.dev/mcp`,
				],
			},
		]);
		await ensureProviderInstallationGateway(context, installation);
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.register).toHaveBeenCalledTimes(1);
	});
	it("does not report success after client provisioning failure; retries the same gateway", async () => {
		mocks.sync.mockRejectedValueOnce(new Error("client failed"));
		await expect(
			ensureProviderInstallationGateway(context, installation),
		).rejects.toThrow("client failed");
		await ensureProviderInstallationGateway(context, installation);
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.register).toHaveBeenCalledTimes(1);
		expect(mocks.release).toHaveBeenCalledTimes(2);
	});
	it("rejects overlapping provisioning before external writes", async () => {
		mocks.acquire.mockResolvedValue(false);
		await expect(
			ensureProviderInstallationGateway(context, installation),
		).rejects.toThrow("in progress");
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.register).not.toHaveBeenCalled();
		expect(mocks.grant).not.toHaveBeenCalled();
	});
	it("preserves paused installation and rejects unavailable/foreign source before writes", async () => {
		await ensureProviderInstallationGateway(context, {
			...installation,
			status: "paused",
		});
		expect(mocks.source).not.toHaveBeenCalled();
		mocks.source.mockResolvedValue(undefined);
		await expect(
			ensureProviderInstallationGateway(context, installation),
		).rejects.toThrow("unavailable");
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("refuses a deterministic gateway whose source was changed", async () => {
		rows = [
			{
				id: installation.id,
				slug: `embedded-gateway-${installation.id}`,
				organizationId: "customer",
				metadata: {
					mcpConfig: { aggregateApps: [{ slug: "foreign", prefix: "vendor" }] },
				},
			},
		];
		await expect(
			ensureProviderInstallationGateway(context, installation),
		).rejects.toThrow("source identity changed");
		expect(mocks.grant).not.toHaveBeenCalled();
	});
});
