import { startFixtureServer } from "./fixture-server";
import { shardSpecs } from "./spec-shards";

/**
 * Runs browser specs one after another against one fixture server, so a job
 * pays one cold Vite start instead of one per spec. Every spec runs even after
 * an earlier one fails; the exit code is non-zero if any failed.
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
const results: { spec: string; outcome: string }[] = [];
try {
	for (const spec of specs) {
		if (server.exitCode() !== null) {
			results.push({ spec, outcome: "NOT RUN (fixture server exited)" });
			continue;
		}
		const begin = performance.now();
		console.log(`[run-specs] ${spec}`);
		const child = Bun.spawn([process.execPath, spec], {
			env: { ...process.env, OS_FIXTURE_ORIGIN: server.origin },
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await child.exited;
		const failure =
			code !== 0
				? `FAIL (exit ${code})`
				: server.exitCode() !== null
					? `FAIL (fixture server exited ${server.exitCode()})`
					: "PASS";
		results.push({ spec, outcome: `${failure} ${seconds(begin)}` });
	}
} finally {
	await server.stop();
}
for (const { spec, outcome } of results)
	console.log(`[run-specs] ${outcome}  ${spec}`);
console.log(`[run-specs] ${specs.length} specs in ${seconds(started)}`);
if (results.some(({ outcome }) => !outcome.startsWith("PASS"))) process.exit(1);
