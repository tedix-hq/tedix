import { spawnSync } from "node:child_process";

export async function observeCiCompletion({
	pushedSha,
	readRuns,
	includes,
	notify,
	now = Date.now,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	timeoutMs = 30 * 60_000,
	intervalMs = 15_000,
	log = console.error,
}) {
	if (!/^[a-f0-9]{40}$/.test(pushedSha))
		throw new Error("An exact pushed SHA is required");
	const started = now();
	const ancestry = new Map();
	let lastError = "";
	while (now() - started < timeoutMs) {
		try {
			const seen = new Set();
			for (const run of await readRuns()) {
				if (seen.has(run.head_sha)) continue;
				seen.add(run.head_sha);
				if (run.status !== "completed" || run.conclusion !== "success")
					continue;
				if (!ancestry.has(run.head_sha))
					ancestry.set(
						run.head_sha,
						run.head_sha === pushedSha ||
							(await includes(pushedSha, run.head_sha)),
					);
				if (!ancestry.get(run.head_sha)) continue;
				await notify(run);
				return { sha: run.head_sha, runId: run.id };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== lastError) log(`CI completion observer: ${message}`);
			lastError = message;
		}
		await sleep(intervalMs);
	}
	throw new Error(
		"CI completion observer timed out; Ship fallback remains active",
	);
}

if (import.meta.main) {
	const repository = "tedix-hq/tedix";
	const api = (path, payload) => {
		const result = spawnSync(
			"gh",
			[
				"api",
				...(payload ? ["--method", "POST"] : []),
				path,
				...(payload ? ["--input", "-"] : []),
			],
			{
				encoding: "utf8",
				timeout: 20_000,
				...(payload ? { input: JSON.stringify(payload) } : {}),
			},
		);
		if (result.status !== 0)
			throw new Error(result.stderr?.trim() || "GitHub request failed");
		return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
	};
	try {
		const result = await observeCiCompletion({
			pushedSha: process.env.TEDIX_CI_PUSHED_SHA,
			readRuns: async () =>
				api(
					`/repos/${repository}/actions/workflows/full-suite-hourly.yml/runs?branch=main&per_page=100`,
				).workflow_runs.filter(
					(run) =>
						run.head_branch === "main" &&
						run.head_repository?.full_name === repository,
				),
			includes: async (base, head) =>
				api(`/repos/${repository}/compare/${base}...${head}`).merge_base_commit
					.sha === base,
			notify: async (run) =>
				api("/repos/tedix-hq/tedix-cloud-ops/dispatches", {
					event_type: "product-ci-completed",
					client_payload: { certified_sha: run.head_sha, run_id: run.id },
				}),
		});
		console.log(`CI completion notified ops: ${JSON.stringify(result)}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
