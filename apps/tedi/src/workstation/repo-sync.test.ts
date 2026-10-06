import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import type { TediConfig } from "../types";
import type { WorkstationRuntimeBody } from "./computer-body";

vi.mock("@cloudflare/sandbox", () => ({
	ProcessWaitTimeoutError: class extends Error {},
}));
vi.mock("./computer-body", async (original) => ({
	...(await original<typeof import("./computer-body")>()),
	workstationExec: (body: any, command: string) => body.run(command),
	workstationExecutionStatus: (body: any, id: string) => body.status(id),
}));
vi.mock("./checkout-lock", () => ({
	startCheckoutOperation: async (body: any, input: any) => {
		await input.authorize();
		return body.start(input);
	},
}));
import { WorkstationDispatchUnknownError } from "./computer-body";
import {
	ensureCleanRepoTreeForTurn,
	readRepoSyncStatus,
	syncRepoIfConfigured,
} from "./repo-sync";

// Hooks export repository-local Git variables. Every fixture subprocess must
// drop Git's own local-variable inventory before working in a disposable repo.
const fixtureEnv = (() => {
	const variables = spawnSync("git", ["rev-parse", "--local-env-vars"], {
		encoding: "utf8",
	});
	if (variables.status !== 0)
		throw new Error("Cannot isolate fixture Git environment");
	const env = { ...process.env };
	for (const key of variables.stdout.trim().split("\n")) delete env[key];
	return env;
})();

const output = (command: string) => {
	const result = spawnSync("bash", ["-c", command], {
		env: fixtureEnv,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
		timeout: 30000,
	});
	if (result.error) throw result.error;
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout,
		stderr: result.stderr,
		truncated: false,
		timedOut: false,
	};
};
const git = (cwd: string, ...args: string[]) => {
	const r = spawnSync("git", ["-C", cwd, ...args], {
		env: fixtureEnv,
		encoding: "utf8",
		timeout: 30000,
	});
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
};
async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
	const f = setup();
	try {
		await run(f);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
}
function setup() {
	const root = mkdtempSync(join(tmpdir(), "repo-transaction-")),
		source = join(root, "source"),
		origin = join(root, "origin.git"),
		workdir = join(root, "repos", "team", "repo");
	mkdirSync(source);
	git(source, "init", "-b", "main");
	git(source, "config", "user.name", "Test");
	git(source, "config", "user.email", "test@example.com");
	writeFileSync(join(source, "tracked"), "base\n");
	writeFileSync(join(source, ".gitignore"), "node_modules/\n");
	git(source, "add", ".");
	git(source, "commit", "-m", "base");
	git(root, "clone", "--bare", source, origin);
	mkdirSync(join(root, "repos", "team"), { recursive: true });
	git(root, "clone", origin, workdir);
	const statuses = new Map<string, any>();
	const body = {
		run: vi.fn(async (command: string) => output(command)),
		status: vi.fn(
			async (id: string) =>
				statuses.get(id) ?? {
					found: false,
					terminal: false,
					running: false,
					exitCode: null,
				},
		),
		start: vi.fn(async (input: any) => {
			const id = input.executionId ?? "transaction";
			const result = output(input.command);
			statuses.set(id, {
				found: true,
				terminal: true,
				running: false,
				...result,
			});
			return {
				id,
				process: { id: "native-" + id, output: async () => result },
			};
		}),
	};
	const config = {
		id: "tedi-1",
		slug: "cto",
		organizationId: "org",
		repoConfig: {
			repoUrl: "file://" + origin,
			worktreePath: workdir,
			branch: "main",
		},
	} as TediConfig;
	const authorize = vi.fn(async () => {});
	const options = {
		reposRoot: join(root, "repos"),
		turnKey: "turn-1",
		authorize,
	};
	const native = body as unknown as WorkstationRuntimeBody;
	const preflight = () => ensureCleanRepoTreeForTurn(native, config, options);
	return {
		root,
		source,
		origin,
		workdir,
		body,
		native,
		config,
		authorize,
		options,
		preflight,
		statuses,
	};
}

