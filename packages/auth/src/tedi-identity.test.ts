import { describe, expect, it, vi } from "vite-plus/test";
import {
	buildTediAccessKeyClaims,
	createTediBodyGenerationCredential,
	createTediIdentity,
	defaultTediAccessKeyExpireTime,
	extractTediRuntimeApiScopes,
	hashTediBodyGenerationToken,
	rotateTediAccessKey,
	TEDI_ACCESS_KEY_DEFAULT_TTL_SECONDS,
	TEDI_RUNTIME_API_SCOPES,
	TEDI_RUNTIME_API_SCOPES_CLAIM,
	verifyTediBodyGenerationToken,
} from "./tedi-identity";

describe("tedi access key claims", () => {
	it("stamps direct runtime API scopes into access-key JWT claims", () => {
		expect(
			buildTediAccessKeyClaims({
				tediId: "tedi-1",
				descopeUserId: "user-1",
			}),
		).toMatchObject({
			tediId: "tedi-1",
			entityType: "tedi",
			descopeUserId: "user-1",
			[TEDI_RUNTIME_API_SCOPES_CLAIM]: [...TEDI_RUNTIME_API_SCOPES],
		});
	});

	it("extracts direct runtime API scopes from the Tedix-owned claim", () => {
		expect(
			extractTediRuntimeApiScopes({
				[TEDI_RUNTIME_API_SCOPES_CLAIM]: [
					"tedis:read",
					"tedis:write",
					"billing:read",
				],
				scope: "ignored:reserved",
				scopes: ["also:ignored"],
			}),
		).toEqual(["tedis:read", "tedis:write", "billing:read"]);
	});

	it("uses the scoped claims when creating a tedi identity", async () => {
		const accessKeyCreate = vi.fn().mockResolvedValue({
			ok: true,
			data: { key: { id: "key-1" }, cleartext: "ak_1" },
		});
		const client = {
			management: {
				accessKey: { create: accessKeyCreate },
				user: {
					addTenant: vi.fn().mockResolvedValue({ ok: true }),
					addTenantRoles: vi.fn().mockResolvedValue({ ok: true }),
					create: vi.fn().mockResolvedValue({
						ok: true,
						data: { userId: "user-1" },
					}),
					delete: vi.fn().mockResolvedValue({ ok: true }),
				},
			},
		};

		await createTediIdentity(client as never, {
			displayName: "CTO",
			slug: "cto",
			tediId: "tedi-1",
			tenantId: "tenant-1",
		});

		expect(accessKeyCreate).toHaveBeenCalledWith(
			"tedi:cto",
			// Bounded absolute expiry (epoch seconds), no longer 0/non-expiring.
			expect.any(Number),
			["tedi"],
			undefined,
			"user-1",
			expect.objectContaining({
				tediId: "tedi-1",
				descopeUserId: "user-1",
				[TEDI_RUNTIME_API_SCOPES_CLAIM]: [...TEDI_RUNTIME_API_SCOPES],
			}),
			undefined,
			undefined,
			expect.objectContaining({
				tediId: "tedi-1",
				descopeUserId: "user-1",
				[TEDI_RUNTIME_API_SCOPES_CLAIM]: [...TEDI_RUNTIME_API_SCOPES],
			}),
		);
	});

	it("uses the scoped claims when rotating a tedi access key", async () => {
		const accessKeyCreate = vi.fn().mockResolvedValue({
			ok: true,
			data: { key: { id: "key-2" }, cleartext: "ak_2" },
		});
		const client = {
			management: {
				accessKey: {
					create: accessKeyCreate,
					deactivate: vi.fn().mockResolvedValue({ ok: true }),
				},
			},
		};

		await rotateTediAccessKey(client as never, {
			descopeUserId: "user-1",
			oldKeyId: "key-1",
			slug: "cto",
			tediId: "tedi-1",
		});

		expect(accessKeyCreate).toHaveBeenCalledWith(
			"tedi:cto",
			// Rotation must also mint a bounded key, never 0/non-expiring.
			expect.any(Number),
			["tedi"],
			undefined,
			"user-1",
			expect.objectContaining({
				tediId: "tedi-1",
				descopeUserId: "user-1",
				[TEDI_RUNTIME_API_SCOPES_CLAIM]: [...TEDI_RUNTIME_API_SCOPES],
			}),
			undefined,
			undefined,
			expect.objectContaining({
				tediId: "tedi-1",
				descopeUserId: "user-1",
				[TEDI_RUNTIME_API_SCOPES_CLAIM]: [...TEDI_RUNTIME_API_SCOPES],
			}),
		);
	});

	it("does not report the old key deactivated when Descope rejects it", async () => {
		const client = {
			management: {
				accessKey: {
					create: vi.fn().mockResolvedValue({
						ok: true,
						data: { key: { id: "key-2" }, cleartext: "ak_2" },
					}),
					deactivate: vi.fn().mockResolvedValue({ ok: false }),
				},
			},
		};

		const result = await rotateTediAccessKey(client as never, {
			descopeUserId: "user-1",
			oldKeyId: "key-1",
			slug: "cto",
			tediId: "tedi-1",
		});

		expect(result.oldKeyDeactivated).toBe(false);
	});

	it("creates and verifies short-lived body generation credentials", async () => {
		const now = new Date("2026-06-16T10:00:00.000Z");
		const credential = await createTediBodyGenerationCredential({
			generationId: "gen-1",
			now,
			randomBytes: new Uint8Array(32).fill(7),
			tokenTtlMs: 60_000,
		});

		expect(credential).toMatchObject({
			generationId: "gen-1",
			tokenExpiresAt: "2026-06-16T10:01:00.000Z",
		});
		expect(credential.token).toMatch(/^tbg_/);
		expect(credential.tokenHash).toBe(
			await hashTediBodyGenerationToken(credential.token),
		);
		await expect(
			verifyTediBodyGenerationToken({
				expectedHash: credential.tokenHash,
				now,
				token: credential.token,
				tokenExpiresAt: credential.tokenExpiresAt,
			}),
		).resolves.toBe(true);
	});

	it("rejects expired or mismatched body generation credentials", async () => {
		const now = new Date("2026-06-16T10:00:00.000Z");
		const credential = await createTediBodyGenerationCredential({
			now,
			randomBytes: new Uint8Array(32).fill(9),
			tokenTtlMs: 60_000,
		});

		await expect(
			verifyTediBodyGenerationToken({
				expectedHash: credential.tokenHash,
				now,
				token: "tbg_wrong",
				tokenExpiresAt: credential.tokenExpiresAt,
			}),
		).resolves.toBe(false);
		await expect(
			verifyTediBodyGenerationToken({
				expectedHash: credential.tokenHash,
				now: new Date("2026-06-16T10:01:01.000Z"),
				token: credential.token,
				tokenExpiresAt: credential.tokenExpiresAt,
			}),
		).resolves.toBe(false);
	});
});

