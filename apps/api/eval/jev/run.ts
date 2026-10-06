/** Manual, bounded synthetic evaluation; never a production-data or CI gate. */
import { callJev, JevResponseError } from "@tedix/workers-ai/jev";
import { gradeJevFixture, JEV_FIXTURES } from "./fixtures";

const dryRun = process.argv.includes("--dry-run");
if (dryRun) {
	console.log(
		JSON.stringify(
			{ synthetic: true, cases: JEV_FIXTURES.map(({ id }) => id), sends: 0 },
			null,
			2,
		),
	);
} else {
	const env = {
		AI_GATEWAY_ACCOUNT_ID:
			process.env.CF_ACCOUNT_ID ?? process.env.AI_GATEWAY_ACCOUNT_ID,
		AI_GATEWAY_LLM_ID: process.env.AI_GATEWAY_LLM_ID,
		CF_WORKERS_AI_TOKEN: process.env.CF_WORKERS_AI_TOKEN,
		JEV_TRANSPORT: process.env.JEV_TRANSPORT ?? "cloudflare",
		TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
	};
	const rows = [];
	for (const fixture of JEV_FIXTURES) {
		const started = performance.now();
		try {
			const result = await callJev(
				{
					env,
					// Explicit operator-run synthetic provider evaluation has no tenant billing.
					authorize: async ({ attribution }) => ({ attribution }),
				},
				{
					state: fixture.state,
					questions: fixture.questions,
					timeoutMs: 10_000,
					attribution: {
						surface: "jev-eval",
						synthetic: "true",
						fixture: fixture.id,
					},
				},
			);
			rows.push({
				id: fixture.id,
				passed: gradeJevFixture(fixture, result.answers),
				elapsedMs: Math.round(performance.now() - started),
				model: result.model,
				usage: result.usage,
				answers: result.answers,
			});
		} catch (error) {
			rows.push({
				id: fixture.id,
				passed: false,
				elapsedMs: Math.round(performance.now() - started),
				error:
					error instanceof JevResponseError
						? "provider_response_error"
						: "dispatch_error",
				status: error instanceof JevResponseError ? error.status : undefined,
				usage: error instanceof JevResponseError ? error.usage : undefined,
			});
			// Authentication, funding, and availability failures are not helped by more sends.
			break;
		}
	}
	const elapsed = rows.map((row) => row.elapsedMs).sort((a, b) => a - b);
	console.log(
		JSON.stringify(
			{
				synthetic: true,
				transport: env.JEV_TRANSPORT,
				attempted: rows.length,
				planned: JEV_FIXTURES.length,
				passed: rows.filter((row) => row.passed).length,
				meanMs: Math.round(
					elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length,
				),
				p95Ms: elapsed[Math.ceil(elapsed.length * 0.95) - 1],
				rows,
			},
			null,
			2,
		),
	);
	if (rows.length !== JEV_FIXTURES.length || rows.some((row) => !row.passed))
		process.exitCode = 1;
}
