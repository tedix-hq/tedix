#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ciObservation, githubRequest } from "./full-suite-hourly.mjs";

const git = (...args) =>
	execFileSync("git", args, { encoding: "utf8", maxBuffer: 2_000_000 }).trim();
export function pushObservation(
	{ projectId, repository, branch, sha, before, runUrl },
	runGit = git,
) {
	if (!/^[0-9a-f]{40}$/.test(sha))
		throw new Error("An exact commit is required");
	const base =
		/^[0-9a-f]{40}$/.test(before ?? "") && !/^0+$/.test(before)
			? before
			: `${sha}^`;
	const paths = runGit("diff", "--name-only", base, sha)
		.split("\n")
		.filter(Boolean);
	const message = runGit("show", "-s", "--format=%B", sha);
	// Lets the request tracker find a commit that a multi-commit push carried.
	const commitShas = runGit("rev-list", "--max-count=100", `${base}..${sha}`)
		.split("\n")
		.filter((line) => /^[0-9a-f]{40}$/.test(line));
	const repair = message.match(
		/^Repair-Observation:\s*([0-9a-f-]{36})\s*$/m,
	)?.[1];
	const work = message.match(/^Work-Item:\s*([0-9a-f-]{36})\s*$/m)?.[1];
	return {
		projectId,
		repository,
		branch,
		sha,
		...(/^[0-9a-f]{40}$/.test(before ?? "") && !/^0+$/.test(before)
			? { beforeSha: before }
			: {}),
		kind: "push",
		...(commitShas.length ? { commitShas } : {}),
		surface: "all",
		paths: paths.slice(0, 500),
		commands: "",
		summary: [
			runGit("diff", "--stat", base, sha),
			message,
			paths.length > 500 ? `Paths truncated: ${paths.length}` : "",
		]
			.join("\n")
			.slice(0, 24000),
		evidenceUrl: runUrl,
		...(work ? { workItemId: work } : {}),
		...(repair ? { repairObservationId: repair } : {}),
	};
}
/** @param {string} url
 * @param {unknown} payload
 * @param {{env?: Record<string,string|undefined>,fetcher?: (url: URL, init: RequestInit) => Promise<Response>}} options
 */
export async function notifyObserver(
	url,
	payload,
	{ env = process.env, fetcher = fetch } = {},
) {
	const target = new URL(url);
	if (target.protocol !== "https:") throw new Error("Observer requires HTTPS");
	const oidc = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
	oidc.searchParams.set("audience", "tedix:repository-observer");
	const tokenResponse = await fetcher(oidc, {
		headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
		redirect: "error",
	});
	if (!tokenResponse.ok)
		throw new Error(`OIDC request failed (${tokenResponse.status})`);
	const { value } = await tokenResponse.json();
	if (typeof value !== "string") throw new Error("OIDC response missing token");
	const response = await fetcher(target, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${value}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
		redirect: "error",
	});
	if (!response.ok)
		throw new Error(`Observer rejected event (${response.status})`);
	return response.json();
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const env = process.env;
	const url = env.TEDIX_OBSERVER_URL;
	if (!url) throw new Error("TEDIX_OBSERVER_URL required");
	const projectId = new URL(url).pathname.split("/").at(-1);
	const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
	let payload;
	if (env.GITHUB_EVENT_NAME === "workflow_run") {
		const run = event.workflow_run;
		const tip = await githubRequest(
			`/repos/${env.GITHUB_REPOSITORY}/commits/main`,
		);
		if (tip.sha !== run.head_sha) {
			console.log("Superseded red tip; no new incident");
			process.exit(0);
		}
		const jobs = [];
		for (let page = 1; ; page++) {
			const result = await githubRequest(
				`/repos/${env.GITHUB_REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
			);
			jobs.push(...result.jobs);
			if (result.jobs.length < 100) break;
		}
		payload = ciObservation({
			projectId,
			repository: env.GITHUB_REPOSITORY,
			run,
			jobs,
		});
		const message = git("show", "-s", "--format=%B", run.head_sha);
		const work = message.match(/^Work-Item:\s*([0-9a-f-]{36})\s*$/m)?.[1];
		if (work) payload.workItemId = work;
		payload.summary =
			`${payload.summary}\nPushing lane Work: ${work ?? "not recorded"}\n${message}`.slice(
				0,
				24000,
			);
	} else {
		payload = pushObservation({
			projectId,
			repository: env.GITHUB_REPOSITORY,
			branch: env.GITHUB_REF_NAME,
			sha: env.GITHUB_SHA,
			before: event.before,
			runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
		});
	}
	const receipt = await notifyObserver(url, payload);
	console.log(JSON.stringify(receipt));
}
