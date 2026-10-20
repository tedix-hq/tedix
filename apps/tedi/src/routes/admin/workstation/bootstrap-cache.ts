import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import { type WorkstationPackageManager } from "@tedix/api-contract/schemas/workstation";
import { isWorkstationPath, WORKSTATION_DIR } from "../../../workstation/paths";
import { errorMessage } from "@tedix/worker-kit/error-message";
import {
	workstationExecutionStatus,
	WorkstationDispatchUnknownError,
	workstationExec,
} from "../../../workstation/computer-body";
import { startCheckoutOperation } from "../../../workstation/checkout-lock";
import {
	WORKSTATION_PROCESS_ARTIFACT_BUCKET_REF,
	WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION,
	r2PrefixForTedi,
	ACTIVE_WORKSTATION_PROFILE_ID,
	type WorkstationBootstrapCacheBackupEntry,
	type WorkstationBootstrapCacheRecord,
	WORKSTATION_BOOTSTRAP_CACHE_RECORD_VERSION,
	bootstrapCacheKey,
	WORKSTATION_BOOTSTRAP_CACHE_MAX_RECORDS,
	type WorkstationBootstrapCacheResult,
	packageManagerForLockfile,
	packageManagerCacheDir,
	shellSingleQuote,
	WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER,
	WORKSTATION_BOOTSTRAP_CACHE_RESTORED_AT_PATH,
	assertCheckoutAuthority,
	execInRuntimeBody,
} from "./shared";
import { sanitizeArtifactIdPart } from "./process-evidence";
import {
	workstationOperationLockedInvocation,
	withWorkstationOperationLock,
} from "./locks";

export function workstationBootstrapCacheRefForKey(key: string): string {
	return `r2://${WORKSTATION_PROCESS_ARTIFACT_BUCKET_REF}/${key}`;
}

export function workstationBootstrapCachePrefix(
	c: Context<AppEnv>,
	packageManager: WorkstationPackageManager,
): string {
	const safeProfileVersion = sanitizeArtifactIdPart(
		WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION,
	);
	return `${r2PrefixForTedi(c)}/workstations/${ACTIVE_WORKSTATION_PROFILE_ID}/bootstrap-cache/${safeProfileVersion}/${packageManager}`;
}

export function workstationBootstrapCacheRecordKey(
	c: Context<AppEnv>,
	packageManager: WorkstationPackageManager,
	lockfileHash: string,
): string {
	const safeHash = sanitizeArtifactIdPart(lockfileHash);
	return `${workstationBootstrapCachePrefix(c, packageManager)}/${safeHash}.json`;
}

export function isBootstrapCacheBackupEntry(
	value: unknown,
): value is WorkstationBootstrapCacheBackupEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Partial<WorkstationBootstrapCacheBackupEntry>;
	return (
		(entry.kind === "node_modules" || entry.kind === "package_manager_cache") &&
		typeof entry.dir === "string" &&
		isWorkstationPath(entry.dir) &&
		Boolean(entry.backup)
	);
}

export function isWorkstationBootstrapCacheRecord(
	value: unknown,
	packageManager: WorkstationPackageManager,
	lockfileHash: string,
): value is WorkstationBootstrapCacheRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<WorkstationBootstrapCacheRecord>;
	return (
		record.version === WORKSTATION_BOOTSTRAP_CACHE_RECORD_VERSION &&
		record.profileId === ACTIVE_WORKSTATION_PROFILE_ID &&
		record.profileVersion === WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION &&
		record.packageManager === packageManager &&
		record.cacheKey === bootstrapCacheKey(packageManager, lockfileHash) &&
		record.lockfileHash === lockfileHash &&
		typeof record.tediId === "string" &&
		typeof record.workdir === "string" &&
		isWorkstationPath(record.workdir) &&
		typeof record.nodeModulesDir === "string" &&
		isWorkstationPath(record.nodeModulesDir) &&
		Array.isArray(record.backups) &&
		record.backups.length > 0 &&
		record.backups.every(isBootstrapCacheBackupEntry) &&
		typeof record.createdAt === "string"
	);
}

export async function readBootstrapCacheRecord(
	c: Context<AppEnv>,
	packageManager: WorkstationPackageManager,
	lockfileHash: string,
): Promise<WorkstationBootstrapCacheRecord | null> {
	if (!c.env.TEDI_STORAGE || typeof c.env.TEDI_STORAGE.get !== "function") {
		return null;
	}
	try {
		const obj = await c.env.TEDI_STORAGE.get(
			workstationBootstrapCacheRecordKey(c, packageManager, lockfileHash),
		);
		if (!obj) return null;
		const parsed = JSON.parse(await obj.text()) as unknown;
		return isWorkstationBootstrapCacheRecord(
			parsed,
			packageManager,
			lockfileHash,
		)
			? parsed
			: null;
	} catch {
		return null;
	}
}

