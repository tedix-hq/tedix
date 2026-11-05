import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

const root = path.resolve(import.meta.dirname, "../..");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

test("stages only setup against an explicit logs target and refuses reuse", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "audit-stage-test-"));
	dirs.push(dir);
	const out = path.join(dir, "stage");
	const args = [
		process.execPath,
		path.join(root, "scripts/db/prepare-audit-index-rebuild.ts"),
		path.join(root, "packages/db/logs-db/wrangler.jsonc"),
		"public-installation-logs",
		out,
	];
	const result = Bun.spawnSync(args, { cwd: root });
	expect(result.exitCode).toBe(0);
	const config = JSON.parse(
		readFileSync(path.join(out, "wrangler.json"), "utf8"),
	);
	expect(config.d1_databases[0].migrations_table).toBe("tedix_logs_migrations");
	expect(readdirSync(path.join(out, "migrations")).sort()).toHaveLength(6);
	expect(readdirSync(path.join(out, "migrations"))).toContain(
		"0006_audit_events_lookup_indexes.sql",
	);
	expect(Bun.spawnSync(args, { cwd: root }).exitCode).not.toBe(0);
	args[3] = "some-other-database";
	args[4] = path.join(dir, "wrong");
	expect(Bun.spawnSync(args, { cwd: root }).exitCode).not.toBe(0);
});
