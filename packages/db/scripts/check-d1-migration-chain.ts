import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	compareMigrationLedger,
	D1_MIGRATIONS_TABLE,
	readMigrationManifest,
} from "./check-live-migration-ledger";
import { discoverDrizzleMigrations } from "./migration-integrity";
import { parseWranglerJson, runWrangler } from "./wrangler-command";
import { isRecord } from "@tedix/api-contract/utils/is-record";

function successfulResults(
	payload: unknown[],
	index: number,
	context: string,
): unknown[] {
	const result = payload[index];
	if (
		!isRecord(result) ||
		result.success !== true ||
		!Array.isArray(result.results)
	) {
		throw new Error(`${context} did not succeed`);
	}
	return result.results;
}

export function assertLocalMigrationInspection(
	payload: unknown,
	expectedNames: string[],
): void {
	if (!Array.isArray(payload) || payload.length !== 2) {
		throw new Error(
			"Local D1 migration inspection returned an unexpected envelope",
		);
	}
	const names = successfulResults(
		payload,
		0,
		"Local migration ledger query",
	).map((row, index) => {
		if (!isRecord(row) || typeof row.name !== "string") {
			throw new Error(`Local migration ledger row ${index} is invalid`);
		}
		return row.name;
	});
	compareMigrationLedger(expectedNames, names, false);

	const foreignKeys = successfulResults(payload, 1, "PRAGMA foreign_key_check");
	if (foreignKeys.length > 0) {
		throw new Error(
			`PRAGMA foreign_key_check found ${foreignKeys.length} violation(s)`,
		);
	}
}

/**
 * Addressed by binding, not database name: the chain runs against a throwaway
 * local store, and a public installation renames the database.
 */
const D1_BINDING = "DB";

const DB_ROOT = fileURLToPath(new URL("../", import.meta.url));

function snapshotDigest(directory: string): string {
	const hash = createHash("sha256");
	function visit(relative: string): void {
		for (const entry of readdirSync(path.join(directory, relative), {
			withFileTypes: true,
		}).sort((a, b) => a.name.localeCompare(b.name))) {
			const name = path.join(relative, entry.name);
			if (entry.isDirectory()) visit(name);
			else {
				if (!entry.isFile())
					throw new Error(`Unexpected snapshot entry: ${name}`);
				hash.update(
					JSON.stringify([
						name,
						createHash("sha256")
							.update(readFileSync(path.join(directory, name)))
							.digest("hex"),
					]),
				);
			}
		}
	}
	visit("");
	return hash.digest("hex");
}