export async function pruneBootstrapCacheRecords(
	c: Context<AppEnv>,
	packageManager: WorkstationPackageManager,
	keepLockfileHash: string,
): Promise<void> {
	const storage = c.env.TEDI_STORAGE;
	if (
		!storage ||
		typeof storage.list !== "function" ||
		typeof storage.get !== "function" ||
		typeof storage.delete !== "function"
	) {
		return;
	}
	try {
		const prefix = `${workstationBootstrapCachePrefix(c, packageManager)}/`;
		const listed = await storage.list({ prefix });
		const objects = Array.isArray(listed.objects) ? listed.objects : [];
		const records = (
			await Promise.all(
				objects.map(async (object) => {
					if (!object.key.endsWith(".json")) return null;
					const obj = await storage.get(object.key);
					if (!obj) return null;
					const parsed = JSON.parse(await obj.text()) as unknown;
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
						return null;
					}
					const record = parsed as Partial<WorkstationBootstrapCacheRecord>;
					if (
						record.version !== WORKSTATION_BOOTSTRAP_CACHE_RECORD_VERSION ||
						record.profileId !== ACTIVE_WORKSTATION_PROFILE_ID ||
						record.profileVersion !==
							WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION ||
						record.packageManager !== packageManager ||
						typeof record.lockfileHash !== "string"
					) {
						return null;
					}
					if (
						!isWorkstationBootstrapCacheRecord(
							parsed,
							packageManager,
							record.lockfileHash,
						)
					) {
						return null;
					}
					return { key: object.key, record };
				}),
			)
		).filter(
			(
				entry,
			): entry is { key: string; record: WorkstationBootstrapCacheRecord } =>
				entry !== null,
		);
		records.sort(
			(a, b) => Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt),
		);
		const evicted = records
			.filter((entry) => entry.record.lockfileHash !== keepLockfileHash)
			.slice(Math.max(0, WORKSTATION_BOOTSTRAP_CACHE_MAX_RECORDS - 1));
		await Promise.all(evicted.map((entry) => storage.delete(entry.key)));
	} catch (error) {
		console.warn(
			"[workstation] bootstrap cache eviction failed:",
			errorMessage(error),
		);
	}
}

export async function persistBootstrapCacheRecord(
	c: Context<AppEnv>,
	record: WorkstationBootstrapCacheRecord,
): Promise<WorkstationBootstrapCacheResult> {
	if (!c.env.TEDI_STORAGE || typeof c.env.TEDI_STORAGE.put !== "function") {
		return { ref: null, status: "unavailable" };
	}
	const key = workstationBootstrapCacheRecordKey(
		c,
		record.packageManager,
		record.lockfileHash,
	);
	try {
		await c.env.TEDI_STORAGE.put(key, `${JSON.stringify(record, null, 2)}\n`, {
			httpMetadata: { contentType: "application/json" },
		});
		await pruneBootstrapCacheRecords(
			c,
			record.packageManager,
			record.lockfileHash,
		);
		return {
			ref: workstationBootstrapCacheRefForKey(key),
			status: "persisted",
		};
	} catch (error) {
		return { error: errorMessage(error), ref: null, status: "failed" };
	}
}

