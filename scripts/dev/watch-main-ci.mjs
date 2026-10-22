import { spawnSync } from "node:child_process";

export function buildQueueStallDispatch({
	pushedSha,
	run,
	queuedForMs,
	newerRuns,
	jobs,
	pendingDeployments,
}) {
	return {
		event_type: "product-ci-queue-stalled",
		client_payload: {
			pushed_sha: pushedSha,
			queued_sha: run.head_sha,
			run_id: run.id,
			run_url: run.html_url,
			status: run.status,
			created_at: run.created_at,
			updated_at: run.updated_at,
			queued_for_seconds: Math.floor(queuedForMs / 1000),
			jobs: jobs.slice(0, 20).map((job) => ({
				id: job.id,
				name: job.name,
				status: job.status,
				conclusion: job.conclusion,
				runner_name: job.runner_name ?? null,
				started_at: job.started_at ?? null,
				step_count: job.steps?.length ?? 0,
			})),
			pending_deployments: pendingDeployments
				.slice(0, 20)
				.map((deployment) => ({
					environment: deployment.environment?.name ?? null,
					wait_timer_minutes: deployment.wait_timer ?? 0,
					reviewer_count: deployment.reviewers?.length ?? 0,
					current_user_can_approve:
						deployment.current_user_can_approve ?? false,
				})),
			newer_runs: newerRuns.slice(0, 5).map((newerRun) => ({
				id: newerRun.id,
				head_sha: newerRun.head_sha,
				status: newerRun.status,
				conclusion: newerRun.conclusion,
			})),
		},
	};
}

export async function observeCiCompletion({
	pushedSha,
	readRuns,
	includes,
	notify,
	escalateQueued,
	now = Date.now,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	timeoutMs = 30 * 60_000,
	intervalMs = 15_000,
	queuedAfterMs = 10 * 60_000,
	log = console.error,
}) {
	if (!/^[a-f0-9]{40}$/.test(pushedSha))
		throw new Error("An exact pushed SHA is required");
	const started = now();
	const ancestry = new Map();
	const escalatedRuns = new Set();
	const includesPush = async (sha) => {
		if (!ancestry.has(sha))
			ancestry.set(sha, sha === pushedSha || (await includes(pushedSha, sha)));
		return ancestry.get(sha);
	};
	let lastError = "";
	while (now() - started < timeoutMs) {
		try {
			const seen = new Set();
			const runs = await readRuns();
			for (const [index, run] of runs.entries()) {
				if (seen.has(run.head_sha)) continue;
				seen.add(run.head_sha);
				if (run.status === "queued" && !escalatedRuns.has(run.id)) {
					const queuedForMs = now() - Date.parse(run.created_at);
					if (
						Number.isFinite(queuedForMs) &&
						queuedForMs >= queuedAfterMs &&
						(await includesPush(run.head_sha))
					) {
						await escalateQueued(run, queuedForMs, runs.slice(0, index));
						escalatedRuns.add(run.id);
					}
				}
				if (run.status !== "completed" || run.conclusion !== "success")
					continue;
				if (!(await includesPush(run.head_sha))) continue;
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
			escalateQueued: async (run, queuedForMs, newerRuns) => {
				const jobs = api(
					`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
				).jobs;
				const pendingDeployments = api(
					`/repos/${repository}/actions/runs/${run.id}/pending_deployments`,
				);
				return api(
					"/repos/tedix-hq/tedix-cloud-ops/dispatches",
					buildQueueStallDispatch({
						pushedSha: process.env.TEDIX_CI_PUSHED_SHA,
						run,
						queuedForMs,
						newerRuns,
						jobs,
						pendingDeployments,
					}),
				);
			},
		});
		console.log(`CI completion notified ops: ${JSON.stringify(result)}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
