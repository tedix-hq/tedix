import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { detachedGitEnv } from "../../../scripts/oss/git-env";
import {
	compactRegenerableDirs,
	diskUsage,
	measureStorage,
	readRetentionConfig,
	RETENTION_DEFAULTS,
	rotateLogFile,
	runRetention,
	tedixConfigDir,
} from "./lane-retention";

/**
 * MUST spawn git with {@link detachedGitEnv}: the pre-push hook runs suites
 * with `GIT_DIR` pointing at the real repository, and a child git that
 * inherits it ignores its own `cwd`.
 */
function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: detachedGitEnv(),
	}).trim();
}

const fixtureDirectories: string[] = [];
afterAll(() => {
	for (const path of fixtureDirectories)
		rmSync(path, { recursive: true, force: true });
});

const ITEM = "11111111-2222-4333-8444-555555555555";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

interface Fixture {
	base: string;
	configDir: string;
	dispatcherDir: string;
	source: string;
	runsDir: string;
}

/** A dispatcher directory with one settled run whose checkout is a worktree. */
function fixture(options: { settled?: boolean } = {}): Fixture {
	const base = mkdtempSync(join(tmpdir(), "tedix-retention-test-"));
	fixtureDirectories.push(base);
	const configDir = join(base, ".tedix");
	const dispatcherDir = join(configDir, "dispatchers", "runner-key");
	const runsDir = join(dispatcherDir, "runs");
	const runDir = join(runsDir, `${ITEM}-1`);
	const repo = join(runDir, "repo");
	const source = join(base, "source");
	const remote = join(base, "remote.git");
	mkdirSync(runsDir, { recursive: true });
	mkdirSync(dispatcherDir, { recursive: true });
	git(base, ["init", "--bare", remote]);
	git(base, ["init", "-b", "main", source]);
	git(source, ["config", "user.name", "Tedix Test"]);
	git(source, ["config", "user.email", "test@tedix.dev"]);
	writeFileSync(join(source, ".gitignore"), "node_modules/\ndist/\n");
	writeFileSync(join(source, "README.md"), "fixture\n");
	git(source, ["add", "."]);
	git(source, ["commit", "-m", "fixture"]);
	git(source, ["remote", "add", "origin", remote]);
	git(source, ["push", "-u", "origin", "main"]);
	git(source, ["worktree", "add", repo, "-b", "lane/test"]);
	const phase = options.settled === false ? "running" : "settled";
	writeFileSync(
		join(dispatcherDir, `${ITEM}-1.json`),
		JSON.stringify({ phase, repo }),
	);
	return { base, configDir, dispatcherDir, source, runsDir };
}

function envOf(f: Fixture): NodeJS.ProcessEnv {
	return { TEDIX_CONFIG_DIR: f.configDir };
}

describe("rotateLogFile", () => {
	test("rotates past the cap, keeps the newest generations, drops the oldest", () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-log-"));
		fixtureDirectories.push(dir);
		const log = join(dir, "lane.log");
		writeFileSync(log, "small");
		expect(rotateLogFile(log, 10, 3)).toEqual({
			rotated: false,
			freed: 0,
		});
		writeFileSync(log, "x".repeat(100));
		for (let i = 0; i < 5; i++) {
			writeFileSync(log, "y".repeat(100));
			rotateLogFile(log, 10, 3);
		}
		expect(existsSync(`${log}.1`)).toBe(true);
		expect(existsSync(`${log}.3`)).toBe(true);
		expect(existsSync(`${log}.4`)).toBe(false);
		expect(readFileSync(`${log}.1`, "utf8")).toBe("y".repeat(100));
	});
});

describe("readRetentionConfig", () => {
	test("defaults apply without a file and overrides parse", () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-retention-config-"));
		fixtureDirectories.push(dir);
		expect(readRetentionConfig({}, dir)).toEqual(RETENTION_DEFAULTS);
		writeFileSync(
			join(dir, "retention.json"),
			JSON.stringify({
				compactAfterHours: 2,
				expireAfterDays: 1,
				idleDays: 9,
				restoreKeepDays: 30,
				logMaxMB: 5,
				logKeepFiles: 4,
				archiveDays: 7,
			}),
		);
		const config = readRetentionConfig({}, dir);
		expect(config.compactAfterMs).toBe(2 * HOUR);
		expect(config.expireAfterMs).toBe(DAY);
		expect(config.idleMs).toBe(9 * DAY);
		expect(config.restoreKeepMs).toBe(30 * DAY);
		expect(config.logMaxBytes).toBe(5 * 1024 * 1024);
		expect(config.logKeepFiles).toBe(4);
		expect(config.archiveMaxAgeMs).toBe(7 * DAY);
		writeFileSync(join(dir, "retention.json"), "{not json");
		expect(readRetentionConfig({}, dir)).toEqual(RETENTION_DEFAULTS);
	});
});