export async function restoreBootstrapDependencyCache(
	c: Context<AppEnv>,
	input: {
		attemptId?: string | null;
		lockfile: string | null;
		lockfileHash: string | null;
		workdir: string;
	},
): Promise<WorkstationBootstrapCacheResult> {
	if (!input.lockfileHash) return { ref: null, status: "skipped" };
	const packageManager = packageManagerForLockfile(input.lockfile);
	const record = await readBootstrapCacheRecord(
		c,
		packageManager,
		input.lockfileHash,
	);
	if (!record) return { ref: null, status: "missing" };
	const nodeModulesDir = `${input.workdir}/node_modules`;
	const packageCacheDir = packageManagerCacheDir(packageManager);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify([
				c.get("workstationRuntimeSelection")?.leaseId,
				input.workdir,
				record.cacheKey,
			]),
		),
	);
	const executionId = `cache-restore-${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
	try {
		const previous = await c
			.get("sandbox")
			.readExecutionAssociation(executionId);
		if (previous) {
			const status = await workstationExecutionStatus(
				c.get("sandbox"),
				executionId,
			);
			if (!status.terminal)
				throw new WorkstationDispatchUnknownError(executionId);
			if (
				status.exitCode !== 0 ||
				status.timedOut ||
				status.signal !== undefined
			)
				return {
					ref: null,
					status: "failed",
					executionId,
					error: "Previous dependency cache publication failed",
				};
			return {
				ref: workstationBootstrapCacheRefForKey(
					workstationBootstrapCacheRecordKey(
						c,
						packageManager,
						input.lockfileHash,
					),
				),
				status: "restored",
				executionId,
				restoredAt:
					typeof previous.metadata?.context.restoredAt === "string"
						? previous.metadata.context.restoredAt
						: undefined,
			};
		}
	} catch {
		return {
			ref: null,
			status: "failed",
			executionId,
			observation: "unknown",
			error: new WorkstationDispatchUnknownError(executionId).message,
		};
	}
	const stage = `${WORKSTATION_DIR}/cache-restore-${crypto.randomUUID()}`;
	try {
		const created = await workstationExec(
			c.get("sandbox"),
			`umask 077; mkdir -- ${shellSingleQuote(stage)}`,
			{ timeout: 30000 },
		);
		if (created.exitCode !== 0)
			throw new Error("Cache staging directory unavailable");
		const targets = record.backups.map((entry, index) => ({
			staged: `${stage}/${index}`,
			target: entry.kind === "node_modules" ? nodeModulesDir : packageCacheDir,
			old: `${stage}/old-${index}`,
		}));
		if (new Set(targets.map((entry) => entry.target)).size !== targets.length)
			throw new Error("Duplicate dependency cache targets");
		for (let index = 0; index < record.backups.length; index++)
			await c.get("sandbox").restoreBackup({
				...record.backups[index]!.backup,
				dir: targets[index]!.staged,
			});
		const restoredAt = new Date().toISOString();
		const publish = String.raw`
const fs = require("node:fs"),
	path = require("node:path"),
	crypto = require("node:crypto");
const i = JSON.parse(process.argv[1]);
const target = i.lockfile || "package.json";
if (
	crypto
		.createHash("sha256")
		.update(fs.readFileSync(path.join(i.workdir, target)))
		.digest("hex") !== i.hash
)
	throw new Error("Checkout lockfile changed during cache staging");
