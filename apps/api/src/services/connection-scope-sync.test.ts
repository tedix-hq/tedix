import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as aih from "@tedix/auth/aih-client";
import * as connections from "@tedix/auth/connection-providers";
import * as providers from "@tedix/db/queries/connection-providers";
import type { DbClient } from "@tedix/db/client";
import { syncDeclaredConnectionScopes } from "./connection-scope-sync";

const env = {
	DESCOPE_PROJECT_ID: "project",
	DESCOPE_MANAGEMENT_KEY: "test-key",
};
afterEach(() => vi.restoreAllMocks());

describe("connection scope sync", () => {
	it("refuses a tenant update to another app's server", async () => {
		vi.spyOn(aih, "loadDescopeMcpServer").mockResolvedValue({
			id: "server",
			name: "Other",
			tags: ["app:other"],
		});
		const update = vi.spyOn(aih, "updateDescopeMcpServer");
		await expect(
			syncDeclaredConnectionScopes({
				db: {} as DbClient,
				env,
				appSlug: "mail-app",
				config: {
					descopeResourceId: "server",
					connectionProviderId: "mail",
					connectionScopes: ["Mail.Read"],
					toolScopes: { mail: ["mail.read"] },
				},
				syncProviderDefaults: false,
				dryRun: false,
			}),
		).rejects.toThrow("not owned by app");
		expect(update).not.toHaveBeenCalled();
	});

	it("uses D1 registry defaults rather than tenant overrides, and preserves server fields", async () => {
		vi.spyOn(providers, "listConnectionProviders").mockResolvedValue([
			{
				id: "mail",
				name: "Mail",
				description: "Mail",
				icon: "",
				category: "productivity",
				type: "oauth",
				requiredScopes: ["required"],
				supportedScopes: ["user"],
				recommendedScope: "user",
				descopeAppId: "mail",
				credentialProfile: { defaultScopes: ["canonical"] },
			},
		]);
		const defaults = vi
			.spyOn(connections, "syncConnectionProviderScopes")
			.mockResolvedValue({
				before: ["old"],
				after: ["canonical"],
				changed: true,
			});
		const server = {
			id: "server",
			name: "Mail",
			tags: ["app:mail-app"],
			sessionSettings: { sessionTokenExpiration: 3600 },
			approvedScopes: {
				connectionsScopes: [{ name: "mail.read", values: ["old"] }],
			},
		};
		vi.spyOn(aih, "loadDescopeMcpServer").mockResolvedValue(server);
		const update = vi
			.spyOn(aih, "updateDescopeMcpServer")
			.mockImplementation(async (_env, value) => value);
		const result = await syncDeclaredConnectionScopes({
			db: {} as DbClient,
			env,
			appSlug: "mail-app",
			config: {
				descopeResourceId: "server",
				connectionProviderId: "mail",
				connectionScopes: ["tenant-specific"],
				toolScopes: { mail: ["mail.read"] },
			},
			syncProviderDefaults: true,
			dryRun: false,
		});
		expect(defaults).toHaveBeenCalledWith("mail", ["canonical"], env, false);
		expect(update).toHaveBeenCalledWith(env, {
			...server,
			approvedScopes: {
				connectionsScopes: [
					{ name: "mail.read", optional: true, values: ["tenant-specific"] },
				],
			},
		});
		expect(result.mappingChanged).toBe(true);
	});

	it("does not mutate Descope or shared defaults in a tenant dry-run", async () => {
		const list = vi.spyOn(providers, "listConnectionProviders");
		vi.spyOn(aih, "loadDescopeMcpServer").mockResolvedValue({
			id: "server",
			name: "Mail",
			tags: ["app:mail-app"],
		});
		const update = vi.spyOn(aih, "updateDescopeMcpServer");
		await syncDeclaredConnectionScopes({
			db: {} as DbClient,
			env,
			appSlug: "mail-app",
			config: {
				descopeResourceId: "server",
				connectionProviderId: "mail",
				connectionScopes: ["Mail.Read"],
				toolScopes: { mail: ["mail.read"] },
			},
			syncProviderDefaults: false,
		});
		expect(list).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});
});

it("synchronizes optional-only drift and rejects a required readback", async () => {
	vi.spyOn(aih, "loadDescopeMcpServer").mockResolvedValue({
		id: "server",
		name: "Fictional mail",
		tags: ["app:mail-app"],
		approvedScopes: {
			connectionsScopes: [
				{ name: "mail.read", values: ["Mail.Read"], optional: false },
			],
		},
	});
	const update = vi
		.spyOn(aih, "updateDescopeMcpServer")
		.mockImplementation(async (_env, value) => value);
	const params = {
		db: {} as DbClient,
		env,
		appSlug: "mail-app",
		config: {
			descopeResourceId: "server",
			connectionProviderId: "mail",
			connectionScopes: ["Mail.Read"],
			toolScopes: { mail: ["mail.read"] },
		},
		syncProviderDefaults: false,
		dryRun: false,
	};
	expect((await syncDeclaredConnectionScopes(params)).mappingChanged).toBe(
		true,
	);
	expect(update).toHaveBeenCalledTimes(1);
	update.mockImplementation(async (_env, value) => ({
		...value,
		approvedScopes: {
			connectionsScopes: [
				{ name: "mail.read", values: ["Mail.Read"], optional: false },
			],
		},
	}));
	await expect(syncDeclaredConnectionScopes(params)).rejects.toThrow(
		"connection scope readback failed",
	);
});
