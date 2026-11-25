import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	copyFileSync,
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { kernelProcessCwd, kernelProcessTable } from "./process-facts";
import { unpushedLaneCommits } from "./lane-unpushed";
import { detachedGitEnv } from "../../../scripts/oss/git-env";

/**
 * Automatic cleanup of what runners leave under `~/.tedix`: regenerable
 * folders inside settled run worktrees are compacted an hour after a run
 * goes quiet, whole run folders expire three days after settling or seven
 * days idle (unpushed commits first land in a restore point kept 90 days),
 * and per-lane, runner and supervisor logs rotate at a size cap. `tedix
 * storage` reports real disk use — allocated blocks with APFS clone families
 * and hardlink families counted once, so `du`-style totals that count every
 * clone in full are not repeated. Every threshold lives in
 * `~/.tedix/retention.json`.
 */

export const REGENERABLE_DIRECTORIES: ReadonlySet<string> = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".turbo",
	".vite",
	".cache",
	"target",
]);

export interface RetentionConfig {
	/** Settled run worktrees lose regenerable folders after this long quiet. */
	compactAfterMs: number;
	/** A settled run folder is removed after this long. */
	expireAfterMs: number;
	/** Any run folder with no activity for this long is removed. */
	idleMs: number;
	/** Restore points under `~/.tedix/restore-points` are kept this long. */
	restoreKeepMs: number;
	/** Log files rotate past this size. */
	logMaxBytes: number;
	/** Rotated generations kept per log (`name.log`, `name.log.1` …). */
	logKeepFiles: number;
	/** Archived run folders are deleted after this long. */
	archiveMaxAgeMs: number;
}

export const RETENTION_DEFAULTS: RetentionConfig = {
	compactAfterMs: 60 * 60_000,
	expireAfterMs: 3 * 24 * 60 * 60_000,
	idleMs: 7 * 24 * 60 * 60_000,
	restoreKeepMs: 90 * 24 * 60 * 60_000,
	logMaxBytes: 10 * 1024 * 1024,
	logKeepFiles: 10,
	archiveMaxAgeMs: 14 * 24 * 60 * 60_000,
};

const CONFIG_FILE = "retention.json";

export function tedixConfigDir(env: NodeJS.ProcessEnv): string {
	return env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix");
}

/**
 * `~/.tedix/retention.json` overrides any subset of the defaults. Hours and
 * days are the units a person edits; every value must be positive.
 */
export function readRetentionConfig(
	env: NodeJS.ProcessEnv,
	configDir = tedixConfigDir(env),
): RetentionConfig {
	const config = { ...RETENTION_DEFAULTS };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(configDir, CONFIG_FILE), "utf8"));
	} catch {
		return config;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return config;
	const file = raw as Record<string, unknown>;
	const positive = (key: string) => {
		const value = file[key];
		return typeof value === "number" && Number.isFinite(value) && value > 0
			? value
			: undefined;
	};
	const compact = positive("compactAfterHours");
	if (compact !== undefined) config.compactAfterMs = compact * 60 * 60_000;
	const expire = positive("expireAfterDays");
	if (expire !== undefined) config.expireAfterMs = expire * 24 * 60 * 60_000;
	const idle = positive("idleDays");
	if (idle !== undefined) config.idleMs = idle * 24 * 60 * 60_000;
	const restore = positive("restoreKeepDays");
	if (restore !== undefined) config.restoreKeepMs = restore * 24 * 60 * 60_000;
	const archive = positive("archiveDays");
	if (archive !== undefined)
		config.archiveMaxAgeMs = archive * 24 * 60 * 60_000;
	const logMax = positive("logMaxMB");
	if (logMax !== undefined) config.logMaxBytes = logMax * 1024 * 1024;
	const keep = file.logKeepFiles;
	if (typeof keep === "number" && Number.isInteger(keep) && keep >= 1)
		config.logKeepFiles = keep;
	return config;
}

/* Real disk use: allocated blocks, deduplicated per clone/hardlink family. */

export interface DiskUsage {
	bytes: number;
	files: number;
	dirs: number;
}

