// Hosted test runs that never gate a deploy: affected tests after a commit is
// live, and the full suite nightly. `plan` reads the deployed commit from the
// service health endpoints on the 10-minute schedule, tests each live commit
// once, and selects the jobs. It never touches the push gate
// (`full-suite-hourly.yml`), its aggregate, or Ship.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { laneSelection, suiteSelection } from "./full-suite-hourly.mjs";

export const HOSTED_WORKFLOW = "hosted-suite.yml";
export const DEPLOYED_TITLE = "Post-deploy tests @ ";
export const WATCH_TITLE = "Post-deploy tests (watch)";
export const NIGHTLY_CRON = "17 2 * * *";
export const STATUS_CONTEXT = "Hosted suite / post-deploy";
const SHA = /^[0-9a-f]{40}$/;

export function gitIsAncestor(ancestor, descendant) {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Ship deploys only the services a commit changes, so each health endpoint
 * reports the commit of its own last deploy. The deployed commit is the one
 * every other report is an ancestor of; anything else (a rollback, a commit
 * off main) has no single deployed commit and returns null.
 */
export function deployedSha(reported, isAncestor = gitIsAncestor) {
	const shas = [...new Set(reported)];
	if (!shas.length || shas.some((sha) => !SHA.test(sha))) return null;
	return (
		shas.find((candidate) =>
			shas.every((sha) => sha === candidate || isAncestor(sha, candidate)),
		) ?? null
	);
}

export async function readHealthShas(
	urls,
	{
		fetcher = fetch,
		attempts = 3,
		sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
	} = {},
) {
	const shas = [];
	for (const url of urls) {
		let sha;
		for (let attempt = 1; ; attempt++) {
			try {
				const response = await fetcher(url, {
					headers: { Accept: "application/json" },
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				sha = (await response.json()).deployedSha;
				if (typeof sha !== "string" || !SHA.test(sha))
					throw new Error("no deployedSha");
				break;
			} catch (error) {
				if (attempt >= attempts)
					throw new Error(`${url} health unreadable: ${error.message}`);
				await sleep(2_000 * attempt);
			}
		}
		shas.push(sha);
	}
	return shas;
}

export function deployedRunSha(run) {
	const title = run.display_title ?? "";
	if (!title.startsWith(DEPLOYED_TITLE)) return null;
	const sha = title.slice(DEPLOYED_TITLE.length).trim();
	return SHA.test(sha) ? sha : null;
}

/** The commit a run tested: from its title, or from a watch run's aggregate job. */
export function testedSha(run, jobs = []) {
	const titled = (run.display_title ?? "").match(/ @ ([0-9a-f]{40})$/)?.[1];
	if (titled) return titled;
	for (const job of jobs) {
		const named = /^Hosted suite @ ([0-9a-f]{40})$/.exec(job.name ?? "")?.[1];
		if (named) return named;
	}
	return null;
}

async function github(path, { method = "GET", body, env = process.env } = {}) {
	const response = await fetch(
		`${env.GITHUB_API_URL || "https://api.github.com"}${path}`,
		{
			method,
			headers: {
				Authorization: `Bearer ${env.GITHUB_TOKEN}`,
				Accept: "application/vnd.github+json",
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		},
	);
	if (!response.ok)
		throw new Error(`GitHub ${method} ${path} failed (${response.status})`);
	return response.status === 204 ? null : response.json();
}

/**
 * The newest commit whose post-deploy run passed and that `sha` descends from.
 * Diffing from there, not from the previous deploy, re-tests a failed range
 * until a run covering it passes.
 */
export async function greenBase(
	runs,
	sha,
	{ runId, isAncestor = gitIsAncestor, testedOf = deployedRunSha } = {},
) {
	for (const run of runs) {
		if (String(run.id) === String(runId)) continue;
		if (run.status !== "completed" || run.conclusion !== "success") continue;
		const tested = await testedOf(run);
		if (tested && tested !== sha && isAncestor(tested, sha)) return tested;
	}
	return null;
}

/** The live commit a watch run should test, or null when there is nothing new. */
async function watchedSha(env, urls) {
	let reported;
	try {
		reported = await readHealthShas(urls);
	} catch (error) {
		// A health outage is the deploy smoke check's incident, not this one's.
		console.log(`::warning::${error.message}; nothing to test`);
		return null;
	}
	const sha = deployedSha(reported);
	if (!sha || !gitIsAncestor(sha, "origin/main")) {
		console.log(
			`::notice::Health reports ${reported.join(", ")} share no deployed commit on main; nothing to test`,
		);
		return null;
	}
	const statuses = await github(
		`/repos/${env.GITHUB_REPOSITORY}/commits/${sha}/statuses?per_page=100`,
	);
	if (statuses.some((status) => status.context === STATUS_CONTEXT)) {
		console.log(`Live ${sha} already has a post-deploy run`);
		return null;
	}
	return sha;
}

export async function plan(env = process.env) {
	const nightly =
		env.EVENT_NAME === "schedule" && env.SCHEDULE === NIGHTLY_CRON;
	const watching = env.EVENT_NAME === "schedule" && !nightly;
	const full = nightly || env.INPUT_FULL === "true";
	const urls = env.HEALTH_URLS.split(/\s+/).filter(Boolean);
	// A commit deployed after this run started is newer than its checkout.
	execFileSync("git", [
		"fetch",
		"--quiet",
		"--no-tags",
		"origin",
		"+refs/heads/main:refs/remotes/origin/main",
	]);
	const sha =
		(watching
			? await watchedSha(env, urls)
			: full && !env.INPUT_SHA
				? env.GITHUB_SHA
				: env.INPUT_SHA) ?? "";
	if (watching && !sha) {
		appendFileSync(env.GITHUB_OUTPUT, "run=false\nsha=\nlane=deployed\n");
		return;
	}
	if (!SHA.test(sha))
		throw new Error(`An exact 40-character commit is required, got "${sha}"`);
	if (!gitIsAncestor(sha, "origin/main"))
		throw new Error(`${sha} is not on main`);
	let files = null;
	let note = "full suite";
	if (!full) {
		const reported = await readHealthShas(urls);
		const live = deployedSha(reported);
		if (!live || (live !== sha && !gitIsAncestor(sha, live)))
			throw new Error(
				`${sha} is not live: health reports ${reported.join(", ")}`,
			);
		const runs = [];
		for (let page = 1; page <= 3; page++) {
			const result = await github(
				`/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${HOSTED_WORKFLOW}/runs?status=success&per_page=100&page=${page}`,
			);
			runs.push(...result.workflow_runs);
			if (result.workflow_runs.length < 100) break;
		}
		const base = await greenBase(runs, sha, {
			runId: env.GITHUB_RUN_ID,
			testedOf: async (run) =>
				run.display_title === WATCH_TITLE
					? testedSha(
							run,
							(
								await github(
									`/repos/${env.GITHUB_REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
								)
							).jobs,
						)
					: deployedRunSha(run),
		});
		if (base) {
			files = execFileSync(
				"git",
				["diff", "--name-only", "--no-renames", "-z", base, sha, "--"],
				{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
			)
				.split("\0")
				.filter(Boolean);
			note = `affected by ${base}..${sha} (live ${live})`;
		} else note = `full suite: no passing post-deploy run before ${sha}`;
		await github(`/repos/${env.GITHUB_REPOSITORY}/statuses/${sha}`, {
			method: "POST",
			body: {
				state: "pending",
				context: STATUS_CONTEXT,
				description: "Post-deploy tests running",
				target_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
			},
		});
	}
	// The selection reads manifests and scripts at the tested commit.
	execFileSync("git", ["checkout", "--quiet", "--detach", sha]);
	const selected = laneSelection(
		suiteSelection(".", { eventName: "push", files }),
		"full",
	);
	appendFileSync(
		env.GITHUB_OUTPUT,
		`run=true\nlane=${full ? "full" : "deployed"}\nsha=${sha}\nmatrix=${JSON.stringify(selected.matrix)}\nworkspace=${selected.matrix.include.length > 0}\nrepository=${selected.repository && selected.checks.length > 0}\nchecks=${JSON.stringify(selected.checks)}\n`,
	);
	appendFileSync(
		env.GITHUB_STEP_SUMMARY,
		`${sha}: ${note}; ${selected.matrix.include.length} workspace shards; checks=${selected.checks.join(",") || "none"}; scope=${selected.scope}\n`,
	);
}

/** A completed hosted run as a repository observer CI event. */
export function hostedObservation({
	projectId,
	repository,
	run,
	jobs,
	message,
}) {
	if (
		run.path !== `.github/workflows/${HOSTED_WORKFLOW}` ||
		run.head_branch !== "main" ||
		run.head_repository?.full_name !== repository ||
		!["failure", "success"].includes(run.conclusion)
	)
		throw new Error("Not a completed main hosted-suite run");
	// A passing watch run without a tested commit found nothing newly live. A
	// failing one broke before choosing a commit; report it on its own.
	const named = testedSha(run, jobs);
	if (!named && run.conclusion === "success") return null;
	const tested = named ?? run.head_sha;
	if (!SHA.test(tested ?? ""))
		throw new Error("An exact tested commit is required");
	const deployed =
		deployedRunSha(run) !== null || run.display_title === WATCH_TITLE;
	const failed = jobs.filter((job) =>
		["failure", "timed_out", "action_required"].includes(job.conclusion),
	);
	if (run.conclusion === "failure" && !failed.length)
		throw new Error("Failed run has no failing jobs");
	return {
		projectId,
		repository,
		branch: "main",
		sha: tested,
		kind: run.conclusion === "success" ? "ci_green" : "ci_red",
		// Separate surfaces: a nightly pass must not settle a post-deploy
		// failure, and neither touches the push gate's incidents.
		surface: deployed ? "post-deploy" : "hosted-full",
		paths: [],
		commands: deployed
			? "Affected workspaces since the last passing post-deploy run: bun run test:run + type-check"
			: "Every workspace: bun run test:run + bun run type-check",
		summary:
			`${run.display_title}${named ? "" : " (failed before choosing a commit)"} at ${tested} ${run.conclusion === "success" ? "passed" : "failed"}\n${failed.map((job) => `${job.name}: ${job.conclusion} ${job.html_url}`).join("\n")}\n${message ?? ""}`.slice(
				0,
				24000,
			),
		evidenceUrl: run.html_url,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const command = process.argv[2];
	if (command === "plan") await plan();
	else throw new Error(`Unknown command: ${command}`);
}