describe("tedi access key bounded expiry", () => {
	it("computes an absolute epoch expiry a bounded TTL from now", () => {
		const now = new Date("2026-06-16T10:00:00.000Z");
		const expected =
			Math.floor(now.getTime() / 1000) + TEDI_ACCESS_KEY_DEFAULT_TTL_SECONDS;
		expect(defaultTediAccessKeyExpireTime(now)).toBe(expected);
		expect(defaultTediAccessKeyExpireTime(now)).toBeGreaterThan(
			Math.floor(now.getTime() / 1000),
		);
	});

	it("mints a bounded (non-zero, ~90d) access key on identity creation", async () => {
		const accessKeyCreate = vi.fn().mockResolvedValue({
			ok: true,
			data: { key: { id: "key-1" }, cleartext: "ak_1" },
		});
		const client = {
			management: {
				accessKey: { create: accessKeyCreate },
				user: {
					addTenant: vi.fn().mockResolvedValue({ ok: true }),
					addTenantRoles: vi.fn().mockResolvedValue({ ok: true }),
					create: vi
						.fn()
						.mockResolvedValue({ ok: true, data: { userId: "user-1" } }),
					delete: vi.fn().mockResolvedValue({ ok: true }),
				},
			},
		};

		const before = Math.floor(Date.now() / 1000);
		await createTediIdentity(client as never, {
			displayName: "CTO",
			slug: "cto",
			tediId: "tedi-1",
			tenantId: "tenant-1",
		});

		const expireTime = accessKeyCreate.mock.calls[0]?.[1] as number;
		expect(expireTime).not.toBe(0);
		expect(expireTime).toBeGreaterThanOrEqual(
			before + TEDI_ACCESS_KEY_DEFAULT_TTL_SECONDS,
		);
		expect(expireTime).toBeLessThanOrEqual(
			Math.floor(Date.now() / 1000) + TEDI_ACCESS_KEY_DEFAULT_TTL_SECONDS + 5,
		);
	});

	it("honors an explicit expireTime override", async () => {
		const accessKeyCreate = vi.fn().mockResolvedValue({
			ok: true,
			data: { key: { id: "key-1" }, cleartext: "ak_1" },
		});
		const client = {
			management: {
				accessKey: { create: accessKeyCreate },
				user: {
					addTenant: vi.fn().mockResolvedValue({ ok: true }),
					addTenantRoles: vi.fn().mockResolvedValue({ ok: true }),
					create: vi
						.fn()
						.mockResolvedValue({ ok: true, data: { userId: "user-1" } }),
					delete: vi.fn().mockResolvedValue({ ok: true }),
				},
			},
		};

		await createTediIdentity(client as never, {
			displayName: "CTO",
			slug: "cto",
			tediId: "tedi-1",
			tenantId: "tenant-1",
			expireTime: 1234567890,
		});

		expect(accessKeyCreate.mock.calls[0]?.[1]).toBe(1234567890);
	});
});