describe("diskUsage", () => {
	test("counts allocated blocks and deduplicates hardlinks", () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-disk-"));
		fixtureDirectories.push(dir);
		const file = join(dir, "payload.bin");
		writeFileSync(file, Buffer.alloc(256 * 1024, 7));
		linkSync(file, join(dir, "payload-link.bin"));
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "small.txt"), "hi");
		const usage = diskUsage(dir);
		const single = statSync(file).blocks! * 512;
		// Both names share one inode's blocks; dirs and small.txt add their own.
		expect(usage.bytes).toBeGreaterThan(single);
		expect(usage.bytes).toBeLessThan(single * 2);
		expect(usage.files).toBe(3);
		expect(usage.dirs).toBe(1);
	});

	test("an APFS clone family counts once, like the blocks it really uses", () => {
		if (process.platform !== "darwin") return;
		const dir = mkdtempSync(join(tmpdir(), "tedix-clone-"));
		fixtureDirectories.push(dir);
		const a = join(dir, "a.bin");
		const b = join(dir, "b.bin");
		writeFileSync(a, Buffer.alloc(1024 * 1024, 1));
		try {
			execFileSync("cp", ["-c", a, b]);
		} catch {
			// Volume without clonefile support: nothing to deduplicate.
			return;
		}
		const usage = diskUsage(dir);
		// `du` would report both names in full; real use is one copy.
		expect(usage.bytes).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);
		expect(usage.files).toBe(2);
	});

	test("measureStorage reports one row per top-level entry", () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-storage-"));
		fixtureDirectories.push(dir);
		mkdirSync(join(dir, "dispatchers"));
		writeFileSync(join(dir, "dispatchers", "a.log"), "log");
		writeFileSync(join(dir, "supervisor.log"), "sup");
		const { areas, total } = measureStorage(dir);
		expect(areas.map((area) => area.name).sort()).toEqual([
			"dispatchers",
			"supervisor.log",
		]);
		expect(total.files).toBe(2);
		expect(total.bytes).toBeGreaterThan(0);
	});
});

describe("runRetention compaction", () => {
	test("a settled run loses ignored regenerable folders an hour after quiet", async () => {
		const f = fixture();
		const repo = join(f.runsDir, `${ITEM}-1`, "repo");
		mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "x");
		mkdirSync(join(repo, "dist"));
		writeFileSync(join(repo, "dist", "out.js"), "x");
		mkdirSync(join(repo, "app", "node_modules"), { recursive: true });
		writeFileSync(join(repo, "app", "node_modules", "n.js"), "x");
		// Not ignored: must survive even though the name is regenerable.
		mkdirSync(join(repo, "build"));
		writeFileSync(join(repo, "build", "artifact"), "x");
		const report = await runRetention({
			env: envOf(f),
			now: Date.now() + 2 * HOUR,
		});
		expect(report.compactedDirs).toBe(3);
		expect(existsSync(join(repo, "node_modules"))).toBe(false);
		expect(existsSync(join(repo, "dist"))).toBe(false);
		expect(existsSync(join(repo, "app", "node_modules"))).toBe(false);
		expect(existsSync(join(repo, "build", "artifact"))).toBe(true);
		expect(existsSync(join(f.runsDir, `${ITEM}-1`))).toBe(true);
	});

	test("a live Attempt keeps its run folder and regenerable dirs", async () => {
		const f = fixture({ settled: false });
		const repo = join(f.runsDir, `${ITEM}-1`, "repo");
		mkdirSync(join(repo, "node_modules"));
		writeFileSync(join(repo, "node_modules", "x"), "x");
		// A detached child leads its own process group, so kill(-pid, 0) sees it.
		const child = spawn("sleep", ["30"], { detached: true });
		try {
			writeFileSync(
				join(f.dispatcherDir, `${ITEM}-1.json`),
				JSON.stringify({ phase: "running", pid: child.pid, repo }),
			);
			const report = await runRetention({
				env: envOf(f),
				now: Date.now() + 10 * DAY,
			});
			expect(report.compactedDirs).toBe(0);
			expect(report.expiredRuns).toBe(0);
			expect(existsSync(join(repo, "node_modules", "x"))).toBe(true);
		} finally {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
				child.kill("SIGKILL");
			}
		}
	});

	test("compactRegenerableDirs renames through trash before deleting", async () => {
		const f = fixture();
		const runDir = join(f.runsDir, `${ITEM}-1`);
		const repo = join(runDir, "repo");
		mkdirSync(join(repo, "node_modules"));
		writeFileSync(join(repo, "node_modules", "x"), "x");
		const result = await compactRegenerableDirs(repo, runDir);
		expect(result.dirs).toBe(1);
		expect(existsSync(join(repo, "node_modules"))).toBe(false);
		expect(existsSync(join(runDir, ".compact-trash"))).toBe(false);
	});
});