interface DarwinCloneLib {
	getattrlist(
		path: number,
		attrList: number,
		attrBuf: number,
		attrBufSize: bigint,
		options: bigint,
	): number;
}

let darwinClone: DarwinCloneLib | null | undefined;

function darwinGetattrlist(): DarwinCloneLib | undefined {
	if (process.platform !== "darwin") return;
	if (darwinClone === undefined) {
		try {
			darwinClone = dlopen("libSystem.B.dylib", {
				getattrlist: {
					args: [
						FFIType.ptr,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.u64,
						FFIType.u64,
					],
					returns: FFIType.i32,
				},
			}).symbols as unknown as DarwinCloneLib;
		} catch {
			darwinClone = null;
		}
	}
	return darwinClone ?? undefined;
}

const ATTR_BITMAP_COUNT = 5;
const ATTR_CMN_RETURNED_ATTRS = 0x8000_0000;
const ATTR_CMNEXT_CLONEID = 0x100;
const FSOPT_NOFOLLOW = 1;
const FSOPT_PACK_INVAL_ATTRS = 8;
const FSOPT_ATTR_CMN_EXTENDED = 0x20;

/**
 * The APFS clone id of a path via `getattrlist(2)`, or undefined off macOS,
 * for directories, and when the volume does not report one. Clone family
 * members share the id, which is how `du`-style totals get corrected: a
 * family's blocks count once, at its first member in scan order.
 */
export function apfsCloneId(path: string): bigint | undefined {
	const lib = darwinGetattrlist();
	if (!lib) return;
	const name = Buffer.from(`${path}\0`, "utf8");
	const attrList = new Uint8Array(24);
	const view = new DataView(attrList.buffer);
	view.setUint16(0, ATTR_BITMAP_COUNT, true);
	view.setUint32(4, ATTR_CMN_RETURNED_ATTRS, true);
	view.setUint32(20, ATTR_CMNEXT_CLONEID, true);
	const out = new Uint8Array(64);
	const result = lib.getattrlist(
		ptr(name),
		ptr(attrList),
		ptr(out),
		64n,
		BigInt(FSOPT_NOFOLLOW | FSOPT_PACK_INVAL_ATTRS | FSOPT_ATTR_CMN_EXTENDED),
	);
	if (result !== 0) return;
	const outView = new DataView(out.buffer);
	if (outView.getUint32(0, true) < 32) return;
	if ((outView.getUint32(20, true) & ATTR_CMNEXT_CLONEID) === 0) return;
	const id = outView.getBigUint64(24, true);
	return id === 0n ? undefined : id;
}

function entryBytes(
	path: string,
	stat: {
		blocks?: number;
		dev: number;
		ino: number;
		nlink?: number;
	},
	seen: Set<string>,
): number {
	const blocks = Number(stat.blocks ?? 0) * 512;
	if (!blocks) return 0;
	const clone = apfsCloneId(path);
	if (clone !== undefined) {
		const key = `clone:${clone}`;
		if (seen.has(key)) return 0;
		seen.add(key);
		return blocks;
	}
	if ((stat.nlink ?? 1) > 1) {
		const key = `ino:${stat.dev}:${stat.ino}`;
		if (seen.has(key)) return 0;
		seen.add(key);
	}
	return blocks;
}

/**
 * Allocated bytes under `root`, counting each APFS clone family and each
 * multiply-linked inode once. `seen` may be shared across calls so families
 * spanning several roots count once; the default fresh set measures `root`
 * independently.
 */
export function diskUsage(
	root: string,
	seen: Set<string> = new Set(),
): DiskUsage {
	const usage: DiskUsage = { bytes: 0, files: 0, dirs: 0 };
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			let stat;
			try {
				stat = lstatSync(path);
			} catch {
				continue;
			}
			usage.bytes += entryBytes(path, stat, seen);
			if (entry.isDirectory()) {
				usage.dirs++;
				stack.push(path);
			} else {
				usage.files++;
			}
		}
	}
	return usage;
}

export interface StorageArea {
	name: string;
	bytes: number;
	files: number;
	dirs: number;
}

