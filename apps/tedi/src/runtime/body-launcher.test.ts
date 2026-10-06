import { hashTediBodyGenerationToken } from "@tedix/auth/tedi-identity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../workstation/computer-body", () => ({
	workstationExec: (
		body: { nativeExec: (...args: unknown[]) => unknown },
		...args: unknown[]
	) => body.nativeExec(...args),
	workstationWriteFile: vi.fn(),
}));

const namespaceMocks = vi.hoisted(() => ({
	getByName: vi.fn(),
}));

vi.mock("@cloudflare/sandbox", () => ({
	getByName: namespaceMocks.getByName,
}));

import {
	CloudflareSandboxWorkstationLauncher,
	verifyArmedBodyGeneration,
} from "./body-launcher";

type MockGenerationRow = {
	bodyGenerationExternalId?: string | null;
	bodyGenerationHeartbeatAt?: string | null;
	bodyGenerationId?: string | null;
	bodyGenerationKind?: "agent" | "workstation" | null;
	bodyGenerationStatus?: "armed" | "ready" | "failed" | null;
	bodyGenerationTokenExpiresAt?: string | null;
	bodyGenerationTokenHash?: string | null;
};

function createMockD1(
	options: { changes?: number; throwMissingSchema?: boolean } = {},
) {
	const runs: Array<{ sql: string; values: unknown[] }> = [];
	let firstRow: MockGenerationRow | null = null;
	const db = {
		prepare: vi.fn((sql: string) => ({
			bind: (...values: unknown[]) => ({
				first: vi.fn(async () => {
					if (options.throwMissingSchema) {
						throw new Error("D1_ERROR: no such column: body_generation_id");
					}
					return firstRow;
				}),
				run: vi.fn(async () => {
					if (options.throwMissingSchema) {
						throw new Error("D1_ERROR: no such column: body_generation_id");
					}
					runs.push({ sql, values });
					return { meta: { changes: options.changes ?? 1 }, success: true };
				}),
			}),
		})),
		runs,
		setFirstRow(row: MockGenerationRow | null) {
			firstRow = row;
		},
	};
	return db;
}

