import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	getEnabledAdapters: vi.fn(),
	getBindingsBatch: vi.fn(),
	getUniqueSecretIds: vi.fn(),
	fetchAppSecretsForHydration: vi.fn(),
	fetchOrgSecretsForHydration: vi.fn(),
	decryptAppSecret: vi.fn(),
	decryptSecret: vi.fn(),
}));

vi.mock("@tedix/db/queries/adapters", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getEnabledAdapters: mocks.getEnabledAdapters,
}));
vi.mock(
	"@tedix/db/queries/app-adapter-secret-bindings",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		getBindingsBatch: mocks.getBindingsBatch,
		getUniqueSecretIds: mocks.getUniqueSecretIds,
		fetchAppSecretsForHydration: mocks.fetchAppSecretsForHydration,
		fetchOrgSecretsForHydration: mocks.fetchOrgSecretsForHydration,
	}),
);
vi.mock("@tedix/db/utils/secrets-encryption", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	decryptAppSecret: mocks.decryptAppSecret,
	decryptSecret: mocks.decryptSecret,
}));

import { AdapterRegistry } from "./registry";

const PRIVATE_ID = "private-secret-id";
const PRIVATE_TEXT = "private-secret-value";

describe("AdapterRegistry secret hydration diagnostics", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.restoreAllMocks());

	it("keeps adapter loading available after a binding read failure without logging the thrown text", async () => {
		mocks.getEnabledAdapters.mockResolvedValue([
			{ id: PRIVATE_ID, adapterType: "unsupported" },
		]);
		mocks.getBindingsBatch.mockRejectedValue(
			new Error(PRIVATE_TEXT, { cause: new TypeError(PRIVATE_ID) }),
		);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const registry = new AdapterRegistry({} as never, {
			SECRETS_MASTER_KEY: "test-master-key",
		});

		await expect(
			registry.loadAdaptersForApp("app-private"),
		).resolves.toBeUndefined();
		expect(logged).toHaveBeenCalledWith({
			component: "api.adapter-registry",
			event: "adapter_secret_hydration_failed",
			stage: "fetch_bindings",
			exception: { type: "Error", cause: { type: "TypeError" } },
		});
		expect(JSON.stringify(logged.mock.calls)).not.toMatch(
			/private-secret-value|private-secret-id|app-private/,
		);
	});

	it("keeps adapter configuration available after a batch secret fetch failure", async () => {
		mocks.getBindingsBatch.mockResolvedValue(new Map());
		mocks.getUniqueSecretIds.mockResolvedValue({
			appSecretIds: [PRIVATE_ID],
			orgSecretIds: [],
		});
		mocks.fetchAppSecretsForHydration.mockRejectedValue(
			new Error(PRIVATE_TEXT),
		);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const registry = new AdapterRegistry({} as never, {
			SECRETS_MASTER_KEY: "test-master-key",
		}) as unknown as {
			hydrateAdapterSecrets(
				adapters: unknown[],
				appId: string,
			): Promise<unknown[]>;
		};
		const adapter = { id: PRIVATE_ID, adapterType: "klarna", config: {} };

		await expect(
			registry.hydrateAdapterSecrets([adapter], "app-private"),
		).resolves.toEqual([adapter]);
		expect(logged).toHaveBeenCalledWith({
			component: "api.adapter-registry",
			event: "adapter_secret_hydration_failed",
			stage: "batch_fetch_secrets",
			exception: { type: "Error" },
		});
		expect(JSON.stringify(logged.mock.calls)).not.toMatch(
			/private-secret-value|private-secret-id|app-private/,
		);
	});

	it.each([
		["app", "decrypt_app_secret"],
		["org", "decrypt_org_secret"],
	] as const)(
		"continues after %s secret decryption fails without logging secret data",
		async (scope, stage) => {
			const secret = { id: PRIVATE_ID, encryptedValue: PRIVATE_TEXT };
			mocks.fetchAppSecretsForHydration.mockResolvedValue([secret]);
			mocks.fetchOrgSecretsForHydration.mockResolvedValue([secret]);
			mocks.decryptAppSecret.mockRejectedValue(new Error(PRIVATE_TEXT));
			mocks.decryptSecret.mockRejectedValue(new Error(PRIVATE_TEXT));
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});
			const registry = new AdapterRegistry({} as never, {
				SECRETS_MASTER_KEY: "test-master-key",
			}) as unknown as {
				batchDecryptAppSecrets(
					appId: string,
					secretIds: string[],
					masterKey: string,
				): Promise<Map<string, string>>;
				batchDecryptOrgSecrets(
					orgId: string,
					secretIds: string[],
					masterKey: string,
				): Promise<Map<string, string>>;
			};
			const result =
				scope === "app"
					? await registry.batchDecryptAppSecrets(
							"app-private",
							[PRIVATE_ID],
							"test-master-key",
						)
					: await registry.batchDecryptOrgSecrets(
							"org-private",
							[PRIVATE_ID],
							"test-master-key",
						);

			expect(result.size).toBe(0);
			expect(logged).toHaveBeenCalledWith({
				component: "api.adapter-registry",
				event: "adapter_secret_hydration_failed",
				stage,
				exception: { type: "Error" },
			});
			expect(JSON.stringify(logged.mock.calls)).not.toMatch(
				/private-secret-value|private-secret-id|app-private|org-private/,
			);
		},
	);
});