/**
 * What `~/.tedix` uses on disk, one row per top-level entry, measured in a
 * single pass so clone families spanning areas count once (at the first area
 * the walk reaches). Loose files group under their own name.
 */
export function measureStorage(root: string): {
	areas: StorageArea[];
	total: DiskUsage;
} {
	const areas = new Map<string, DiskUsage>();
	const seen = new Set<string>();
	const total: DiskUsage = { bytes: 0, files: 0, dirs: 0 };
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return { areas: [], total };
	}
	for (const entry of entries) {
		const path = join(root, entry.name);
		const usage = diskUsage(path, seen);
		// diskUsage counts a directory's children, not the directory itself.
		try {
			usage.bytes += entryBytes(path, lstatSync(path), seen);
			if (entry.isDirectory()) usage.dirs++;
			else usage.files++;
		} catch {}
		const row = areas.get(entry.name) ?? { bytes: 0, files: 0, dirs: 0 };
		row.bytes += usage.bytes;
		row.files += usage.files;
		row.dirs += usage.dirs;
		areas.set(entry.name, row);
		total.bytes += usage.bytes;
		total.files += usage.files;
		total.dirs += usage.dirs;
	}
	return {
		areas: [...areas.entries()]
			.map(([name, usage]) => ({ name, ...usage }))
			.sort((a, b) => b.bytes - a.bytes),
		total,
	};
}

/* Log rotation */

export interface Rotation {
	rotated: boolean;
	/** Bytes the dropped oldest generation freed. */
	freed: number;
}

/**
 * Rotates `path` when it exceeds `maxBytes`: `path.1` is the newest backup
 * and `path.<keepFiles>` the oldest, which is deleted. Writers that reopen
 * the file per line (the supervisor and dispatcher logs) simply create a
 * fresh `path` on the next write.
 */
export function rotateLogFile(
	path: string,
	maxBytes: number,
	keepFiles: number,
): Rotation {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return { rotated: false, freed: 0 };
	}
	if (size <= maxBytes) return { rotated: false, freed: 0 };
	let freed = 0;
	const oldest = `${path}.${keepFiles}`;
	try {
		freed = statSync(oldest).size;
		rmSync(oldest, { force: true });
	} catch {}
	for (let i = keepFiles - 1; i >= 1; i--) {
		const from = `${path}.${i}`;
		if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
	}
	renameSync(path, `${path}.1`);
	return { rotated: true, freed };
}

/* Git helpers */

const gitRun = promisify(execFile);
const GIT_TIMEOUT = 60_000;

