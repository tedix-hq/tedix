import type { CmsSandbox as CmsSandbox } from "../sandbox";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	computeNodeModulesFingerprint,
	restoreNodeModulesBackup,
	saveNodeModulesBackup,
} from "./node-modules-backup";

const VALID_HASH = "a".repeat(64);

function fakeExecResult(overrides: { stdout?: string; exitCode?: number }) {
	const exitCode = overrides.exitCode ?? 0;
	return {
		success: exitCode === 0,
		exitCode,
		stdout: overrides.stdout ?? "",
		stderr: "",
		command: "",
	};
}

function fakeSandbox(options: {
	exec?: (...args: unknown[]) => unknown;
	restoreBackup?: ReturnType<typeof vi.fn>;
	createBackup?: ReturnType<typeof vi.fn>;
}) {
	return {
		exec: async (...args: unknown[]) => ({
			output: async () =>
				options.exec
					? options.exec(...args)
					: fakeExecResult({ stdout: `${VALID_HASH}\n` }),
		}),
		restoreBackup:
			options.restoreBackup ??
			vi.fn(async () => ({
				success: true,
				dir: "/workspace/node_modules",
				id: "b1",
			})),
		createBackup:
			options.createBackup ??
			vi.fn(async () => ({ id: "b1", dir: "/workspace/node_modules" })),
	} as unknown as CmsSandbox;
}

function fakeStorage(options: {
	get?: ReturnType<typeof vi.fn>;
	put?: ReturnType<typeof vi.fn>;
}) {
	return {
		get: options.get ?? vi.fn(async () => null),
		put: options.put ?? vi.fn(async () => {}),
	} as unknown as R2Bucket;
}

describe("computeNodeModulesFingerprint", () => {
	it("returns the sha256 hash on success", async () => {
		const sandbox = fakeSandbox({
			exec: vi.fn(async () => fakeExecResult({ stdout: `${VALID_HASH}\n` })),
		});
		expect(await computeNodeModulesFingerprint(sandbox)).toBe(VALID_HASH);
	});

	it("returns null on a non-zero exit code", async () => {
		const sandbox = fakeSandbox({
			exec: vi.fn(async () =>
				fakeExecResult({ stdout: VALID_HASH, exitCode: 1 }),
			),
		});
		expect(await computeNodeModulesFingerprint(sandbox)).toBeNull();
	});

	it("returns null on malformed output instead of throwing", async () => {
		const sandbox = fakeSandbox({
			exec: vi.fn(async () => fakeExecResult({ stdout: "not-a-hash\n" })),
		});
		expect(await computeNodeModulesFingerprint(sandbox)).toBeNull();
	});

	it("returns null instead of throwing when exec itself rejects", async () => {
		const sandbox = fakeSandbox({
			exec: vi.fn(async () => {
				throw new Error("container unavailable");
			}),
		});
		expect(await computeNodeModulesFingerprint(sandbox)).toBeNull();
	});
});

