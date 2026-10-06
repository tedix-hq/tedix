import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	runTediAccessKeyRotationTick,
	TEDI_ACCESS_KEY_ROTATE_AFTER_DAYS,
} from "./tedi-access-key-rotation";

const mocks = vi.hoisted(() => ({
	listDue: vi.fn(),
	getSecret: vi.fn(),
	getSecretById: vi.fn(),
	replaceSecrets: vi.fn(),
	acquireLease: vi.fn(),
	releaseLease: vi.fn(),
	decrypt: vi.fn(),
	encrypt: vi.fn(),
	rotate: vi.fn(),
	deactivate: vi.fn(),
	invalidate: vi.fn(),
	emitAudit: vi.fn(),
}));

vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/tedi-secrets", () => ({
	listTediAccessKeysDueForRotation: mocks.listDue,
	getTediSecret: mocks.getSecret,
	getTediSecretById: mocks.getSecretById,
	replaceTediAccessKeySecrets: mocks.replaceSecrets,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	tryAcquireTediRuntimeLease: mocks.acquireLease,
	releaseTediRuntimeLease: mocks.releaseLease,
}));
vi.mock("@tedix/db/utils/secrets-encryption", () => ({
	decryptTediSecret: mocks.decrypt,
	encryptTediSecret: mocks.encrypt,
}));
vi.mock("@tedix/auth/tedi-identity", () => ({
	rotateTediAccessKey: mocks.rotate,
}));
vi.mock("@tedix/auth/client", () => ({
	getManagementClient: () => ({
		management: { accessKey: { deactivate: mocks.deactivate } },
	}),
}));
vi.mock("@tedix/provisioning", () => ({
	invalidateConfig: mocks.invalidate,
}));
vi.mock("../rpc/routers/tedis/helpers", () => ({
	getProvisioningConfig: () => ({ workerUrl: "https://cto.tedi.tedix.dev" }),
}));
vi.mock("../rpc/audit-helpers", () => ({ emitAuditEvent: mocks.emitAudit }));

const env = {
	DB: {},
	DESCOPE_PROJECT_ID: "project",
	DESCOPE_MANAGEMENT_KEY: "management-key",
	SECRETS_MASTER_KEY: "master-key",
} as unknown as CloudflareEnv;
const now = new Date("2026-08-20T00:00:00.000Z");
const oldUpdatedAt = new Date(
	now.getTime() - (TEDI_ACCESS_KEY_ROTATE_AFTER_DAYS + 1) * 86_400_000,
).toISOString();

afterEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("tedi access-key rotation cron", () => {
	it("coalesces overlapping ticks with the per-tedi lease", async () => {
		mocks.listDue.mockResolvedValue([
			{
				tediId: "tedi-1",
				organizationId: "org-1",
				slug: "cto",
				descopeUserId: "user-1",
				accessKeySecretId: "secret-key",
				accessKeyUpdatedAt: oldUpdatedAt,
			},
		]);
		mocks.acquireLease.mockResolvedValue(false);

		const result = await runTediAccessKeyRotationTick(env, "run-overlap", now);

		expect(result).toMatchObject({
			candidates: 1,
			leaseContended: 1,
			rotated: 0,
		});
		expect(mocks.rotate).not.toHaveBeenCalled();
		expect(mocks.replaceSecrets).not.toHaveBeenCalled();
		expect(mocks.releaseLease).not.toHaveBeenCalled();
	});

	it("persists and refreshes the replacement before deactivating the old key", async () => {
		mocks.listDue.mockResolvedValue([
			{
				tediId: "tedi-1",
				organizationId: "org-1",
				slug: "cto",
				descopeUserId: "user-1",
				accessKeySecretId: "secret-key",
				accessKeyUpdatedAt: oldUpdatedAt,
			},
		]);
		mocks.acquireLease.mockResolvedValue(true);
		mocks.getSecretById.mockResolvedValue({
			id: "secret-key",
			updatedAt: oldUpdatedAt,
		});
		mocks.getSecret.mockResolvedValue({
			id: "secret-key-id",
			encryptedValue: "encrypted-old-id",
		});
		mocks.decrypt.mockResolvedValue("old-key-id");
		mocks.rotate.mockResolvedValue({
			descopeKeyId: "new-key-id",
			cleartext: "new-cleartext",
			oldKeyDeactivated: false,
		});
		mocks.encrypt
			.mockResolvedValueOnce("encrypted-new-key")
			.mockResolvedValueOnce("encrypted-new-id");
		mocks.replaceSecrets.mockResolvedValue(undefined);
		mocks.invalidate.mockResolvedValue(true);
		mocks.deactivate.mockResolvedValue({ ok: true });
		mocks.emitAudit.mockResolvedValue(undefined);
		mocks.releaseLease.mockResolvedValue(undefined);

		const result = await runTediAccessKeyRotationTick(env, "run-1", now);

		expect(mocks.rotate).toHaveBeenCalledWith(expect.anything(), {
			slug: "cto",
			descopeUserId: "user-1",
			oldKeyId: "old-key-id",
			tediId: "tedi-1",
			deactivateOld: false,
		});
		expect(mocks.replaceSecrets).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				encryptedAccessKey: "encrypted-new-key",
				encryptedAccessKeyId: "encrypted-new-id",
			}),
		);
		expect(mocks.replaceSecrets.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.invalidate.mock.invocationCallOrder[0],
		);
		expect(mocks.invalidate.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.deactivate.mock.invocationCallOrder[0],
		);
		expect(result).toMatchObject({ rotated: 1, failed: 0 });
		expect(mocks.emitAudit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: "org-1",
				action: "tedi.auth.rotate_access_key",
				resourceId: "tedi-1",
			}),
		);
		expect(mocks.releaseLease).toHaveBeenCalledOnce();
	});

	it("retires an unpersisted replacement and leaves the old key active", async () => {
		mocks.listDue.mockResolvedValue([
			{
				tediId: "tedi-1",
				organizationId: "org-1",
				slug: "cto",
				descopeUserId: "user-1",
				accessKeySecretId: "secret-key",
				accessKeyUpdatedAt: oldUpdatedAt,
			},
		]);
		mocks.acquireLease.mockResolvedValue(true);
		mocks.getSecretById.mockResolvedValue({
			id: "secret-key",
			updatedAt: oldUpdatedAt,
		});
		mocks.getSecret.mockResolvedValue({
			id: "secret-key-id",
			encryptedValue: "encrypted-old-id",
		});
		mocks.decrypt.mockResolvedValue("old-key-id");
		mocks.rotate.mockResolvedValue({
			descopeKeyId: "new-key-id",
			cleartext: "new-cleartext",
			oldKeyDeactivated: false,
		});
		mocks.encrypt.mockResolvedValue("encrypted");
		mocks.replaceSecrets.mockRejectedValue(new Error("D1 unavailable"));
		mocks.deactivate.mockResolvedValue({ ok: true });
		mocks.releaseLease.mockResolvedValue(undefined);

		const result = await runTediAccessKeyRotationTick(env, "run-1", now);

		expect(mocks.deactivate).toHaveBeenCalledOnce();
		expect(mocks.deactivate).toHaveBeenCalledWith("new-key-id");
		expect(mocks.invalidate).not.toHaveBeenCalled();
		expect(result).toMatchObject({ rotated: 0, failed: 1 });
	});

	it("retries the still-stale key on the next tick after partial failure", async () => {
		const candidate = {
			tediId: "tedi-1",
			organizationId: "org-1",
			slug: "cto",
			descopeUserId: "user-1",
			accessKeySecretId: "secret-key",
			accessKeyUpdatedAt: oldUpdatedAt,
		};
		mocks.listDue.mockResolvedValue([candidate]);
		mocks.acquireLease.mockResolvedValue(true);
		mocks.getSecretById.mockResolvedValue({
			id: "secret-key",
			updatedAt: oldUpdatedAt,
		});
		mocks.getSecret.mockResolvedValue({
			id: "secret-key-id",
			encryptedValue: "encrypted-old-id",
		});
		mocks.decrypt.mockResolvedValue("old-key-id");
		mocks.rotate
			.mockResolvedValueOnce({
				descopeKeyId: "discarded-key-id",
				cleartext: "discarded-cleartext",
				oldKeyDeactivated: false,
			})
			.mockResolvedValueOnce({
				descopeKeyId: "persisted-key-id",
				cleartext: "persisted-cleartext",
				oldKeyDeactivated: false,
			});
		mocks.encrypt.mockResolvedValue("encrypted");
		mocks.replaceSecrets
			.mockRejectedValueOnce(new Error("D1 unavailable"))
			.mockResolvedValueOnce(undefined);
		mocks.deactivate.mockResolvedValue({ ok: true });
		mocks.invalidate.mockResolvedValue(true);
		mocks.emitAudit.mockResolvedValue(undefined);
		mocks.releaseLease.mockResolvedValue(undefined);

		const first = await runTediAccessKeyRotationTick(env, "run-first", now);
		const second = await runTediAccessKeyRotationTick(
			env,
			"run-retry",
			new Date(now.getTime() + 86_400_000),
		);

		expect(first).toMatchObject({ failed: 1, rotated: 0 });
		expect(second).toMatchObject({ failed: 0, rotated: 1 });
		expect(mocks.rotate).toHaveBeenCalledTimes(2);
		expect(mocks.deactivate).toHaveBeenNthCalledWith(1, "discarded-key-id");
		expect(mocks.deactivate).toHaveBeenNthCalledWith(2, "old-key-id");
		expect(mocks.emitAudit).toHaveBeenCalledOnce();
	});

	it("defers old-key deactivation when runtime refresh is not confirmed", async () => {
		mocks.listDue.mockResolvedValue([
			{
				tediId: "tedi-1",
				organizationId: "org-1",
				slug: "cto",
				descopeUserId: "user-1",
				accessKeySecretId: "secret-key",
				accessKeyUpdatedAt: oldUpdatedAt,
			},
		]);
		mocks.acquireLease.mockResolvedValue(true);
		mocks.getSecretById.mockResolvedValue({
			id: "secret-key",
			updatedAt: oldUpdatedAt,
		});
		mocks.getSecret.mockResolvedValue({
			id: "secret-key-id",
			encryptedValue: "encrypted-old-id",
		});
		mocks.decrypt.mockResolvedValue("old-key-id");
		mocks.rotate.mockResolvedValue({
			descopeKeyId: "new-key-id",
			cleartext: "new-cleartext",
			oldKeyDeactivated: false,
		});
		mocks.encrypt.mockResolvedValue("encrypted");
		mocks.replaceSecrets.mockResolvedValue(undefined);
		mocks.invalidate.mockResolvedValue(false);
		mocks.emitAudit.mockResolvedValue(undefined);
		mocks.releaseLease.mockResolvedValue(undefined);

		const result = await runTediAccessKeyRotationTick(env, "run-1", now);

		expect(mocks.deactivate).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			rotated: 1,
			runtimeRefreshFailed: 1,
			oldKeyDeactivationDeferred: 1,
		});
	});

	it("no-ops when management or encryption credentials are absent", async () => {
		const result = await runTediAccessKeyRotationTick(
			{ DB: {} } as unknown as CloudflareEnv,
			"run-1",
			now,
		);
		expect(result).toEqual({});
		expect(mocks.listDue).not.toHaveBeenCalled();
	});
});
