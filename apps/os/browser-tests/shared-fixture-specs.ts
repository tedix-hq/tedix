import { specOutcome } from "./spec-outcome";

type SpecChild = {
	exitCode: number | null;
	exited: Promise<number>;
	kill(signal: NodeJS.Signals): void;
	signalCode?: string | number | null;
};

async function waitForSpec(
	child: SpecChild,
	fixtureExited: Promise<number> | undefined,
	reportExit: (code: number) => void,
	terminateGraceMs: number,
) {
	if (!fixtureExited) return child.exited;
	const firstExit = await Promise.race([
		child.exited.then((code) => ({ source: "spec" as const, code })),
		fixtureExited.then((code) => ({ source: "fixture" as const, code })),
	]);
	if (firstExit.source === "spec") return firstExit.code;

	reportExit(firstExit.code);
	child.kill("SIGTERM");
	let timeout: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		child.exited,
		new Promise((resolve) => {
			timeout = setTimeout(resolve, terminateGraceMs);
		}),
	]);
	if (timeout) clearTimeout(timeout);
	if (child.exitCode === null) child.kill("SIGKILL");
	return child.exited;
}

export async function runSharedFixtureSpecs(
	specs: readonly string[],
	server: { exitCode(): number | null; exited?: Promise<number> },
	runSpec: (spec: string) => SpecChild,
	log: (message: string) => void,
	report: (message: string) => void,
	terminateGraceMs = 5_000,
	concurrency = 3,
) {
	const results = new Array<{ spec: string; outcome: string }>(specs.length);
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
		async function runNext() {
			while (next < specs.length) {
				const exitCode = server.exitCode();
				if (exitCode !== null) reportExit(exitCode);
				const index = next++;
				const spec = specs[index]!;
				if (fixtureExit !== null) {
					results[index] = {
						spec,
						outcome: specOutcome(null, fixtureExit),
					};
					continue;
				}
				const begin = performance.now();
				log(`[run-specs] ${spec}`);
				const child = runSpec(spec);
				const code = await waitForSpec(
					child,
					server.exited,
					reportExit,
					terminateGraceMs,
				);
				const exited = server.exitCode();
				if (exited !== null) reportExit(exited);
				const failure = specOutcome(code, fixtureExit, child.signalCode);
				results[index] = {
					spec,
					outcome: `${failure} ${((performance.now() - begin) / 1000).toFixed(1)}s`,
				};
			}
		}
		await Promise.all(
			Array.from({ length: Math.min(concurrency, specs.length) }, runNext),
		);
		return results;
	} finally {
		// The caller stops its owned fixture after the suite; that exit is expected.
		active = false;
	}
}
