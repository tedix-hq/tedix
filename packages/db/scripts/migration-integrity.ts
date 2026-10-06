import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	assertSnapshotPerMigration,
	checkMigrations,
} from "./check-migrations";

export interface MigrationIntegrityEntry {
	name: string;
	sha256: string;
}

export interface MigrationIntegrityManifest {
	version: 1;
	migrations: MigrationIntegrityEntry[];
}

const DB_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const DRIZZLE_DIR = path.join(DB_ROOT, "drizzle");
const MANIFEST_PATH = path.join(DB_ROOT, "migration-integrity.json");

export function discoverDrizzleMigrations(
	directory = DRIZZLE_DIR,
): MigrationIntegrityEntry[] {
	const names = readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `${entry.name}/migration.sql`)
		.sort();
	if (names.length === 0) throw new Error("No Drizzle migrations found");

	return names.map((name) => {
		const file = path.join(directory, name);
		if (!existsSync(file)) throw new Error(`${name}: missing migration.sql`);
		return {
			name,
			sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
		};
	});
}

export function parseMigrationIntegrityManifest(
	contents: string,
): MigrationIntegrityManifest {
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch (error) {
		throw new Error(
			`Migration integrity manifest is malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		typeof value !== "object" ||
		value === null ||
		(value as { version?: unknown }).version !== 1 ||
		!Array.isArray((value as { migrations?: unknown }).migrations)
	) {
		throw new Error("Migration integrity manifest must use version 1");
	}
	const migrations = (value as { migrations: unknown[] }).migrations.map(
		(entry, index) => {
			if (
				typeof entry !== "object" ||
				entry === null ||
				typeof (entry as { name?: unknown }).name !== "string" ||
				!/^\d{14}_[^/]+\/migration\.sql$/.test(
					(entry as { name: string }).name,
				) ||
				typeof (entry as { sha256?: unknown }).sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test((entry as { sha256: string }).sha256)
			) {
				throw new Error(`Migration integrity entry ${index} is invalid`);
			}
			return entry as MigrationIntegrityEntry;
		},
	);
	return { version: 1, migrations };
}

export function reconcileMigrationIntegrity(
	discovered: MigrationIntegrityEntry[],
	manifest: MigrationIntegrityManifest | undefined,
	mode: "check" | "write" | "draft",
	allowBootstrap = false,
): MigrationIntegrityManifest {
	if (!manifest) {
		if (mode !== "write" || !allowBootstrap) {
			throw new Error(
				"Migration integrity manifest is missing; history cannot be reconstructed automatically",
			);
		}
		return { version: 1, migrations: discovered };
	}

	for (const [index, recorded] of manifest.migrations.entries()) {
		const current = discovered[index];
		if (!current) {
			throw new Error(`${recorded.name}: recorded migration was removed`);
		}
		if (current.name !== recorded.name) {
			throw new Error(
				`Migration history is not append-only: expected ${recorded.name} at position ${index}, found ${current.name}`,
			);
		}
		if (current.sha256 !== recorded.sha256) {
			throw new Error(
				`${recorded.name}: applied migration SQL changed (expected ${recorded.sha256}, found ${current.sha256})`,
			);
		}
	}

	if (mode === "check" && discovered.length !== manifest.migrations.length) {
		const unrecorded = discovered
			.slice(manifest.migrations.length)
			.map(({ name }) => name);
		throw new Error(
			`Migration integrity manifest is stale; unrecorded migration(s): ${unrecorded.join(", ")}`,
		);
	}

	return {
		version: 1,
		migrations:
			mode === "write"
				? [
						...manifest.migrations,
						...discovered.slice(manifest.migrations.length),
					]
				: manifest.migrations,
	};
}

export function syncMigrationIntegrity(
	mode: "check" | "write" | "draft",
	options: {
		drizzleDir?: string;
		manifestPath?: string;
		allowBootstrap?: boolean;
	} = {},
): MigrationIntegrityManifest {
	const drizzleDir = options.drizzleDir ?? DRIZZLE_DIR;
	const manifestPath = options.manifestPath ?? MANIFEST_PATH;
	const discovered = discoverDrizzleMigrations(drizzleDir);
	const existing = existsSync(manifestPath)
		? parseMigrationIntegrityManifest(readFileSync(manifestPath, "utf8"))
		: undefined;
	const manifest = reconcileMigrationIntegrity(
		discovered,
		existing,
		mode,
		options.allowBootstrap,
	);
	if (mode === "write") {
		checkMigrations(drizzleDir);
		assertSnapshotPerMigration(
			drizzleDir,
			discovered.map(({ name }) => name),
		);
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	}
	return manifest;
}

if (import.meta.main) {
	const mode = process.argv.includes("--write") ? "write" : "check";
	const manifest = syncMigrationIntegrity(mode, {
		allowBootstrap: process.argv.includes("--bootstrap"),
	});
	console.log(
		`Migration integrity ${mode} passed (${manifest.migrations.length} migration(s))`,
	);
}
