/** Prepare a private, setup-only Wrangler config; performs no D1 operations. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, type ParseError } from "jsonc-parser";

const [configPath, databaseName, outputDir] = process.argv.slice(2);
if (!configPath || !databaseName || !outputDir)
	throw new Error(
		"Usage: bun scripts/db/prepare-audit-index-rebuild.ts <private logs config> <database name> <private output directory>",
	);
const errors: ParseError[] = [];
const config = parse(readFileSync(configPath, "utf8"), errors, {
	allowTrailingComma: true,
});
if (errors.length) throw new Error("Invalid private JSONC config");
const binding = config.d1_databases?.find(
	(entry: { binding: string; database_name: string }) =>
		entry.binding === "LOGS_DB" && entry.database_name === databaseName,
);
if (!binding || binding.migrations_table !== "tedix_logs_migrations")
	throw new Error(
		"Expected explicitly selected LOGS_DB with tedix_logs_migrations ledger",
	);
const out = path.resolve(outputDir);
const migrations = path.join(out, "migrations");
mkdirSync(out, { mode: 0o700 });
mkdirSync(migrations, { mode: 0o700 });
const source = path.resolve(
	import.meta.dirname,
	"../../packages/db/logs-db/migrations",
);
for (const file of [
	"0001_logs_schema.sql",
	"0002_log_partition.sql",
	"0003_runtime_events_global_kind_index.sql",
	"0004_audit_events_metadata_indexes.sql",
	"0005_drop_audit_events_metadata_indexes.sql",
	"0006_audit_events_lookup_indexes.sql",
])
	copyFileSync(path.join(source, file), path.join(migrations, file));
writeFileSync(
	path.join(out, "wrangler.json"),
	JSON.stringify(
		{
			name: "logs-audit-rebuild",
			...(config.account_id ? { account_id: config.account_id } : {}),
			d1_databases: [
				{
					binding: binding.binding,
					database_name: binding.database_name,
					database_id: binding.database_id,
					migrations_table: binding.migrations_table,
					migrations_dir: migrations,
				},
			],
		},
		null,
		2,
	),
	{ mode: 0o600 },
);
console.log(path.join(out, "wrangler.json"));
