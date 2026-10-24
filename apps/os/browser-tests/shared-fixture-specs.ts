import { specOutcome } from "./spec-outcome";

export async function runSharedFixtureSpecs(
	specs: readonly string[],
	server: { exitCode(): number | null; exited?: Promise<number> },
	runSpec: (spec: string) => {
		exited: Promise<number>;
		signalCode?: string | number | null;
	},
	log: (message: string) => void,
	report: (message: string) => void,
) {
	const results: { spec: string; outcome: string }[] = [];
	let next = 0;
	let active = true;
	let fixtureExit: number | null = null;
	function reportExit(code: number) {
		if (!active || fixtureExit !== null) return;
		fixtureExit = code;
		report(`[run-specs] fixture server exited with code ${code}`);
		for (const spec of specs.slice(next))
			report(`[run-specs] NOT RUN (fixture server exited ${code})  ${spec}`);
	}
	void server.exited?.then(reportExit);
	try {
		for (const spec of specs) {
			const exitCode = server.exitCode();
			if (exitCode !== null) reportExit(exitCode);
			if (fixtureExit !== null) {
				results.push({
					spec,
					outcome: specOutcome(null, fixtureExit),
				});
				continue;
			}
			next++;
			const begin = performance.now();
			log(`[run-specs] ${spec}`);
			const child = runSpec(spec);
			const code = await child.exited;
			const exited = server.exitCode();
			if (exited !== null) reportExit(exited);
			const failure = specOutcome(code, fixtureExit, child.signalCode);
			results.push({
				spec,
				outcome: `${failure} ${((performance.now() - begin) / 1000).toFixed(1)}s`,
			});
		}
		return results;
	} finally {
		// The caller stops its owned fixture after the suite; that exit is expected.
		active = false;
	}
}