describe("finite repository transaction", () => {
	it("keeps unsupported strategies and absent repositories inert", () =>
		fixture(async (f) => {
			expect(
				await syncRepoIfConfigured(
					f.native,
					{ ...f.config, repoConfig: null },
					{ repoStrategy: "clone" },
				),
			).toMatchObject({ configured: false, status: "not_configured" });
			expect(
				await syncRepoIfConfigured(f.native, f.config, {
					...f.options,
					repoStrategy: "artifact-fs",
				}),
			).toMatchObject({ configured: true, status: "unsupported_strategy" });
			expect(f.body.start).not.toHaveBeenCalled();
		}));
	it("observes shared then prepares and records the exact base exclusively", () =>
		fixture(async (f) => {
			const result = await f.preflight();
			expect(result).toMatchObject({
				authoritySource: "fresh_preparation",
				outcome: "clean",
				startSha: git(f.source, "rev-parse", "HEAD"),
			});
			expect(f.body.start.mock.calls.map(([input]) => input.mode)).toEqual([
				"shared",
				"exclusive",
			]);
			expect(f.authorize).toHaveBeenCalledTimes(2);
			expect(git(f.workdir, "config", "tedix.preparedStartSha")).toBe(
				result!.startSha,
			);
			expect(
				JSON.parse(readFileSync(f.workdir + ".tree-preflight.json", "utf8")),
			).not.toHaveProperty("authoritySource");
		}));
	it("preserves tracked and untracked dirty bytes in a rescue commit before resetting", () =>
		fixture(async (f) => {
			writeFileSync(join(f.workdir, "tracked"), "changed\n");
			writeFileSync(join(f.workdir, "untracked"), "new\n");
			const result = await f.preflight();
			expect(result?.outcome).toBe("quarantined");
			expect(git(f.workdir, "show", result!.rescueBranch + ":tracked")).toBe(
				"changed",
			);
			expect(git(f.workdir, "show", result!.rescueBranch + ":untracked")).toBe(
				"new",
			);
			expect(git(f.workdir, "status", "--porcelain")).toBe("");
		}));
	it("retains ignored dependencies", () =>
		fixture(async (f) => {
			mkdirSync(join(f.workdir, "node_modules"));
			writeFileSync(join(f.workdir, "node_modules", "cached"), "keep");
			await f.preflight();
			expect(
				readFileSync(join(f.workdir, "node_modules", "cached"), "utf8"),
			).toBe("keep");
		}));
	it("does not reset later work on repeated preparation of the same turn", () =>
		fixture(async (f) => {
			const first = await f.preflight();
			writeFileSync(join(f.workdir, "tracked"), "current turn work");
			expect(await f.preflight()).toEqual({
				...first,
				authoritySource: "observed_marker",
			});
			expect(readFileSync(join(f.workdir, "tracked"), "utf8")).toBe(
				"current turn work",
			);
		}));
	it("never adopts a forged freshness claim from the writable marker", () =>
		fixture(async (f) => {
			const first = await f.preflight();
			const markerPath = f.workdir + ".tree-preflight.json";
			writeFileSync(
				markerPath,
				JSON.stringify({ ...first, authoritySource: "fresh_preparation" }),
			);
			expect(await f.preflight()).toEqual({
				...first,
				authoritySource: "observed_marker",
			});
		}));
	it("quarantines the prior turn only when a different turn is admitted", () =>
		fixture(async (f) => {
			await f.preflight();
			writeFileSync(join(f.workdir, "tracked"), "prior turn");
			expect(
				await ensureCleanRepoTreeForTurn(f.native, f.config, {
					...f.options,
					turnKey: "turn-2",
				}),
			).toMatchObject({ outcome: "quarantined", turnKey: "turn-2" });
		}));
	it("claims refusal before mutation and never resets after quarantine commit failure", () =>
		fixture(async (f) => {
			writeFileSync(join(f.workdir, "tracked"), "must survive");
			git(f.workdir, "config", "commit.gpgsign", "true");
			git(f.workdir, "config", "gpg.program", "/nonexistent-gpg");
			const result = await f.preflight();
			expect(result?.outcome).toBe("refused");
			expect(readFileSync(join(f.workdir, "tracked"), "utf8")).toBe(
				"must survive",
			);
			expect(
				JSON.parse(readFileSync(f.workdir + ".tree-preflight.json", "utf8"))
					.outcome,
			).toBe("refused");
			expect(await f.preflight()).toEqual({
				...result,
				authoritySource: "observed_marker",
			});
		}));
	it("revokes a previous prepared SHA on failed preparation", () =>
		fixture(async (f) => {
			git(f.workdir, "config", "tedix.preparedStartSha", "a".repeat(40));
			git(f.workdir, "remote", "set-url", "origin", "/missing-origin");
			expect((await f.preflight())?.outcome).toBe("refused");
			expect(
				spawnSync(
					"git",
					["-C", f.workdir, "config", "--get", "tedix.preparedStartSha"],
					{ env: fixtureEnv },
				).status,
			).not.toBe(0);
		}));
	it("refuses malformed turn authority without changing dirty work", () =>
		fixture(async (f) => {
			writeFileSync(f.workdir + ".tree-preflight.json", "broken");
			writeFileSync(join(f.workdir, "tracked"), "keep");
			await expect(f.preflight()).rejects.toThrow();
			expect(readFileSync(join(f.workdir, "tracked"), "utf8")).toBe("keep");
		}));
	it("restores the persisted original base after replacement instead of adopting newer main", () =>
		fixture(async (f) => {
			const first = await f.preflight();
			writeFileSync(join(f.source, "tracked"), "new main");
			git(f.source, "commit", "-am", "new main");
			git(f.source, "push", f.origin, "main");
			rmSync(f.workdir, { recursive: true });
			rmSync(f.workdir + ".tree-preflight.json");
			git(f.root, "clone", f.origin, f.workdir);
			expect(
				await ensureCleanRepoTreeForTurn(f.native, f.config, {
					...f.options,
					originalPreflight: first!,
				}),
			).toEqual({ ...first, authoritySource: "restored_authority" });
			expect(git(f.workdir, "rev-parse", "HEAD")).toBe(first!.startSha);
		}));
	it("refuses restoration over dirty replacement bytes", () =>
		fixture(async (f) => {
			const first = await f.preflight();
			rmSync(f.workdir + ".tree-preflight.json");
			writeFileSync(join(f.workdir, "tracked"), "keep");
			await expect(
				ensureCleanRepoTreeForTurn(f.native, f.config, {
					...f.options,
					originalPreflight: first!,
				}),
			).rejects.toThrow("dirty");
			expect(readFileSync(join(f.workdir, "tracked"), "utf8")).toBe("keep");
		}));
	it("does not accept a local marker with a different original base", () =>
		fixture(async (f) => {
			const first = await f.preflight();
			await expect(
				ensureCleanRepoTreeForTurn(f.native, f.config, {
					...f.options,
					originalPreflight: { ...first!, startSha: "a".repeat(40) },
				}),
			).rejects.toThrow("does not match");
		}));
	it("installs committed hooks and marks the checkout during sync", () =>
		fixture(async (f) => {
			expect(
				await syncRepoIfConfigured(f.native, f.config, f.options),
			).toMatchObject({ status: "updated" });
			expect(git(f.workdir, "config", "core.hooksPath")).toBe(".githooks");
			expect(git(f.workdir, "config", "tedix.workstationCheckout")).toBe(
				"true",
			);
			expect(
				existsSync(join(f.workdir, ".git", "tedix-workstation-repo.json")),
			).toBe(true);
		}));
	it("claims a clone durably before its own native launch and finalizes only terminal success", () =>
		fixture(async (f) => {
			rmSync(f.workdir, { recursive: true });
			const result = await syncRepoIfConfigured(f.native, f.config, f.options);
			expect(result).toMatchObject({
				status: "syncing",
				executionState: "running",
			});
			const marker = JSON.parse(
				readFileSync(f.workdir + ".sync-process.json", "utf8"),
			);
			expect(f.body.start.mock.calls[1]![0].executionId).toBe(marker.processId);
			expect(
				await syncRepoIfConfigured(f.native, f.config, f.options),
			).toMatchObject({ status: "updated" });
			expect(existsSync(f.workdir + ".sync-process.json")).toBe(false);
		}));
	it.each([true, false])(
		"retained clone evidence may disappear only after finalization (finalize=%s)",
		(finalize) =>
			fixture(async (f) => {
				rmSync(f.workdir, { recursive: true });
				const started = await syncRepoIfConfigured(
					f.native,
					f.config,
					f.options,
				);
				expect(started).toMatchObject({ status: "syncing" });
				const marker = JSON.parse(
					readFileSync(f.workdir + ".sync-process.json", "utf8"),
				);
				const launches = f.body.start.mock.calls.length;
				expect(
					await readRepoSyncStatus(f.native, f.config, f.options),
				).toMatchObject({
					status: "syncing",
					executionId: marker.processId,
					executionState: "terminal",
				});
				expect(f.body.start).toHaveBeenCalledTimes(launches);
				expect(existsSync(f.workdir + ".sync-process.json")).toBe(true);
				if (finalize) {
					expect(
						await syncRepoIfConfigured(f.native, f.config, f.options),
					).toMatchObject({ status: "updated" });
					expect(existsSync(f.workdir + ".sync-process.json")).toBe(false);
					expect(git(f.workdir, "config", "tedix.preparedStartSha")).toBe(
						git(f.workdir, "rev-parse", "HEAD"),
					);
				}
				f.statuses.delete(marker.processId);
				const pending = {
					status: "syncing",
					executionId: marker.processId,
					executionState: "admitting",
				};
				expect(
					await readRepoSyncStatus(f.native, f.config, f.options),
				).toMatchObject(finalize ? { status: "updated" } : pending);
				if (!finalize) {
					expect(
						await syncRepoIfConfigured(f.native, f.config, f.options),
					).toMatchObject(pending);
					expect(f.body.start).toHaveBeenCalledTimes(launches);
					expect(existsSync(f.workdir + ".sync-process.json")).toBe(true);
				}
			}),
	);
	it("preserves occupied non-Git files in a unique orphan directory", () =>
		fixture(async (f) => {
			rmSync(f.workdir, { recursive: true });
			mkdirSync(f.workdir);
			writeFileSync(join(f.workdir, "unknown"), "keep");
			const result = await syncRepoIfConfigured(f.native, f.config, f.options);
			expect(result.configured && result.orphanedPath).toBeTruthy();
			expect(
				readFileSync(join((result as any).orphanedPath, "unknown"), "utf8"),
			).toBe("keep");
		}));
	it.each(["admitting", "running"])(
		"never replays %s clone even if a partial .git exists",
		(state) =>
			fixture(async (f) => {
				const marker = {
					processId: "retained-clone",
					branch: "main",
					repoUrl: f.config.repoConfig!.repoUrl,
					startedAt: "2020-01-01T00:00:00Z",
				};
				writeFileSync(f.workdir + ".sync-process.json", JSON.stringify(marker));
				if (state === "running")
					f.statuses.set(marker.processId, {
						found: true,
						running: true,
						terminal: false,
					});
				expect(
					await syncRepoIfConfigured(f.native, f.config, f.options),
				).toMatchObject({
					status: "syncing",
					executionId: marker.processId,
					executionState: state,
				});
				expect(f.body.start).not.toHaveBeenCalled();
				expect(existsSync(f.workdir + ".sync-process.json")).toBe(true);
			}),
	);
	it("retains failed clone identity and reports terminal error", () =>
		fixture(async (f) => {
			const marker = {
				processId: "failed-clone",
				branch: "main",
				repoUrl: f.config.repoConfig!.repoUrl,
				startedAt: new Date().toISOString(),
			};
			writeFileSync(f.workdir + ".sync-process.json", JSON.stringify(marker));
			f.statuses.set(marker.processId, {
				found: true,
				running: false,
				terminal: true,
				exitCode: 1,
				stderr: "credentials unavailable",
			});
			expect(
				await syncRepoIfConfigured(f.native, f.config, f.options),
			).toMatchObject({ status: "failed", executionId: marker.processId });
			expect(f.body.start).not.toHaveBeenCalled();
			expect(existsSync(f.workdir + ".sync-process.json")).toBe(true);
		}));
	it("does not clear or kill a mismatched retained clone during status reads", () =>
		fixture(async (f) => {
			writeFileSync(
				f.workdir + ".sync-process.json",
				JSON.stringify({
					processId: "other",
					branch: "other",
					repoUrl: "other",
					startedAt: "old",
				}),
			);
			expect(
				await readRepoSyncStatus(f.native, f.config, f.options),
			).toMatchObject({ status: "failed" });
			expect(f.body.start).not.toHaveBeenCalled();
			expect(existsSync(f.workdir + ".sync-process.json")).toBe(true);
		}));
	it("refuses an unreadable clone claim without launch", () =>
		fixture(async (f) => {
			writeFileSync(f.workdir + ".sync-process.json", "invalid");
			expect(
				await syncRepoIfConfigured(f.native, f.config, f.options),
			).toMatchObject({ status: "failed" });
			expect(f.body.start).not.toHaveBeenCalled();
		}));
	it("keeps clone identity on a lost native launch response", () =>
		fixture(async (f) => {
			rmSync(f.workdir, { recursive: true });
			const start = f.body.start.getMockImplementation()!;
			f.body.start.mockImplementation(async (input: any) => {
				if (input.executionId)
					throw new WorkstationDispatchUnknownError(input.executionId);
				return start(input);
			});
			const result = await syncRepoIfConfigured(f.native, f.config, f.options);
			expect(result).toMatchObject({
				status: "syncing",
				executionState: "admitting",
			});
			expect(
				await syncRepoIfConfigured(f.native, f.config, f.options),
			).toMatchObject({
				status: "syncing",
				executionId: (result as any).executionId,
			});
			expect(f.body.start).toHaveBeenCalledTimes(2);
		}));
	it("rechecks clone identity inside the decision transaction", () =>
		fixture(async (f) => {
			const start = f.body.start.getMockImplementation()!;
			f.body.start.mockImplementation(async (input: any) => {
				writeFileSync(
					f.workdir + ".sync-process.json",
					JSON.stringify({
						processId: "concurrent",
						branch: "main",
						repoUrl: f.config.repoConfig!.repoUrl,
						startedAt: "now",
					}),
				);
				return start(input);
			});
			expect(
				await syncRepoIfConfigured(f.native, f.config, f.options),
			).toMatchObject({ status: "syncing", executionId: "concurrent" });
			expect(f.body.start).toHaveBeenCalledTimes(1);
		}));
	it("reuses current native same-turn evidence under shared lock with changed HEAD and dirty work", () =>
		fixture(async (f) => {
			const first = await f.preflight();
			git(f.workdir, "config", "user.name", "Test");
			git(f.workdir, "config", "user.email", "test@example.invalid");
			writeFileSync(join(f.workdir, "tracked"), "committed turn work");
			git(f.workdir, "commit", "-am", "turn commit");
			writeFileSync(join(f.workdir, "dirty"), "uncommitted turn work");
			f.body.start.mockClear();
			expect(
				await ensureCleanRepoTreeForTurn(f.native, f.config, {
					...f.options,
					originalPreflight: first!,
				}),
			).toEqual({ ...first, authoritySource: "observed_marker" });
			expect(f.body.start.mock.calls.map(([input]) => input.mode)).toEqual([
				"shared",
			]);
			expect(git(f.workdir, "rev-parse", "HEAD")).not.toBe(first!.startSha);
			expect(readFileSync(join(f.workdir, "dirty"), "utf8")).toBe(
				"uncommitted turn work",
			);
		}));
	it("refuses a native prepared-base mismatch without exclusive mutation", () =>
		fixture(async (f) => {
			await f.preflight();
			git(f.workdir, "config", "tedix.preparedStartSha", "a".repeat(40));
			f.body.start.mockClear();
			await expect(f.preflight()).rejects.toThrow("prepared base");
			expect(f.body.start.mock.calls.map(([input]) => input.mode)).toEqual([
				"shared",
			]);
		}));
	it("rechecks a concurrent refused claim after releasing shared observation", () =>
		fixture(async (f) => {
			const start = f.body.start.getMockImplementation()!;
			let observed = false;
			const claim = {
				at: new Date().toISOString(),
				branch: "main",
				workdir: f.workdir,
				turnKey: f.options.turnKey,
				outcome: "refused",
				reason: "another preflight did not finish",
			};
			f.body.start.mockImplementation(async (input) => {
				if (input.mode === "exclusive") {
					expect(observed).toBe(true);
					writeFileSync(
						f.workdir + ".tree-preflight.json",
						JSON.stringify(claim),
					);
				}
				const result = await start(input);
				if (input.mode === "shared") observed = true;
				return result;
			});
			writeFileSync(join(f.workdir, "tracked"), "must survive");
			expect(await f.preflight()).toEqual({
				...claim,
				authoritySource: "observed_marker",
			});
			expect(readFileSync(join(f.workdir, "tracked"), "utf8")).toBe(
				"must survive",
			);
		}));

	it("treats a missing native checkout with surviving marker as a shared miss, never ready", () =>
		fixture(async (f) => {
			const original = await f.preflight();
			rmSync(f.workdir, { recursive: true });
			f.body.start.mockClear();
			await expect(
				ensureCleanRepoTreeForTurn(f.native, f.config, {
					...f.options,
					originalPreflight: original!,
				}),
			).rejects.toThrow();
			expect(f.body.start.mock.calls.map(([input]) => input.mode)).toEqual([
				"shared",
				"exclusive",
			]);
		}));

	it("restores persisted original base in a fresh clone with surviving marker but missing prepared config", () =>
		fixture(async (f) => {
			const original = await f.preflight();
			writeFileSync(join(f.source, "tracked"), "newer main");
			git(f.source, "commit", "-am", "new main");
			git(f.source, "push", f.origin, "main");
			rmSync(f.workdir, { recursive: true });
			git(f.root, "clone", f.origin, f.workdir);
			f.body.start.mockClear();
			expect(
				await ensureCleanRepoTreeForTurn(f.native, f.config, {
					...f.options,
					originalPreflight: original!,
				}),
			).toEqual({ ...original, authoritySource: "restored_authority" });
			expect(f.body.start.mock.calls.map(([input]) => input.mode)).toEqual([
				"shared",
				"exclusive",
			]);
			expect(git(f.workdir, "rev-parse", "HEAD")).toBe(original!.startSha);
		}));
});
