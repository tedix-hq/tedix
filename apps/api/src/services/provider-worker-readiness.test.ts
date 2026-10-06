import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
const mocks = vi.hoisted(() => ({
	acquire: vi.fn(),
	release: vi.fn(),
	get: vi.fn(),
	update: vi.fn(),
	repair: vi.fn(),
	rotate: vi.fn(),
	bind: vi.fn(),
	secrets: vi.fn(),
	upsert: vi.fn(),
	pair: vi.fn(),
	decrypt: vi.fn(),
}));
vi.mock("@tedix/auth/client", () => ({ getManagementClient: () => ({}) }));
vi.mock("@tedix/auth/tedi-identity", () => ({
	repairTediIdentity: mocks.repair,
	rotateTediAccessKey: mocks.rotate,
}));
vi.mock("@tedix/db/queries/principal-identities", () => ({
	bindPrincipalIdentity: mocks.bind,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediBySlug: mocks.get,
	updateTedi: mocks.update,
	tryAcquireTediRuntimeLease: mocks.acquire,
	releaseTediRuntimeLease: mocks.release,
}));
vi.mock("@tedix/db/queries/tedi-secrets", () => ({
	getAllTediSecrets: mocks.secrets,
	upsertTediSecret: mocks.upsert,
	upsertTediAccessKeySecrets: mocks.pair,
}));
vi.mock("@tedix/db/utils/secrets-encryption", () => ({
	encryptTediSecret: async (_key: string, _id: string, value: string) =>
		`enc:${value}`,
	decryptTediSecret: mocks.decrypt,
}));
import { ensureProviderWorkerReady } from "./provider-worker-readiness";
import { TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME } from "@tedix/db/schema/tedi-secrets";
const input = {
	organizationId: "org",
	tenantId: "tenant",
	tediId: "worker",
	slug: "embedded-key",
};
const context = {
	db: {},
	env: {
		SECRETS_MASTER_KEY: "key",
		DESCOPE_PROJECT_ID: "project",
		DESCOPE_MANAGEMENT_KEY: "management",
	},
} as BaseContext;
const complete = [
	"DESCOPE_ACCESS_KEY",
	"DESCOPE_ACCESS_KEY_ID",
	TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME,
	"CDP_SECRET",
].map((name) => ({ name, encryptedValue: `enc:${name}` }));
beforeEach(() => {
	vi.resetAllMocks();
	mocks.acquire.mockResolvedValue(true);
	mocks.get.mockResolvedValue({
		id: "worker",
		name: "Garage",
		slug: "embedded-key",
		status: "active",
		descopeUserId: "user",
		runtimeProfileId: "runtime",
		policyPackId: "policy",
		workspaceTemplateSetId: "template",
	});
	mocks.repair.mockResolvedValue({ descopeUserId: "user" });
	mocks.secrets.mockResolvedValue(complete);
	mocks.decrypt.mockImplementation(async (_key, _id, value) => value.slice(4));
	mocks.rotate.mockResolvedValue({
		cleartext: "new-key",
		descopeKeyId: "new-id",
	});
});
describe("provider worker readiness", () => {
	it("preserves complete credentials and repairs principal binding", async () => {
		await ensureProviderWorkerReady(context, input);
		expect(mocks.rotate).not.toHaveBeenCalled();
		expect(mocks.pair).not.toHaveBeenCalled();
		expect(mocks.upsert).not.toHaveBeenCalled();
		expect(mocks.bind).toHaveBeenCalledOnce();
	});
	it("recovers an identity created before its secret was persisted", async () => {
		mocks.secrets.mockResolvedValueOnce(
			complete.filter((s) => s.name !== "DESCOPE_ACCESS_KEY"),
		);
		await ensureProviderWorkerReady(context, input);
		expect(mocks.rotate).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ deactivateOld: false }),
		);
		expect(mocks.pair).toHaveBeenCalledWith(context.db, {
			tediId: "worker",
			encryptedAccessKey: "enc:new-key",
			encryptedAccessKeyId: "enc:new-id",
		});
	});
	it("recovers a row without identity and saves the newly issued pair", async () => {
		mocks.get.mockResolvedValueOnce({
			...(await mocks.get()),
			descopeUserId: null,
		});
		mocks.repair.mockResolvedValue({
			descopeUserId: "recovered",
			cleartext: "issued",
			descopeKeyId: "issued-id",
		});
		const result = await ensureProviderWorkerReady(context, input);
		expect(result.descopeUserId).toBe("recovered");
		expect(mocks.pair).toHaveBeenCalledOnce();
		expect(mocks.rotate).not.toHaveBeenCalled();
	});
	it("does not report readiness when persistence fails and allows a retry", async () => {
		mocks.secrets.mockResolvedValueOnce([]);
		mocks.pair.mockRejectedValueOnce(new Error("D1 unavailable"));
		await expect(ensureProviderWorkerReady(context, input)).rejects.toThrow(
			"D1 unavailable",
		);
		expect(mocks.release).toHaveBeenCalledOnce();
		await expect(
			ensureProviderWorkerReady(context, input),
		).resolves.toHaveProperty("id", "worker");
	});
	it("rejects unreadable saved credentials without silently overwriting them", async () => {
		mocks.decrypt.mockRejectedValue(new Error("decryption failed"));
		await expect(ensureProviderWorkerReady(context, input)).rejects.toThrow(
			"decryption failed",
		);
		expect(mocks.rotate).not.toHaveBeenCalled();
	});
	it("concurrent first requests have one credential writer and the loser retries", async () => {
		const worker = { ...(await mocks.get()), descopeUserId: null };
		mocks.get.mockImplementation(async () => worker);
		mocks.update.mockImplementation(async (_db, _id, patch) =>
			Object.assign(worker, patch),
		);
		const saved: Array<{ name: string; encryptedValue: string }> = [];
		mocks.secrets.mockImplementation(async () => [...saved]);
		mocks.pair.mockImplementation(async (_db, pair) => {
			saved.push(
				{ name: "DESCOPE_ACCESS_KEY", encryptedValue: pair.encryptedAccessKey },
				{
					name: "DESCOPE_ACCESS_KEY_ID",
					encryptedValue: pair.encryptedAccessKeyId,
				},
			);
		});
		mocks.upsert.mockImplementation(async (_db, _id, name, encryptedValue) =>
			saved.push({ name, encryptedValue }),
		);
		let held = false;
		mocks.acquire.mockImplementation(async () => {
			if (held) return false;
			held = true;
			return true;
		});
		mocks.release.mockImplementation(async () => {
			held = false;
		});
		let resume!: () => void;
		const blocked = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		mocks.repair.mockImplementationOnce(async () => {
			started();
			await blocked;
			return {
				descopeUserId: "user",
				cleartext: "issued-key",
				descopeKeyId: "issued-id",
			};
		});
		const first = ensureProviderWorkerReady(context, input);
		await entered;
		await expect(ensureProviderWorkerReady(context, input)).rejects.toThrow(
			"in progress",
		);
		expect(mocks.repair).toHaveBeenCalledOnce();
		resume();
		await first;
		await ensureProviderWorkerReady(context, input);
		expect(mocks.rotate).not.toHaveBeenCalled();
		expect(mocks.release).toHaveBeenCalledTimes(2);
		expect(mocks.pair).toHaveBeenCalledOnce();
		expect(saved).toHaveLength(4);
	});
	it("rejects missing runtime bindings before provisioning credentials", async () => {
		mocks.get.mockResolvedValueOnce({
			...(await mocks.get()),
			policyPackId: null,
		});
		await expect(ensureProviderWorkerReady(context, input)).rejects.toThrow(
			"configuration is not ready",
		);
		expect(mocks.repair).not.toHaveBeenCalled();
	});
});