const dev = fs.statSync(i.stage).dev;
for (const t of i.targets) {
	fs.mkdirSync(path.dirname(t.target), { recursive: true });
	if (
		!fs.lstatSync(t.staged).isDirectory() ||
		fs.lstatSync(t.staged).isSymbolicLink() ||
		fs.statSync(t.staged).dev !== dev ||
		fs.statSync(path.dirname(t.target)).dev !== dev
	)
		throw new Error(
			"Cache publication requires one filesystem and directory targets",
		);
	if (
		fs.existsSync(t.target) &&
		(!fs.lstatSync(t.target).isDirectory() ||
			fs.lstatSync(t.target).isSymbolicLink())
	)
		throw new Error("Unsafe cache destination");
}
let readyBytes;
for (const t of i.targets) {
	if (i.ready.startsWith(t.target + "/")) {
		const stagedReady = t.staged + i.ready.slice(t.target.length);
		if (fs.existsSync(stagedReady)) {
			if (
				!fs.lstatSync(stagedReady).isFile() ||
				fs.lstatSync(stagedReady).isSymbolicLink()
			)
				throw new Error("Unsafe staged readiness marker");
			readyBytes = fs.readFileSync(stagedReady);
			fs.unlinkSync(stagedReady);
		}
	}
}
fs.rmSync(i.ready, { force: true });
fs.rmSync(i.receipt, { force: true });
const moved = [];
try {
	for (const t of i.targets) {
		const had = fs.existsSync(t.target);
		if (had) fs.renameSync(t.target, t.old);
		moved.push({ t, had, published: false });
		fs.renameSync(t.staged, t.target);
		moved[moved.length - 1].published = true;
	}
	fs.writeFileSync(i.receipt, i.at + "\n");
	if (readyBytes !== undefined)
		fs.writeFileSync(i.ready, readyBytes, { flag: "wx", mode: 0o600 });
} catch (error) {
	fs.rmSync(i.ready, { force: true });
	for (const m of moved.reverse()) {
		if (m.published) fs.renameSync(m.t.target, m.t.staged);
		if (m.had) fs.renameSync(m.t.old, m.t.target);
	}
	throw error;
}
fs.rmSync(i.stage, { recursive: true, force: true });
`;
		const command = `bun -e ${shellSingleQuote(publish)} ${shellSingleQuote(
			JSON.stringify({
				stage,
				targets,
				workdir: input.workdir,
				lockfile: input.lockfile,
				hash: input.lockfileHash,
				ready: `${input.workdir}/${WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER}`,
				receipt: WORKSTATION_BOOTSTRAP_CACHE_RESTORED_AT_PATH,
				at: restoredAt,
			}),
		)}`;
		const operation = await startCheckoutOperation(c.get("sandbox"), {
			command: workstationOperationLockedInvocation(
				"dependency_cache",
				command,
			),
			timeout: 150000,
			executionId,
			metadata: {
				command: "restore dependency cache",
				cwd: input.workdir,
				context: { restoredAt, stage },
				timeoutMs: 150000,
			},
			authorize: () => assertCheckoutAuthority(c),
		});
		const published = await operation.process
			.output({ encoding: "utf8", timeout: 165000 })
			.catch(() => {
				throw new WorkstationDispatchUnknownError(executionId);
			});
		if (published.exitCode !== 0)
			throw new Error(
				published.stderr || "Dependency cache publication failed",
			);
		return {
			ref: workstationBootstrapCacheRefForKey(
				workstationBootstrapCacheRecordKey(
					c,
					packageManager,
					input.lockfileHash,
				),
			),
			restoredAt,
			status: "restored",
		};
	} catch (error) {
		return {
			error: errorMessage(error),
			ref: null,
			status: "failed",
			...(error instanceof WorkstationDispatchUnknownError
				? { executionId: error.executionId, observation: "unknown" as const }
				: {}),
		};
	}
}

export async function ensureBootstrapDependencyCacheBackup(
	c: Context<AppEnv>,
	input: {
		lockfile: string | null;
		lockfileHash: string | null;
		workdir: string;
	},
): Promise<WorkstationBootstrapCacheResult> {
	if (!input.lockfileHash) return { ref: null, status: "skipped" };
	const packageManager = packageManagerForLockfile(input.lockfile);
	const existingKey = workstationBootstrapCacheRecordKey(
		c,
		packageManager,
		input.lockfileHash,
	);
	const existing = await readBootstrapCacheRecord(
		c,
		packageManager,
		input.lockfileHash,
	);
	if (existing) {
		return {
			ref: workstationBootstrapCacheRefForKey(existingKey),
			status: "persisted",
		};
	}
	try {
		const lockfileHash = input.lockfileHash;
		const nodeModulesDir = `${input.workdir}/node_modules`;
		const packageCacheDir = packageManagerCacheDir(packageManager);
		const tediConfig = c.get("tediConfig");
		const backups = await withWorkstationOperationLock(
			c,
			"dependency_cache",
			async () => {
				await execInRuntimeBody(
					c,
					`mkdir -p ${shellSingleQuote(packageCacheDir)}`,
					{ cwd: input.workdir, timeout: 30_000 },
				);
				const targets = [
					{
						dir: packageCacheDir,
						kind: "package_manager_cache" as const,
					},
					{ dir: nodeModulesDir, kind: "node_modules" as const },
				];
				const entries: WorkstationBootstrapCacheBackupEntry[] = [];
				for (const target of targets) {
					const backup = await c.get("sandbox").createBackup({
						dir: target.dir,
						name: `tedix-${tediConfig.slug}-${ACTIVE_WORKSTATION_PROFILE_ID}-${packageManager}-${target.kind}-${lockfileHash.slice(0, 12)}`,
					});
					entries.push({ ...target, backup });
				}
				return entries;
			},
		);
		return await persistBootstrapCacheRecord(c, {
			version: WORKSTATION_BOOTSTRAP_CACHE_RECORD_VERSION,
			cacheKey: bootstrapCacheKey(packageManager, input.lockfileHash),
			profileId: ACTIVE_WORKSTATION_PROFILE_ID,
			profileVersion: WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION,
			packageManager,
			tediId: tediConfig.id,
			lockfile: input.lockfile,
			lockfileHash: input.lockfileHash,
			workdir: input.workdir,
			nodeModulesDir,
			backups,
			createdAt: new Date().toISOString(),
		});
	} catch (error) {
		return { error: errorMessage(error), ref: null, status: "failed" };
	}
}

/**
 * Reports whether the dependency cache exists without creating it on the
 * normal wake/exec response path. The durable provisioning fiber follows a
 * ready response with one synchronous, recoverable cache-backup phase.
 */
export async function readBootstrapDependencyCacheStatus(
	c: Context<AppEnv>,
	input: {
		lockfile: string | null;
		lockfileHash: string | null;
		workdir: string;
	},
): Promise<WorkstationBootstrapCacheResult> {
	if (!input.lockfileHash) return { ref: null, status: "skipped" };
	const packageManager = packageManagerForLockfile(input.lockfile);
	const recordKey = workstationBootstrapCacheRecordKey(
		c,
		packageManager,
		input.lockfileHash,
	);
	const existing = await readBootstrapCacheRecord(
		c,
		packageManager,
		input.lockfileHash,
	);
	if (existing) {
		return {
			ref: workstationBootstrapCacheRefForKey(recordKey),
			status: "persisted",
		};
	}

	return { ref: null, status: "pending" };
}