async function git(
	repo: string,
	args: string[],
): Promise<{ ok: boolean; stdout: string; code?: number }> {
	try {
		const { stdout } = await gitRun("git", ["-C", repo, ...args], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT,
			maxBuffer: 64 * 1024 * 1024,
			env: detachedGitEnv(),
		});
		return { ok: true, stdout };
	} catch (error) {
		const failure = error as { code?: number; killed?: boolean };
		return {
			ok: false,
			stdout: "",
			code: failure.killed ? undefined : failure.code,
		};
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/* Run folder classification */

const LIVE_PHASES = new Set(["preparing", "admitted", "running", "settling"]);
const TERMINAL_PHASES = new Set(["settled", "failed"]);
/** A receipt this fresh may belong to a dispatcher mid-restart. */
const LIVE_RECEIPT_GRACE_MS = 30 * 60_000;
const EXPIRED_SUFFIX = /\.expired-\d+$/;
const RUN_CHECKOUT = /^(?:repo|task)(?:-\d+)?$|^repo\.orphan-/;
const LANE_LOG = /^(?:stdout|stderr)-\d+\.log$/;
const RECEIPT_NAME = /^([0-9a-fA-F-]{36})-(\d+)\.json$/;

interface RunReceipt {
	name: string;
	itemId: string;
	version: number;
	phase?: string;
	pid?: number;
	repo?: string;
	mtimeMs: number;
}

function readReceipts(dispatcherDir: string): RunReceipt[] {
	const receipts: RunReceipt[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(dispatcherDir);
	} catch {
		return receipts;
	}
	for (const name of names) {
		const match = RECEIPT_NAME.exec(name);
		if (!match) continue;
		const path = join(dispatcherDir, name);
		let row: Record<string, unknown>;
		let mtimeMs: number;
		try {
			row = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		receipts.push({
			name: name.slice(0, -".json".length),
			itemId: match[1]!,
			version: Number(match[2]),
			phase: typeof row.phase === "string" ? row.phase : undefined,
			pid: typeof row.pid === "number" ? row.pid : undefined,
			repo: typeof row.repo === "string" ? row.repo : undefined,
			mtimeMs,
		});
	}
	return receipts;
}

function receiptLive(receipt: RunReceipt, now: number): boolean {
	if (!receipt.phase || !LIVE_PHASES.has(receipt.phase)) return false;
	if (receipt.pid !== undefined) return alive(receipt.pid);
	return now - receipt.mtimeMs < LIVE_RECEIPT_GRACE_MS;
}

/** Newest mtime under `root`, pruning regenerable folders, `.git` and trash. */
function newestActivity(root: string): number {
	let newest = 0;
	let seen = 0;
	const stack = [root];
	while (stack.length && seen < 20_000) {
		const dir = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (++seen > 20_000) return newest;
			const path = join(dir, entry.name);
			let mtimeMs: number;
			try {
				mtimeMs = lstatSync(path).mtimeMs;
			} catch {
				continue;
			}
			if (mtimeMs > newest) newest = mtimeMs;
			if (
				entry.isDirectory() &&
				entry.name !== ".git" &&
				!entry.name.startsWith(".compact-trash") &&
				!REGENERABLE_DIRECTORIES.has(entry.name)
			)
				stack.push(path);
		}
	}
	return newest;
}

function runDirectories(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/** True when a process reports `root` (or inside it) as its working directory. */
async function pathInUse(root: string): Promise<boolean> {
	const canonical = resolve(root);
	const table = kernelProcessTable();
	if (!table) {
		// Without kernel facts any process could be inside; stay safe.
		return true;
	}
	for (const row of table) {
		if (row.pid === process.pid) continue;
		try {
			const cwd = kernelProcessCwd(row.pid);
			if (cwd === canonical || cwd?.startsWith(`${canonical}${sep}`))
				return true;
		} catch {}
	}
	return false;
}

/* Compaction */

/**
 * Regenerable folders inside one settled run worktree: the name must be on
 * the list, `git check-ignore` must claim it, and `git ls-files` must find no
 * tracked file under it. Each approved folder is renamed into a same-disk
 * trash folder inside the run first, then deleted.
 */
export async function compactRegenerableDirs(
	repo: string,
	runDir: string,
): Promise<{ dirs: number; bytes: number }> {
	const probe = await git(repo, ["rev-parse", "--git-dir"]);
	if (!probe.ok) return { dirs: 0, bytes: 0 };
	const candidates: string[] = [];
	const stack = [""];
	while (stack.length) {
		const rel = stack.pop()!;
		const abs = rel ? join(repo, rel) : repo;
		let entries: Dirent[];
		try {
			entries = readdirSync(abs, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (REGENERABLE_DIRECTORIES.has(entry.name)) {
				candidates.push(childRel);
				continue;
			}
			if (entry.name !== ".git") stack.push(childRel);
		}
	}
	if (!candidates.length) return { dirs: 0, bytes: 0 };
	const approved: string[] = [];
	for (const rel of candidates) {
		// Exit 0 means ignored; exit 1 means not ignored; anything else is an
		// error and the folder stays.
		const ignored = await git(repo, ["check-ignore", "-q", "--", rel]);
		if (!ignored.ok) continue;
		const tracked = await git(repo, ["ls-files", "-z", "--", rel]);
		if (!tracked.ok || tracked.stdout) continue;
		approved.push(rel);
	}
	if (!approved.length) return { dirs: 0, bytes: 0 };
	const trash = join(runDir, ".compact-trash");
	let bytes = 0;
	let moved = 0;
	try {
		for (const rel of approved) {
			const source = join(repo, rel);
			const target = join(trash, rel);
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
			bytes += diskUsage(source).bytes;
			renameSync(source, target);
			moved++;
		}
	} finally {
		rmSync(trash, { recursive: true, force: true });
	}
	return { dirs: moved, bytes };
}

/* Restore points */

export function restorePointsDir(configDir: string): string {
	return join(configDir, "restore-points");
}

/**
 * Saves what an expiring checkout still holds uniquely: a Git bundle of HEAD
 * (which carries every unpushed commit), a binary patch of uncommitted
 * changes, and the non-ignored untracked files. Returns the manifest path,
 * or undefined when nothing needed saving. The point name is deterministic
 * per run and checkout so a refused removal does not pile up duplicates.
 */
export async function createRestorePoint(
	checkout: string,
	runName: string,
	configDir: string,
): Promise<string | undefined> {
	const unpushed = await unpushedLaneCommits(checkout).catch(() => undefined);
	const status = await git(checkout, [
		"status",
		"--porcelain",
		"-z",
		"--untracked-files=all",
	]);
	const dirty = status.ok && status.stdout.length > 0;
	if ((!unpushed || unpushed.length === 0) && !dirty) return;
	const dir = restorePointsDir(configDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const base = `${runName}-${basename(checkout)}`;
	const manifest: Record<string, unknown> = {
		version: 1,
		run: runName,
		checkout,
		createdAt: new Date().toISOString(),
		unpushedCommits: unpushed ?? "unknown",
	};
	if (unpushed?.length) {
		const bundle = join(dir, `${base}.bundle`);
		const packed = await git(checkout, ["bundle", "create", bundle, "HEAD"]);
		if (packed.ok) manifest.bundle = basename(bundle);
	}
	if (dirty) {
		const patch = await git(checkout, ["diff", "HEAD", "--binary"]);
		if (patch.ok && patch.stdout) {
			const path = join(dir, `${base}.patch`);
			writeFileSync(path, patch.stdout, { mode: 0o600 });
			manifest.patch = basename(path);
		}
		const untracked = await git(checkout, [
			"ls-files",
			"-z",
			"--others",
			"--exclude-standard",
		]);
		if (untracked.ok && untracked.stdout) {
			const filesDir = join(dir, `${base}-files`);
			let copied = 0;
			for (const rel of untracked.stdout.split("\0")) {
				if (!rel || rel.includes("..")) continue;
				const source = join(checkout, rel);
				const target = join(filesDir, rel);
				try {
					if (!lstatSync(source).isFile()) continue;
					mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
					copyFileSync(source, target);
					copied++;
				} catch {}
			}
			if (copied) manifest.untrackedFiles = copied;
		}
	}
	const path = join(dir, `${base}.json`);
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, {
		mode: 0o600,
	});
	return path;
}

/* Expiry */

/**
 * The source repository a lane worktree belongs to: its git common dir is
 * `<source>/.git`, so the source is one level up. Undefined when Git cannot
 * say, which keeps the run protected.
 */
async function worktreeSource(checkout: string): Promise<string | undefined> {
	const common = await git(checkout, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (!common.ok || !common.stdout) return;
	const dir = common.stdout.trim();
	return basename(dir) === ".git" ? dirname(dir) : undefined;
}

/**
 * Removes one checkout of an expired run after its restore point exists.
 * `cleanupLaneWorktree` snapshots uncommitted work and unpushed commits into
 * `refs/lane-evicted/*` in the source repository and removes the worktree
 * only when nothing live uses it; evict is safe because the run is days past
 * settling. Returns false when the checkout must be kept.
 */
async function removeExpiredCheckout(
	checkout: string,
	source: string | undefined,
	refused: (reason: string) => void = () => {},
	inUse?: (destination: string) => boolean | Promise<boolean>,
): Promise<boolean> {
	if (!existsSync(join(checkout, ".git"))) return true;
	if (!source) {
		refused("git cannot name the source repository");
		return false;
	}
	const { cleanupLaneWorktree } = await import("./lane-serve");
	return cleanupLaneWorktree(source, checkout, inUse, true, refused);
}

/** A non-Git run folder (`task`, `repo.orphan-*`) moved into restore-points. */
function stashRunFolder(checkout: string, runName: string, configDir: string) {
	let entries: string[];
	try {
		entries = readdirSync(checkout);
	} catch {
		return false;
	}
	if (!entries.length) return false;
	const dir = restorePointsDir(configDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	renameSync(checkout, join(dir, `${runName}-${basename(checkout)}`));
	return true;
}

export interface RetentionReport {
	compactedDirs: number;
	compactedBytes: number;
	expiredRuns: number;
	expiredBytes: number;
	restorePoints: number;
	rotatedFiles: number;
	/** Bytes the dropped oldest log generation freed. */
	rotatedBytes: number;
	archivesDeleted: number;
	archivesBytes: number;
	restorePointsPruned: number;
	protectedRuns: string[];
	errors: string[];
}

export interface RetentionOptions {
	env?: NodeJS.ProcessEnv;
	configDir?: string;
	now?: number;
	/** False plans only: nothing is moved or deleted. */
	apply?: boolean;
	/** Per-checkout liveness probe; defaults to the dispatcher's own. */
	inUseCheckout?: (destination: string) => boolean | Promise<boolean>;
}

interface RunnerPlan {
	runsDir: string;
	receipts: RunReceipt[];
	liveNames: Set<string>;
	liveRunDirs: Set<string>;
}

function planRunner(dispatcherDir: string, now: number): RunnerPlan {
	const receipts = readReceipts(dispatcherDir);
	const liveNames = new Set<string>();
	const liveRunDirs = new Set<string>();
	const runsDir = resolve(join(dispatcherDir, "runs"));
	for (const receipt of receipts) {
		if (!receiptLive(receipt, now)) continue;
		liveNames.add(`${receipt.itemId}-${receipt.version}`);
		if (receipt.repo) {
			const runDir = resolve(dirname(receipt.repo));
			if (runDir.startsWith(runsDir + sep)) liveRunDirs.add(runDir);
		}
	}
	return {
		runsDir: join(dispatcherDir, "runs"),
		receipts,
		liveNames,
		liveRunDirs,
	};
}

function receiptMtimes(plan: RunnerPlan, name: string): number[] {
	return plan.receipts
		.filter((row) => row.name === name)
		.map((row) => row.mtimeMs);
}

/**
 * One retention pass over `~/.tedix`: compaction, expiry, log rotation,
 * archive aging and restore-point pruning. Safe to run at supervisor start
 * and hourly; every step is idempotent and each refusal keeps the data.
 */
export async function runRetention({
	env = process.env,
	configDir = tedixConfigDir(env),
	now = Date.now(),
	apply = true,
	inUseCheckout,
}: RetentionOptions = {}): Promise<RetentionReport> {
	const config = readRetentionConfig(env, configDir);
	const report: RetentionReport = {
		compactedDirs: 0,
		compactedBytes: 0,
		expiredRuns: 0,
		expiredBytes: 0,
		restorePoints: 0,
		rotatedFiles: 0,
		rotatedBytes: 0,
		archivesDeleted: 0,
		archivesBytes: 0,
		restorePointsPruned: 0,
		protectedRuns: [],
		errors: [],
	};
	const dispatchersDir = join(configDir, "dispatchers");
	const runners = runDirectories(dispatchersDir).map((name) =>
		join(dispatchersDir, name),
	);

	for (const dispatcherDir of runners) {
		const plan = planRunner(dispatcherDir, now);
		const runs = runDirectories(plan.runsDir);

		// Pass 1: compaction of quiet run worktrees.
		for (const name of runs) {
			if (EXPIRED_SUFFIX.test(name)) continue;
			const runDir = join(plan.runsDir, name);
			if (plan.liveNames.has(name) || plan.liveRunDirs.has(resolve(runDir)))
				continue;
			const activity = Math.max(
				newestActivity(runDir),
				...receiptMtimes(plan, name),
				0,
			);
			if (now - activity < config.compactAfterMs) continue;
			if (await pathInUse(runDir)) {
				report.protectedRuns.push(`${name}: a process still uses it`);
				continue;
			}
			if (apply)
				// A pass killed mid-compact leaves its trash behind.
				rmSync(join(runDir, ".compact-trash"), {
					recursive: true,
					force: true,
				});
			for (const child of runDirectories(runDir)) {
				if (!RUN_CHECKOUT.test(child)) continue;
				const checkout = join(runDir, child);
				// Only Git worktrees compact; `task` folders have no ignore rules.
				if (!existsSync(join(checkout, ".git"))) continue;
				try {
					const result = apply
						? await compactRegenerableDirs(checkout, runDir)
						: await estimateCompaction(checkout);
					report.compactedDirs += result.dirs;
					report.compactedBytes += result.bytes;
				} catch (error) {
					report.errors.push(
						`${checkout}: ${(error as Error).message?.slice(0, 200)}`,
					);
				}
			}
		}

		// Pass 2: expiry of settled or long-idle run folders.
		for (const name of runs) {
			const runDir = join(plan.runsDir, name);
			if (EXPIRED_SUFFIX.test(name)) {
				// A previous pass renamed it but died before deleting.
				const usage = apply ? diskUsage(runDir) : estimateRunBytes(runDir);
				if (apply) rmSync(runDir, { recursive: true, force: true });
				report.expiredRuns++;
				report.expiredBytes += usage.bytes;
				continue;
			}
			const live =
				plan.liveNames.has(name) || plan.liveRunDirs.has(resolve(runDir));
			const mtimes = receiptMtimes(plan, name);
			const receipt = plan.receipts.find((row) => row.name === name);
			const activity = Math.max(newestActivity(runDir), ...mtimes, 0);
			const settledAt =
				receipt && TERMINAL_PHASES.has(receipt.phase ?? "") && mtimes.length
					? Math.max(...mtimes)
					: 0;
			const due =
				(settledAt > 0 && now - settledAt > config.expireAfterMs) ||
				now - activity > config.idleMs;
			if (live || !due) continue;
			if (await pathInUse(runDir)) {
				report.protectedRuns.push(`${name}: a process still uses it`);
				continue;
			}
			// Restore points first: unpushed commits and uncommitted files of
			// every checkout, then non-Git folders moved aside wholesale.
			let blocked = false;
			for (const child of runDirectories(runDir)) {
				if (!RUN_CHECKOUT.test(child)) continue;
				const checkout = join(runDir, child);
				if (existsSync(join(checkout, ".git"))) {
					const readable = await git(checkout, ["rev-parse", "HEAD"]);
					if (!readable.ok) {
						report.protectedRuns.push(`${name}: git cannot read ${child}`);
						blocked = true;
						break;
					}
					if (apply) {
						const point = await createRestorePoint(checkout, name, configDir);
						if (point) report.restorePoints++;
						const source = await worktreeSource(checkout);
						const removed = await removeExpiredCheckout(
							checkout,
							source,
							(reason) =>
								report.protectedRuns.push(`${name}: ${child}: ${reason}`),
							inUseCheckout,
						);
						if (!removed) {
							blocked = true;
							break;
						}
					}
				} else if (apply) {
					if (stashRunFolder(checkout, name, configDir)) report.restorePoints++;
				}
			}
			if (blocked) continue;
			const usage = apply ? diskUsage(runDir) : estimateRunBytes(runDir);
			if (apply) {
				const expired = join(plan.runsDir, `${name}.expired-${now}`);
				renameSync(runDir, expired);
				rmSync(expired, { recursive: true, force: true });
			}
			report.expiredRuns++;
			report.expiredBytes += usage.bytes;
		}

		// Pass 3: log rotation. Per-lane turn logs belong to attempt folders —
		// never to a checkout, whose own files must not be touched — and only
		// of runs that are not live, since a running turn holds its log open.
		for (const name of runs) {
			if (EXPIRED_SUFFIX.test(name)) continue;
			const runDir = join(plan.runsDir, name);
			if (plan.liveNames.has(name) || plan.liveRunDirs.has(resolve(runDir)))
				continue;
			for (const child of runDirectories(runDir)) {
				if (RUN_CHECKOUT.test(child)) continue;
				const attemptDir = join(runDir, child);
				let files: string[];
				try {
					files = readdirSync(attemptDir);
				} catch {
					continue;
				}
				for (const file of files) {
					if (!LANE_LOG.test(file)) continue;
					const path = join(attemptDir, file);
					const rotation = rotateLogFile(
						path,
						config.logMaxBytes,
						config.logKeepFiles,
					);
					if (rotation.rotated) {
						report.rotatedFiles++;
						report.rotatedBytes += rotation.freed;
					}
				}
			}
		}

		// Pass 4: archives older than the retention window.
		const archiveDir = join(dispatcherDir, "archive");
		for (const name of runDirectories(archiveDir)) {
			const path = join(archiveDir, name);
			const stamp = Number(name.slice(name.lastIndexOf("-") + 1));
			const at =
				Number.isFinite(stamp) && stamp > 0 ? stamp : statSync(path).mtimeMs;
			if (now - at <= config.archiveMaxAgeMs) continue;
			const usage = apply ? diskUsage(path) : estimateRunBytes(path);
			if (apply) rmSync(path, { recursive: true, force: true });
			report.archivesDeleted++;
			report.archivesBytes += usage.bytes;
		}
	}

	// Runner and supervisor logs at the config root.
	try {
		for (const name of readdirSync(configDir)) {
			if (
				name !== "supervisor.log" &&
				!/^dev\.tedix\.lane-serve\..*\.log$/.test(name)
			)
				continue;
			const path = join(configDir, name);
			const rotation = rotateLogFile(
				path,
				config.logMaxBytes,
				config.logKeepFiles,
			);
			if (rotation.rotated) {
				report.rotatedFiles++;
				report.rotatedBytes += rotation.freed;
			}
		}
	} catch {}

	// Restore points past their keep window.
	const pointsDir = restorePointsDir(configDir);
	for (const name of runDirectories(pointsDir)) {
		const path = join(pointsDir, name);
		try {
			if (now - statSync(path).mtimeMs <= config.restoreKeepMs) continue;
		} catch {
			continue;
		}
		if (apply) rmSync(path, { recursive: true, force: true });
		report.restorePointsPruned++;
	}
	return report;
}

/**
 * Dry-run estimate of what compaction would free: the regenerable folders a
 * settled worktree would lose, sized by apparent bytes (the apply pass
 * measures allocated blocks instead).
 */
async function estimateCompaction(
	repo: string,
): Promise<{ dirs: number; bytes: number }> {
	const probe = await git(repo, ["rev-parse", "--git-dir"]);
	if (!probe.ok) return { dirs: 0, bytes: 0 };
	const candidates: string[] = [];
	const stack = [""];
	while (stack.length) {
		const rel = stack.pop()!;
		const abs = rel ? join(repo, rel) : repo;
		let entries: Dirent[];
		try {
			entries = readdirSync(abs, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (REGENERABLE_DIRECTORIES.has(entry.name)) {
				candidates.push(childRel);
				continue;
			}
			if (entry.name !== ".git") stack.push(childRel);
		}
	}
	let dirs = 0;
	let bytes = 0;
	for (const rel of candidates) {
		const ignored = await git(repo, ["check-ignore", "-q", "--", rel]);
		if (!ignored.ok) continue;
		const tracked = await git(repo, ["ls-files", "-z", "--", rel]);
		if (!tracked.ok || tracked.stdout) continue;
		dirs++;
		bytes += estimateRunBytes(join(repo, rel)).bytes;
	}
	return { dirs, bytes };
}

/** Cheap size for dry-run estimates: apparent bytes, no clone walk. */
function estimateRunBytes(root: string): DiskUsage {
	const usage: DiskUsage = { bytes: 0, files: 0, dirs: 0 };
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			try {
				const stat = lstatSync(path);
				usage.bytes += stat.size;
				if (entry.isDirectory()) {
					usage.dirs++;
					stack.push(path);
				} else usage.files++;
			} catch {}
		}
	}
	return usage;
}
