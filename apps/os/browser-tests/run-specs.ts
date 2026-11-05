import { readdirSync } from "node:fs";
import { warmFixtureModuleGraph } from "../dev/fixture-server-readiness";
import { startFixtureServer } from "./fixture-server";
import { runSharedFixtureSpecs } from "./shared-fixture-specs";
import { shardSpecs } from "./spec-shards";

/**
 * Runs up to three browser specs at once against one fixture server, so a job
 * pays one cold Vite start and independent specs do not block each other.
 * Every spec runs even after an earlier one fails; the exit code is non-zero if
 * any failed.
 * `--shard i/n` runs only every n-th spec, as assigned by the CI matrix.
 *
 *   bun browser-tests/run-specs.ts browser-tests/deck.spec.ts ...
 */
const args = process.argv.slice(2);
const shardFlag = args.indexOf("--shard");
const shard = shardFlag < 0 ? "1/1" : (args[shardFlag + 1] ?? "");
if (shardFlag >= 0) args.splice(shardFlag, 2);
const specs = shardSpecs(args, shard);
if (specs.length === 0) {
	console.error(
		args.length === 0
			? "Usage: bun browser-tests/run-specs.ts <spec>... [--shard i/n]"
			: `[run-specs] shard ${shard} selects none of ${args.length} specs`,
	);
	process.exit(2);
}
if (shardFlag >= 0)
	console.log(
		`[run-specs] shard ${shard}: ${specs.length} of ${args.length} specs`,
	);
const started = performance.now();
const server = await startFixtureServer();
const seconds = (since: number) =>
	`${((performance.now() - since) / 1000).toFixed(1)}s`;
console.log(
	`[run-specs] fixture server ${server.origin} ready in ${seconds(started)}`,
);
// Cold fixture entries discover dependencies while a neighbor spec runs: the
// shared server then re-bundles and stalls or reloads pages it does not own.
// Discover them now, while only this warmup page is connected.
const warmed = performance.now();
const fixtureEntries = readdirSync(new URL(".", import.meta.url))
	.filter((name) => name.endsWith(".html"))
	.sort()
	.map((name) => `/browser-tests/${name}`);
await warmFixtureModuleGraph(server.origin, fixtureEntries);
console.log(
	`[run-specs] warmed ${fixtureEntries.length} fixture entries in ${seconds(warmed)}`,
);
let results: Awaited<ReturnType<typeof runSharedFixtureSpecs>>;
try {
	results = await runSharedFixtureSpecs(
		specs,
		server,
		(spec) =>
			Bun.spawn([process.execPath, spec], {
				env: { ...process.env, OS_FIXTURE_ORIGIN: server.origin },
				stdout: "inherit",
				stderr: "inherit",
			}),
		console.log,
		console.error,
	);
} finally {
	await server.stop();
}
for (const { spec, outcome } of results)
	console.log(`[run-specs] ${outcome}  ${spec}`);
console.log(`[run-specs] ${specs.length} specs in ${seconds(started)}`);
if (results.some(({ outcome }) => !outcome.startsWith("PASS"))) process.exit(1);
