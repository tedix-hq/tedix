#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkOnboardingSchema } from "@tedix/api-contract/schemas/work-onboarding";
import blueprint from "../apps/os/dev/demo-pack/work-blueprint.json";

/** Local installation setup only; never replaces an operator's existing publication. */
export function localInstallationSeedSql() {
	const definition = {
		workOnboarding: WorkOnboardingSchema.parse({
			version: 1,
			definition: blueprint,
		}),
	};
	const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
	return `INSERT INTO policy_packs (id,organization_id,name,slug,scope,target,status,version,published_at,published_by,definition)
 SELECT ${q(crypto.randomUUID())},NULL,'Local Work onboarding','work-onboarding','system','shared','active',1,${q(new Date().toISOString())},'local-development',${q(JSON.stringify(definition))}
 WHERE NOT EXISTS (SELECT 1 FROM policy_packs WHERE scope='system' AND slug='work-onboarding');\n`;
}

if (import.meta.main) {
	const directory = mkdtempSync(join(tmpdir(), "tedix-local-installation-"));
	const file = join(directory, "seed.sql");
	try {
		writeFileSync(file, localInstallationSeedSql());
		const run = spawnSync(
			"bun",
			[
				"../../scripts/dev-local.ts",
				"--",
				"wrangler",
				"d1",
				"execute",
				"DB",
				"--file",
				file,
			],
			{ cwd: resolve(import.meta.dirname, "../apps/api"), stdio: "inherit" },
		);
		if (run.status !== 0) process.exitCode = run.status ?? 1;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