export function checkD1MigrationChain(
	options: {
		dbRoot?: string;
		cacheDirectory?: string;
		env?: NodeJS.ProcessEnv;
		run?: typeof runWrangler;
	} = {},
): { cachedCount: number; appliedCount: number } {
	const started = performance.now();
	const phase = (name: string, since: number) =>
		console.log(
			`[D1 chain ${new Date().toISOString()}] ${name}: ${(performance.now() - since).toFixed(0)}ms`,
		);
	const dbRoot = options.dbRoot ?? DB_ROOT;
	const env = options.env ?? process.env;
	// CI (including the hourly --all --ci-policy suite) always rehearses from empty.
	const fullReplay =
		env.CI === "true" ||
		env.CI === "1" ||
		env.TEDIX_D1_CHAIN_FULL_REPLAY === "1";
	const run = options.run ?? runWrangler;
	const manifest = readMigrationManifest(
		path.join(dbRoot, "migration-integrity.json"),
	);
	const expectedNames = manifest.migrations.map(({ name }) => name);
	// Discover files even on a complete hit, so unrecorded migrations cannot hide.
	const migrations = discoverDrizzleMigrations(path.join(dbRoot, "drizzle"));
	compareMigrationLedger(
		expectedNames,
		migrations.map(({ name }) => name),
		false,
	);
	// Hash actual SQL digests, not the possibly stale integrity manifest.
	const hash = createHash("sha256")
		.update(readFileSync(fileURLToPath(import.meta.url)))
		.update(readFileSync(new URL("./wrangler-command.ts", import.meta.url)))
		.update(readFileSync(path.join(DB_ROOT, "../../bun.lock")))
		.update(readFileSync(path.join(dbRoot, "wrangler.jsonc")))
		.update(JSON.stringify([process.version, process.platform, process.arch]));
	const keys = migrations.map((migration) => {
		hash.update(JSON.stringify(migration));
		return hash.copy().digest("hex");
	});
	const cacheDirectory =
		options.cacheDirectory ?? path.join(tmpdir(), "tedix-d1-chain-cache-v1");
	const persistencePath = mkdtempSync(path.join(tmpdir(), "tedix-d1-chain-"));
	let cachedCount = 0;
	try {
		const restoreStarted = performance.now();
		if (!fullReplay) {
			for (let count = keys.length; count > 0; count--) {
				const snapshot = path.join(cacheDirectory, keys[count - 1]!);
				if (!existsSync(path.join(snapshot, "digest"))) continue;
				// A damaged snapshot is a miss, never evidence of a checked prefix.
				if (
					snapshotDigest(path.join(snapshot, "state")) !==
					readFileSync(path.join(snapshot, "digest"), "utf8")
				)
					continue;
				cpSync(path.join(snapshot, "state"), persistencePath, {
					recursive: true,
				});
				cachedCount = count;
				break;
			}
		}
		phase(
			`snapshot restore (${cachedCount}/${keys.length}; ${fullReplay ? "full replay" : "cache enabled"})`,
			restoreStarted,
		);
		const common = [
			D1_BINDING,
			"--local",
			"--persist-to",
			persistencePath,
			"--config",
			"wrangler.jsonc",
		];
		const applyStarted = performance.now();
		if (cachedCount < expectedNames.length) {
			run(["d1", "migrations", "apply", ...common], {
				cwd: dbRoot,
				// Suppress Wrangler's quadratic progress-table redraw output.
				env: { CI: "1", WRANGLER_LOG: "error" },
			});
		}
		phase(
			`Wrangler migrations apply (${expectedNames.length - cachedCount} pending)`,
			applyStarted,
		);
		const inspectStarted = performance.now();
		const inspection = run(
			[
				"d1",
				"execute",
				...common,
				"--command",
				`SELECT name FROM ${D1_MIGRATIONS_TABLE} ORDER BY id; PRAGMA foreign_key_check;`,
				"--json",
			],
			{ cwd: dbRoot },
		);
		assertLocalMigrationInspection(
			parseWranglerJson(inspection, "Local D1 migration inspection"),
			expectedNames,
		);
		phase("Wrangler ledger and foreign-key inspection", inspectStarted);
		if (!fullReplay && cachedCount < keys.length) {
			const publishStarted = performance.now();
			mkdirSync(cacheDirectory, { recursive: true });
			const staging = mkdtempSync(path.join(cacheDirectory, ".snapshot-"));
			try {
				cpSync(persistencePath, path.join(staging, "state"), {
					recursive: true,
				});
				writeFileSync(
					path.join(staging, "digest"),
					snapshotDigest(path.join(staging, "state")),
				);
				const destination = path.join(cacheDirectory, keys.at(-1)!);
				// Another checker may already have published the same immutable snapshot.
				try {
					renameSync(staging, destination);
				} catch (error) {
					if (!existsSync(destination)) throw error;
				}
			} finally {
				rmSync(staging, { recursive: true, force: true });
			}
			phase("snapshot publish", publishStarted);
		}
		console.log(
			`D1 migration chain passed (${expectedNames.length} applied; ${cachedCount} restored; foreign keys valid)`,
		);
		phase("total", started);
		return { cachedCount, appliedCount: expectedNames.length - cachedCount };
	} finally {
		rmSync(persistencePath, { recursive: true, force: true });
	}
}

if (import.meta.main) checkD1MigrationChain();