describe("CloudflareSandboxWorkstationLauncher", () => {
	beforeEach(() => {
		namespaceMocks.getByName.mockReset();
	});

	it("arms D1 before resolving the Sandbox body", async () => {
		const events: string[] = [];
		const db = createMockD1();
		const sandbox = { nativeExec: vi.fn() };
		namespaceMocks.getByName.mockImplementation(() => {
			events.push("getByName");
			return sandbox;
		});

		const launcher = new CloudflareSandboxWorkstationLauncher({
			bodyKind: "workstation",
			db: db as unknown as D1Database,
			namespace: { getByName: namespaceMocks.getByName } as never,
			proofEnvPath: "/home/tedi/workstation/.tedix-body-generation.env",
			record: { kind: "tedi", id: "tedi-1", tediId: "tedi-1" },
		});

		const generation = await launcher.arm({ requireToken: true });
		expect(namespaceMocks.getByName).not.toHaveBeenCalled();
		expect(db.runs[0]?.values).toEqual([
			generation.generationId,
			"workstation",
			"armed",
			generation.tokenHash,
			generation.tokenExpiresAt,
			"tedi-1",
			"tedi-1",
		]);

		await launcher.ensureBody();
		expect(events).toEqual(["getByName"]);
		expect(namespaceMocks.getByName).toHaveBeenCalledWith("tedi-1");
	});

	it("drops the cached Sandbox handle when terminating a generation", async () => {
		const db = createMockD1();
		const firstSandbox = { nativeExec: vi.fn() };
		const secondSandbox = { nativeExec: vi.fn() };
		namespaceMocks.getByName
			.mockReturnValueOnce(firstSandbox)
			.mockReturnValueOnce(secondSandbox);

		const launcher = new CloudflareSandboxWorkstationLauncher({
			bodyKind: "workstation",
			db: db as unknown as D1Database,
			namespace: { getByName: namespaceMocks.getByName } as never,
			proofEnvPath: "/home/tedi/workstation/.tedix-body-generation.env",
			record: { kind: "tedi", id: "tedi-reset", tediId: "tedi-reset" },
		});

		await expect(launcher.ensureBody()).resolves.toBe(firstSandbox);
		await launcher.terminateGeneration("egress-guard-upgrade");
		await expect(launcher.ensureBody()).resolves.toBe(secondSandbox);
		expect(namespaceMocks.getByName).toHaveBeenCalledTimes(2);
	});

	it("uses a provided physical sandbox id without changing the durable generation record", async () => {
		const db = createMockD1();
		const sandbox = { nativeExec: vi.fn() };
		namespaceMocks.getByName.mockReturnValue(sandbox);

		const launcher = new CloudflareSandboxWorkstationLauncher({
			bodyKind: "workstation",
			db: db as unknown as D1Database,
			externalId: "tedi-1",
			namespace: { getByName: namespaceMocks.getByName } as never,
			proofEnvPath: "/home/tedi/workstation/.tedix-body-generation.env",
			record: { kind: "tedi", id: "tedi-1", tediId: "tedi-1" },
			sandboxId: "physical-sandbox-v1",
		});

		const generation = await launcher.arm({ requireToken: true });
		await launcher.ensureBody();

		expect(generation.externalId).toBe("tedi-1");
		expect(db.runs[0]?.values.at(-2)).toBe("tedi-1");
		expect(db.runs[0]?.values.at(-1)).toBe("tedi-1");
		expect(namespaceMocks.getByName).toHaveBeenCalledWith(
			"physical-sandbox-v1",
		);
	});

	it("reuses an unexpired armed generation without rewriting D1", async () => {
		const db = createMockD1();
		db.setFirstRow({
			bodyGenerationExternalId: "tedi-2",
			bodyGenerationId: "gen_existing",
			bodyGenerationKind: "workstation",
			bodyGenerationStatus: "armed",
			bodyGenerationTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			bodyGenerationTokenHash:
				await hashTediBodyGenerationToken("tbg_existing"),
		});
		const launcher = new CloudflareSandboxWorkstationLauncher({
			bodyKind: "workstation",
			db: db as unknown as D1Database,
			namespace: { getByName: namespaceMocks.getByName } as never,
			proofEnvPath: "/home/tedi/workstation/.tedix-body-generation.env",
			record: { kind: "tedi", id: "tedi-2", tediId: "tedi-2" },
		});

		const first = await launcher.arm();
		const second = await launcher.arm();

		expect(first.generationId).toBe("gen_existing");
		expect(second).toBe(first);
		expect(first.token).toBeUndefined();
		expect(db.runs).toHaveLength(0);
	});

	it("reuses a token generation only when the durable row still matches", async () => {
		const db = createMockD1();
		const launcher = new CloudflareSandboxWorkstationLauncher({
			bodyKind: "workstation",
			db: db as unknown as D1Database,
			namespace: { getByName: namespaceMocks.getByName } as never,
			proofEnvPath: "/home/tedi/workstation/.tedix-body-generation.env",
			record: {
				kind: "tedi",
				id: "tedi-token-current",
				tediId: "tedi-token-current",
			},
		});

		const first = await launcher.arm({ requireToken: true });
		db.setFirstRow({
			bodyGenerationExternalId: "tedi-token-current",
			bodyGenerationId: first.generationId,
			bodyGenerationKind: "workstation",
			bodyGenerationStatus: "armed",
			bodyGenerationTokenExpiresAt: first.tokenExpiresAt,
			bodyGenerationTokenHash: first.tokenHash,
		});
		const second = await launcher.arm({ requireToken: true });

		expect(second).toBe(first);
		expect(db.runs).toHaveLength(1);
	});

	it("rotates a cached token generation when the durable row changed", async () => {
		const db = createMockD1();
		const launcher = new CloudflareSandboxWorkstationLauncher({
			bodyKind: "workstation",
			db: db as unknown as D1Database,
			namespace: { getByName: namespaceMocks.getByName } as never,
			proofEnvPath: "/home/tedi/workstation/.tedix-body-generation.env",
			record: {
				kind: "tedi",
				id: "tedi-token-stale",
				tediId: "tedi-token-stale",
			},
		});

		const first = await launcher.arm({ requireToken: true });
		db.setFirstRow({
			bodyGenerationExternalId: "tedi-token-stale",
			bodyGenerationId: "gen_rotated_elsewhere",
			bodyGenerationKind: "workstation",
			bodyGenerationStatus: "armed",
			bodyGenerationTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			bodyGenerationTokenHash:
				await hashTediBodyGenerationToken("tbg_elsewhere"),
		});
		const second = await launcher.arm({ requireToken: true });

		expect(second.generationId).not.toBe(first.generationId);
		expect(second.token).toBeTruthy();
		expect(db.runs).toHaveLength(2);
	});

	it("reports an untracked generation when the arm update matches no durable row", async () => {
		const db = createMockD1({ changes: 0 });
		const launcher = new CloudflareSandboxWorkstationLauncher({
			bodyKind: "workstation",
			db: db as unknown as D1Database,
			namespace: { getByName: namespaceMocks.getByName } as never,
			proofEnvPath: "/home/tedi/.tedix-body-generation.env",
			record: {
				kind: "workstationLease",
				id: "wl_coding_org_missing",
				tediId: "tedi-missing",
			},
		});

		await expect(launcher.arm({ requireToken: true })).resolves.toMatchObject({
			trackingEnabled: false,
		});
	});

	it("verifies workstation ready against body-presented proof on the lease", async () => {
		const db = createMockD1();
		const sandbox = {
			nativeExec: vi.fn(),
		};
		namespaceMocks.getByName.mockReturnValue(sandbox);

		const launcher = new CloudflareSandboxWorkstationLauncher({
			bodyKind: "workstation",
			db: db as unknown as D1Database,
			namespace: { getByName: namespaceMocks.getByName } as never,
			proofEnvPath: "/home/tedi/.tedix-body-generation.env",
			record: {
				kind: "workstationLease",
				id: "wl_coding_org_cto",
				tediId: "tedi-3",
			},
		});
		const generation = await launcher.arm({ requireToken: true });
		expect(generation.token).toBeTruthy();
		db.setFirstRow({
			bodyGenerationId: generation.generationId,
			bodyGenerationKind: "workstation",
			bodyGenerationStatus: "armed",
			bodyGenerationTokenExpiresAt: generation.tokenExpiresAt,
			bodyGenerationTokenHash: generation.tokenHash,
		});
		sandbox.nativeExec.mockResolvedValue({
			exitCode: 0,
			stdout: `${generation.generationId}\n${generation.token}\n`,
		});

		await expect(launcher.status("ready")).resolves.toMatchObject({
			generationId: generation.generationId,
			status: "ready",
			trackingEnabled: true,
		});
		expect(db.runs.at(-1)?.sql).toContain("UPDATE workstation_leases");
	});

	it.each([{ timedOut: true }, { truncated: true }, { signal: 15 }])(
		"rejects incomplete native body proof %j",
		async (incomplete) => {
			const db = createMockD1();
			const sandbox = {
				nativeExec: vi.fn(),
			};
			namespaceMocks.getByName.mockReturnValue(sandbox);

			const launcher = new CloudflareSandboxWorkstationLauncher({
				bodyKind: "workstation",
				db: db as unknown as D1Database,
				namespace: { getByName: namespaceMocks.getByName } as never,
				proofEnvPath: "/home/tedi/.tedix-body-generation.env",
				record: {
					kind: "workstationLease",
					id: "wl_coding_org_cto",
					tediId: "tedi-3",
				},
			});
			const generation = await launcher.arm({ requireToken: true });
			expect(generation.token).toBeTruthy();
			db.setFirstRow({
				bodyGenerationId: generation.generationId,
				bodyGenerationKind: "workstation",
				bodyGenerationStatus: "armed",
				bodyGenerationTokenExpiresAt: generation.tokenExpiresAt,
				bodyGenerationTokenHash: generation.tokenHash,
			});
			sandbox.nativeExec.mockResolvedValue({
				exitCode: 0,
				...incomplete,
				stdout: `${generation.generationId}\n${generation.token}\n`,
			});

			await expect(launcher.status("ready")).rejects.toThrow();
			expect(db.runs.at(-1)?.values).toContain("failed");
		},
	);

	it("touches warm heartbeat without executing a body proof read", async () => {
		const db = createMockD1();
		const sandbox = {
			nativeExec: vi.fn(async () => {
				throw new Error("proof read should not run for heartbeat");
			}),
		};
		namespaceMocks.getByName.mockReturnValue(sandbox);

		const launcher = new CloudflareSandboxWorkstationLauncher({
			bodyKind: "workstation",
			db: db as unknown as D1Database,
			namespace: { getByName: namespaceMocks.getByName } as never,
			proofEnvPath: "/home/tedi/workstation/.tedix-body-generation.env",
			record: { kind: "tedi", id: "tedi-warm", tediId: "tedi-warm" },
		});
		const generation = await launcher.arm({ requireToken: true });
		db.setFirstRow({
			bodyGenerationExternalId: "tedi-warm",
			bodyGenerationId: generation.generationId,
			bodyGenerationKind: "workstation",
			bodyGenerationStatus: "ready",
			bodyGenerationTokenExpiresAt: generation.tokenExpiresAt,
			bodyGenerationTokenHash: generation.tokenHash,
		});

		await expect(launcher.heartbeat()).resolves.toMatchObject({
			generationId: generation.generationId,
			trackingEnabled: true,
		});
		expect(sandbox.nativeExec).not.toHaveBeenCalled();
		expect(db.runs.at(-1)?.sql).toContain("body_generation_heartbeat_at");
		expect(db.runs.at(-1)?.sql).not.toContain("body_generation_status =");
	});

	it("rejects ready when the body presents the wrong generation token", async () => {
		const db = createMockD1();
		const sandbox = {
			nativeExec: vi.fn(),
		};
		namespaceMocks.getByName.mockReturnValue(sandbox);

		const launcher = new CloudflareSandboxWorkstationLauncher({
			bodyKind: "workstation",
			db: db as unknown as D1Database,
			namespace: { getByName: namespaceMocks.getByName } as never,
			proofEnvPath: "/home/tedi/workstation/.tedix-body-generation.env",
			record: { kind: "tedi", id: "tedi-4", tediId: "tedi-4" },
		});
		const generation = await launcher.arm({ requireToken: true });
		db.setFirstRow({
			bodyGenerationId: generation.generationId,
			bodyGenerationKind: "workstation",
			bodyGenerationStatus: "armed",
			bodyGenerationTokenExpiresAt: generation.tokenExpiresAt,
			bodyGenerationTokenHash: generation.tokenHash,
		});
		sandbox.nativeExec.mockResolvedValue({
			exitCode: 0,
			stdout: `${generation.generationId}\ntbg_wrong\n`,
		});

		await expect(launcher.status("ready")).rejects.toThrow(
			"Runtime body generation credential verification failed",
		);
		expect(db.runs.at(-1)?.values).toContain("failed");
	});

	it("falls back to legacy passthrough when generation columns are absent", async () => {
		const db = createMockD1({ throwMissingSchema: true });
		const launcher = new CloudflareSandboxWorkstationLauncher({
			bodyKind: "workstation",
			db: db as unknown as D1Database,
			namespace: { getByName: namespaceMocks.getByName } as never,
			proofEnvPath: "/home/tedi/workstation/.tedix-body-generation.env",
			record: { kind: "tedi", id: "tedi-5", tediId: "tedi-5" },
		});

		const generation = await launcher.arm({ requireToken: true });

		expect(generation.trackingEnabled).toBe(false);
		await expect(launcher.status("ready")).resolves.toMatchObject({
			status: "ready",
			trackingEnabled: false,
		});
	});

	it("verifies the armed generation token against the selected record", async () => {
		const db = createMockD1();
		const launcher = new CloudflareSandboxWorkstationLauncher({
			bodyKind: "workstation",
			db: db as unknown as D1Database,
			namespace: { getByName: namespaceMocks.getByName } as never,
			proofEnvPath: "/home/tedi/.tedix-body-generation.env",
			record: {
				kind: "workstationLease",
				id: "wl_coding_org_tedi_6",
				tediId: "tedi-6",
			},
		});
		const generation = await launcher.arm({ requireToken: true });
		db.setFirstRow({
			bodyGenerationId: generation.generationId,
			bodyGenerationStatus: "armed",
			bodyGenerationTokenExpiresAt: generation.tokenExpiresAt,
			bodyGenerationTokenHash: generation.tokenHash,
		});

		await expect(
			verifyArmedBodyGeneration(db as unknown as D1Database, {
				generationId: generation.generationId,
				record: {
					kind: "workstationLease",
					id: "wl_coding_org_tedi_6",
					tediId: "tedi-6",
				},
				token: generation.token,
			}),
		).resolves.toBe(true);
		await expect(
			verifyArmedBodyGeneration(db as unknown as D1Database, {
				generationId: generation.generationId,
				record: {
					kind: "workstationLease",
					id: "wl_coding_org_tedi_6",
					tediId: "tedi-6",
				},
				token: "tbg_wrong",
			}),
		).resolves.toBe(false);
	});
});