describe("runRetention expiry", () => {
	test("a settled run expires after 3 days and keeps unpushed work as a restore point", async () => {
		const f = fixture();
		const runDir = join(f.runsDir, `${ITEM}-1`);
		const repo = join(runDir, "repo");
		writeFileSync(join(repo, "unpushed.txt"), "keep me");
		git(repo, ["add", "unpushed.txt"]);
		git(repo, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-m",
			"unpushed work",
		]);
		mkdirSync(join(runDir, "task"));
		writeFileSync(join(runDir, "task", "notes.txt"), "task data");
		// cleanupLaneWorktree only evicts a checkout idle for an hour.
		const old = new Date(Date.now() - 2 * HOUR);
		utimesSync(repo, old, old);
		const report = await runRetention({
			env: envOf(f),
			now: Date.now() + 4 * DAY,
			// The sandboxed test host cannot spawn `ps`; the kernel cwd probe
			// in pathInUse still guards the run folder itself.
			inUseCheckout: async () => false,
		});
		expect(report.expiredRuns).toBe(1);
		expect(existsSync(runDir)).toBe(false);
		const points = join(f.configDir, "restore-points");
		const names = execFileSync("ls", [points], { encoding: "utf8" })
			.trim()
			.split("\n");
		expect(names.some((name) => name.endsWith(".bundle"))).toBe(true);
		expect(names.some((name) => name.endsWith(".json"))).toBe(true);
		expect(names.some((name) => name.endsWith("-task"))).toBe(true);
		// The bundle carries the unpushed commit.
		const bundle = names.find((name) => name.endsWith(".bundle"))!;
		const verified = execFileSync(
			"git",
			["bundle", "verify", join(points, bundle)],
			{ encoding: "utf8", env: detachedGitEnv() },
		);
		expect(verified).toContain("The bundle contains this ref");
	});

	test("a live process inside the run folder protects it from expiry", async () => {
		const f = fixture();
		const runDir = join(f.runsDir, `${ITEM}-1`);
		const child = spawn("sleep", ["30"], { cwd: runDir });
		try {
			await new Promise((resolve) => setTimeout(resolve, 300));
			const report = await runRetention({
				env: envOf(f),
				now: Date.now() + 10 * DAY,
			});
			expect(report.expiredRuns).toBe(0);
			expect(existsSync(runDir)).toBe(true);
			expect(report.protectedRuns.length).toBeGreaterThan(0);
		} finally {
			child.kill();
		}
	});

	test("an idle run folder with no receipt expires after 7 days", async () => {
		const f = fixture({ settled: false });
		rmSync(join(f.dispatcherDir, `${ITEM}-1.json`));
		const report = await runRetention({
			env: envOf(f),
			now: Date.now() + 8 * DAY,
			inUseCheckout: async () => false,
		});
		expect(report.expiredRuns).toBe(1);
		expect(existsSync(join(f.runsDir, `${ITEM}-1`))).toBe(false);
	});

	test("a .expired- leftover from a killed pass is deleted", async () => {
		const f = fixture();
		const leftover = join(f.runsDir, `${ITEM}-1.expired-1700000000000`);
		mkdirSync(leftover, { recursive: true });
		writeFileSync(join(leftover, "junk"), "x");
		const report = await runRetention({ env: envOf(f) });
		expect(report.expiredBytes).toBeGreaterThan(0);
		expect(existsSync(leftover)).toBe(false);
	});
});

describe("runRetention logs and archives", () => {
	test("per-lane turn logs rotate at the configured cap for quiet runs", async () => {
		const f = fixture({ settled: false });
		// Keep this run fresh so neither compaction nor expiry touches it.
		rmSync(join(f.dispatcherDir, `${ITEM}-1.json`));
		writeFileSync(
			join(f.configDir, "retention.json"),
			JSON.stringify({ logMaxMB: 0.001, logKeepFiles: 3 }),
		);
		const attemptDir = join(
			f.runsDir,
			`${ITEM}-1`,
			"22222222-3333-4444-8555-666666666666",
		);
		mkdirSync(attemptDir, { recursive: true });
		writeFileSync(join(attemptDir, "stdout-0.log"), "x".repeat(4096));
		const report = await runRetention({ env: envOf(f) });
		expect(report.rotatedFiles).toBe(1);
		expect(existsSync(join(attemptDir, "stdout-0.log.1"))).toBe(true);
	});

	test("archives older than the window are deleted, recent ones kept", async () => {
		const f = fixture();
		const archive = join(f.dispatcherDir, "archive");
		mkdirSync(archive, { recursive: true });
		const oldName = `old-run-${Date.now() - 20 * DAY}`;
		const newName = `new-run-${Date.now()}`;
		mkdirSync(join(archive, oldName));
		writeFileSync(join(archive, oldName, "f"), "x");
		mkdirSync(join(archive, newName));
		writeFileSync(join(archive, newName, "f"), "x");
		const report = await runRetention({ env: envOf(f) });
		expect(report.archivesDeleted).toBe(1);
		expect(existsSync(join(archive, oldName))).toBe(false);
		expect(existsSync(join(archive, newName))).toBe(true);
	});
});

describe("tedixConfigDir", () => {
	test("honors TEDIX_CONFIG_DIR", () => {
		expect(tedixConfigDir({ TEDIX_CONFIG_DIR: "/tmp/x" })).toBe("/tmp/x");
	});
});