describe("restoreNodeModulesBackup", () => {
	it("restores a cached archive into the private attempt directory", async () => {
		const workspace =
			"/tmp/tedix-cms-deploy-11111111-1111-4111-8111-111111111111";
		const exec = vi.fn(async () =>
			fakeExecResult({ stdout: `${VALID_HASH}\n` }),
		);
		const restoreBackup = vi.fn(async () => ({
			success: true,
			dir: `${workspace}/node_modules`,
			id: "b1",
		}));
		const sandbox = fakeSandbox({ exec, restoreBackup });
		const storage = fakeStorage({
			get: vi.fn(async () => ({
				json: async () => ({ id: "b1", dir: "/workspace/node_modules" }),
			})),
		});
		expect(
			await restoreNodeModulesBackup(sandbox, storage, "tedix", workspace),
		).toEqual({ hit: true, fingerprint: VALID_HASH });
		expect(exec).toHaveBeenCalledWith([
			"bash",
			"-lc",
			expect.stringContaining(`${workspace}/bun.lock`),
		]);
		expect(restoreBackup).toHaveBeenCalledWith({
			id: "b1",
			dir: `${workspace}/node_modules`,
		});
	});

	it("reports a hit and restores when a matching backup exists", async () => {
		const restoreBackup = vi.fn(async () => ({
			success: true,
			dir: "/workspace/node_modules",
			id: "b1",
		}));
		const sandbox = fakeSandbox({
			exec: vi.fn(async () => fakeExecResult({ stdout: `${VALID_HASH}\n` })),
			restoreBackup,
		});
		const storage = fakeStorage({
			get: vi.fn(async () => ({
				json: async () => ({ id: "b1", dir: "/workspace/node_modules" }),
			})),
		});

		const result = await restoreNodeModulesBackup(sandbox, storage, "tedix");

		expect(result).toEqual({ hit: true, fingerprint: VALID_HASH });
		expect(restoreBackup).toHaveBeenCalledWith({
			id: "b1",
			dir: "/workspace/node_modules",
		});
	});

	it("reports a miss without restoring when no backup is recorded", async () => {
		const restoreBackup = vi.fn();
		const sandbox = fakeSandbox({
			exec: vi.fn(async () => fakeExecResult({ stdout: `${VALID_HASH}\n` })),
			restoreBackup,
		});
		const storage = fakeStorage({ get: vi.fn(async () => null) });

		const result = await restoreNodeModulesBackup(sandbox, storage, "tedix");

		expect(result.hit).toBe(false);
		expect(result.reason).toBe("no-backup-recorded");
		expect(restoreBackup).not.toHaveBeenCalled();
	});

	it("reports a miss without throwing when restoreBackup fails", async () => {
		const sandbox = fakeSandbox({
			exec: vi.fn(async () => fakeExecResult({ stdout: `${VALID_HASH}\n` })),
			restoreBackup: vi.fn(async () => {
				throw new Error("backup expired");
			}),
		});
		const storage = fakeStorage({
			get: vi.fn(async () => ({
				json: async () => ({ id: "b1", dir: "/workspace/node_modules" }),
			})),
		});

		const result = await restoreNodeModulesBackup(sandbox, storage, "tedix");

		expect(result.hit).toBe(false);
		expect(result.reason).toContain("backup expired");
	});

	it("reports a miss without throwing when restoreBackup resolves success: false", async () => {
		const sandbox = fakeSandbox({
			exec: vi.fn(async () => fakeExecResult({ stdout: `${VALID_HASH}\n` })),
			restoreBackup: vi.fn(async () => ({
				success: false,
				dir: "/workspace/node_modules",
				id: "b1",
			})),
		});
		const storage = fakeStorage({
			get: vi.fn(async () => ({
				json: async () => ({ id: "b1", dir: "/workspace/node_modules" }),
			})),
		});

		const result = await restoreNodeModulesBackup(sandbox, storage, "tedix");

		expect(result).toEqual({
			hit: false,
			fingerprint: VALID_HASH,
			reason: "restore-reported-failure",
		});
	});

	it("reports a miss without a fingerprint when hashing fails, and never calls R2", async () => {
		const sandbox = fakeSandbox({
			exec: vi.fn(async () => fakeExecResult({ stdout: "", exitCode: 1 })),
		});
		const get = vi.fn(async () => null);
		const storage = fakeStorage({ get });

		const result = await restoreNodeModulesBackup(sandbox, storage, "tedix");

		expect(result).toEqual({
			hit: false,
			fingerprint: null,
			reason: "fingerprint-unavailable",
		});
		expect(get).not.toHaveBeenCalled();
	});
});

describe("saveNodeModulesBackup", () => {
	it("backs up dependencies from the private attempt directory", async () => {
		const workspace =
			"/tmp/tedix-cms-deploy-11111111-1111-4111-8111-111111111111";
		const createBackup = vi.fn(async () => ({
			id: "b-private",
			dir: `${workspace}/node_modules`,
		}));
		const sandbox = fakeSandbox({ createBackup });
		const storage = fakeStorage({});
		expect(
			await saveNodeModulesBackup(
				sandbox,
				storage,
				"marketing",
				VALID_HASH,
				workspace,
			),
		).toBe(true);
		expect(createBackup).toHaveBeenCalledWith(
			expect.objectContaining({ dir: `${workspace}/node_modules` }),
		);
	});

	it("creates a backup and records it in R2, returning true", async () => {
		const createBackup = vi.fn(async () => ({
			id: "b2",
			dir: "/workspace/node_modules",
		}));
		const put = vi.fn(async () => {});
		const sandbox = fakeSandbox({ createBackup });
		const storage = fakeStorage({ put });

		const result = await saveNodeModulesBackup(
			sandbox,
			storage,
			"marketing",
			VALID_HASH,
		);

		expect(result).toBe(true);
		expect(createBackup).toHaveBeenCalledWith(
			expect.objectContaining({
				dir: "/workspace/node_modules",
				excludes: [".vite"],
			}),
		);
		expect(put).toHaveBeenCalledWith(
			`node-modules-backups/marketing/${VALID_HASH}.json`,
			JSON.stringify({
				id: "b2",
				dir: "/workspace/node_modules",
				localBucket: undefined,
			}),
		);
	});

	it("returns false instead of throwing when createBackup fails", async () => {
		const sandbox = fakeSandbox({
			createBackup: vi.fn(async () => {
				throw new Error("R2 unavailable");
			}),
		});
		const storage = fakeStorage({});

		const result = await saveNodeModulesBackup(
			sandbox,
			storage,
			"tedix",
			VALID_HASH,
		);

		expect(result).toBe(false);
	});

	it("returns false instead of throwing when the R2 write fails", async () => {
		const sandbox = fakeSandbox({});
		const storage = fakeStorage({
			put: vi.fn(async () => {
				throw new Error("R2 write failed");
			}),
		});

		const result = await saveNodeModulesBackup(
			sandbox,
			storage,
			"tedix",
			VALID_HASH,
		);

		expect(result).toBe(false);
	});
});
