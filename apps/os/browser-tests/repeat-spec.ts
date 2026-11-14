import { readdirSync } from "node:fs";
import { join } from "node:path";
import { warmFixtureModuleGraph } from "../dev/fixture-server-readiness";
import { startFixtureServer } from "./fixture-server";
import { runSharedFixtureSpecs } from "./shared-fixture-specs";

const spec = process.argv[2];
const rounds = Number(process.argv[3] ?? 4);
if (!spec || !Number.isInteger(rounds) || rounds < 1 || rounds > 8)
	throw new Error(
		"Usage: bun browser-tests/repeat-spec.ts <spec> [rounds:1..8]",
	);

// Each round runs three independent copies under the normal shard concurrency.
// A failed round stops the probe; a later pass cannot replace its evidence.
const evidenceDirectory = join(
	process.env.TEDIX_BROWSER_EVIDENCE_DIR ?? "browser-tests/.cache",
	`repeat-${process.pid}`,
);
const server = await startFixtureServer();
try {
	await warmFixtureModuleGraph(
		server.origin,
		readdirSync(new URL(".", import.meta.url))
			.filter((name) => name.endsWith(".html"))
			.map((name) => `/browser-tests/${name}`),
	);
	for (let round = 1; round <= rounds; round++) {
		let lane = 0;
		const results = await runSharedFixtureSpecs(
			[spec, spec, spec],
			server,
			(path) =>
				Bun.spawn([process.execPath, path], {
					env: {
						...process.env,
						OS_FIXTURE_ORIGIN: server.origin,
						DEBUG: process.env.DEBUG ?? "pw:browser",
						TEDIX_BROWSER_EVIDENCE_DIR: join(
							evidenceDirectory,
							`round-${round}-lane-${++lane}`,
						),
					},
					stdout: "inherit",
					stderr: "inherit",
				}),
			console.log,
			console.error,
		);
		for (const [index, result] of results.entries())
			console.log(
				`[repeat-spec] round ${round} lane ${index + 1}: ${result.outcome}`,
			);
		if (results.some(({ outcome }) => !outcome.startsWith("PASS"))) {
			process.exitCode = 1;
			break;
		}
	}
} finally {
	await server.stop();
}