describe("tedi identity tenant-assignment rollback", () => {
	function baseClient(overrides: {
		addTenant?: ReturnType<typeof vi.fn>;
		addTenantRoles?: ReturnType<typeof vi.fn>;
		deleteUser?: ReturnType<typeof vi.fn>;
	}) {
		const accessKeyCreate = vi.fn().mockResolvedValue({
			ok: true,
			data: { key: { id: "key-1" }, cleartext: "ak_1" },
		});
		const deleteUser =
			overrides.deleteUser ?? vi.fn().mockResolvedValue({ ok: true });
		return {
			accessKeyCreate,
			deleteUser,
			client: {
				management: {
					accessKey: { create: accessKeyCreate },
					user: {
						addTenant:
							overrides.addTenant ?? vi.fn().mockResolvedValue({ ok: true }),
						addTenantRoles:
							overrides.addTenantRoles ??
							vi.fn().mockResolvedValue({ ok: true }),
						create: vi
							.fn()
							.mockResolvedValue({ ok: true, data: { userId: "user-1" } }),
						delete: deleteUser,
					},
				},
			},
		};
	}

	it("rolls back the created user and throws when addTenant fails", async () => {
		const addTenant = vi.fn().mockResolvedValue({
			ok: false,
			error: { errorCode: "E100", errorDescription: "tenant assign boom" },
		});
		const { client, deleteUser, accessKeyCreate } = baseClient({ addTenant });

		await expect(
			createTediIdentity(client as never, {
				displayName: "CTO",
				slug: "cto",
				tediId: "tedi-1",
				tenantId: "tenant-1",
			}),
		).rejects.toThrow(/Failed to assign tenant to tedi user/);

		expect(deleteUser).toHaveBeenCalledWith("tedi:cto");
		expect(accessKeyCreate).not.toHaveBeenCalled();
	});

	it("rolls back the created user and throws when addTenantRoles fails", async () => {
		const addTenantRoles = vi.fn().mockResolvedValue({
			ok: false,
			error: { errorCode: "E101", errorDescription: "role assign boom" },
		});
		const { client, deleteUser, accessKeyCreate } = baseClient({
			addTenantRoles,
		});

		await expect(
			createTediIdentity(client as never, {
				displayName: "CTO",
				slug: "cto",
				tediId: "tedi-1",
				tenantId: "tenant-1",
			}),
		).rejects.toThrow(/Failed to assign tenant roles to tedi user/);

		expect(deleteUser).toHaveBeenCalledWith("tedi:cto");
		expect(accessKeyCreate).not.toHaveBeenCalled();
	});

	it("tolerates an 'already exists' assignment error without rollback", async () => {
		const addTenant = vi.fn().mockResolvedValue({
			ok: false,
			error: {
				errorCode: "E200",
				errorDescription: "Tenant already associated with user",
			},
		});
		const { client, deleteUser, accessKeyCreate } = baseClient({ addTenant });

		await expect(
			createTediIdentity(client as never, {
				displayName: "CTO",
				slug: "cto",
				tediId: "tedi-1",
				tenantId: "tenant-1",
			}),
		).resolves.toMatchObject({ descopeKeyId: "key-1" });

		expect(deleteUser).not.toHaveBeenCalled();
		expect(accessKeyCreate).toHaveBeenCalledOnce();
	});

	it("tolerates Descope's 'already part of the tenant' response", async () => {
		const addTenant = vi.fn().mockResolvedValue({
			ok: false,
			error: {
				errorCode: "E023002",
				errorDescription:
					"Failed to add user to tenant, user already part of the tenant",
			},
		});
		const { client, deleteUser, accessKeyCreate } = baseClient({ addTenant });

		await expect(
			createTediIdentity(client as never, {
				displayName: "Globex Tedi",
				slug: "globex-operator",
				tediId: "tedi-globex",
				tenantId: "tenant-globex",
			}),
		).resolves.toMatchObject({ descopeKeyId: "key-1" });

		expect(deleteUser).not.toHaveBeenCalled();
		expect(accessKeyCreate).toHaveBeenCalledOnce();
	});
});
