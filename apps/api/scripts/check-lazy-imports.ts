/** Guard the cold-start import boundary, without byte budgets or generated roots. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	eagerModules,
	eagerImportViolations,
	type InputModule,
} from "./lazy-imports";

const appRoot = join(import.meta.dir, "..");
const outdir = mkdtempSync(join(tmpdir(), "api-lazy-imports-"));
try {
	const metafile = join(outdir, "meta.json");
	execFileSync(
		"bunx",
		[
			"esbuild",
			"src/index.ts",
			"src/worker-app.ts",
			"--bundle",
			"--format=esm",
			"--platform=node",
			"--conditions=workerd,worker,browser",
			"--external:cloudflare:*",
			"--splitting",
			`--outdir=${outdir}`,
			`--metafile=${metafile}`,
			"--log-level=error",
		],
		{ cwd: appRoot, stdio: "inherit" },
	);
	const { inputs } = JSON.parse(readFileSync(metafile, "utf8")) as {
		inputs: Record<string, InputModule>;
	};
	for (const entry of ["src/index.ts", "src/worker-app.ts"]) {
		const violations = eagerImportViolations(
			eagerModules(inputs, entry),
			entry === "src/index.ts",
		);
		assert.equal(
			violations.length,
			0,
			`${entry} eagerly imports ${violations.join(", ")}. Keep the app and workflows deferred at startup and router implementations behind dynamic imports.`,
		);
	}
	console.log("apps/api lazy import boundaries passed");
} finally {
	rmSync(outdir, { recursive: true, force: true });
}
