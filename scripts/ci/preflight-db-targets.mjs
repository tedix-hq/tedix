/**
 * Whether a changed path is an input to the D1 schema gate
 * (`packages/db` `db:migrate:check`: Drizzle snapshot, migration history and
 * collision, destructive DDL, local migration chain). The gate takes ~45s, so
 * it runs only for the paths it reads.
 *
 * Its inputs are the Drizzle schema (`src/schema/`, the only source tree
 * drizzle.config.ts loads; it imports nothing else under `src/`), the
 * migrations (`drizzle/`), the checker scripts, and the package's config files.
 * The query modules and other runtime code under `src/` never reach it, and
 * neither does a workspace's prose.
 */

import { isWorkspaceProse } from "./preflight-typecheck-targets.mjs";

const DB = "packages/db/";

/** @param {string} file repo-relative changed path */
export function isD1SchemaGateInput(file) {
	if (!file.startsWith(DB)) return false;
	if (isWorkspaceProse(file)) return false;
	if (file.startsWith(`${DB}src/`)) return file.startsWith(`${DB}src/schema/`);
	return true;
}
