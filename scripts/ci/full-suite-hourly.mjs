import { readdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function testScriptShards(scripts, name, ancestors = []) {
	if (ancestors.includes(name)) throw new Error(`Cyclic test script: ${name}`);
	const references = scripts[name]
		.split("&&")
		.map((command) => /^bun run ([\w:.-]+)$/.exec(command.trim())?.[1]);
	if (references.some((reference) => !reference || !scripts[reference]))
		return [name];
	return references.flatMap((reference) =>
		testScriptShards(scripts, reference, [...ancestors, name]),
	);
}

export function workspaceMatrix(root = ".") {
	const include = [];
	for (const directory of ["apps", "packages"]) {
		for (const entry of readdirSync(join(root, directory), {
			withFileTypes: true,
		})) {
			if (!entry.isDirectory()) continue;
			const workspace = `${directory}/${entry.name}`;
			let manifest;
			try {
				manifest = readFileSync(join(root, workspace, "package.json"), "utf8");
			} catch (error) {
				if (error.code === "ENOENT") continue;
				throw error;
			}
			const { scripts = {}, tedixCi } = JSON.parse(manifest);
			if (!scripts["test:run"] && !scripts["test:ci"] && !scripts["type-check"])
				continue;
			const testScript = scripts["test:ci"] ? "test:ci" : "test:run";
			if (tedixCi?.splitTestScripts && scripts[testScript]) {
				for (const [index, script] of testScriptShards(
					scripts,
					testScript,
				).entries()) {
					const count = tedixCi.testScriptShards?.[script] ?? 1;
					if (!Number.isInteger(count) || count < 1)
						throw new Error(`Invalid shard count for ${workspace} ${script}`);
					for (let shard = 1; shard <= count; shard++)
						include.push({
							workspace,
							test: true,
							testScript: script,
							...(count > 1 ? { shard: `${shard}/${count}` } : {}),
							types: index === 0 && shard === 1 && !!scripts["type-check"],
						});
				}
				continue;
			}
			include.push({
				workspace,
				test: !!(scripts["test:ci"] || scripts["test:run"]),
				types: !!scripts["type-check"],
			});
		}
	}
	if (!include.length) throw new Error("No workspace checks discovered");
	return {
		include: include.sort((a, b) => a.workspace.localeCompare(b.workspace)),
	};
}

export async function alreadyPassed({ repository, sha, runId, request }) {
	for (let page = 1; ; page++) {
		const result = await request(
			`/repos/${repository}/actions/workflows/full-suite-hourly.yml/runs?branch=main&head_sha=${sha}&per_page=100&page=${page}`,
		);
		const previous = result.workflow_runs.find(
			(run) => run.head_sha === sha && String(run.id) !== String(runId),
		);
		if (previous) return previous.conclusion === "success";
		if (result.workflow_runs.length < 100) return false;
	}
}

export function ciObservation({ projectId, repository, run, jobs }) {
	if (
		run.path !== ".github/workflows/full-suite-hourly.yml" ||
		run.head_branch !== "main" ||
		run.head_repository?.full_name !== repository ||
		run.conclusion !== "failure"
	)
		throw new Error("Not a failed main full-suite run");
	if (!/^[a-f0-9]{40}$/.test(run.head_sha))
		throw new Error("An exact commit is required");
	const failed = jobs.filter((job) =>
		["failure", "timed_out", "action_required"].includes(job.conclusion),
	);
	if (!failed.length) throw new Error("Failed run has no failing jobs");
	return {
		projectId,
		repository,
		branch: "main",
		sha: run.head_sha,
		kind: "ci_red",
		surface: "full-suite-hourly",
		paths: [],
		commands: "Every workspace: bun run test:run + bun run type-check",
		summary:
			`Full suite failed at ${run.head_sha}\n${failed.map((job) => `${job.name}: ${job.conclusion} ${job.html_url}`).join("\n")}`.slice(
				0,
				24000,
			),
		evidenceUrl: run.html_url,
	};
}

export async function githubRequest(path, env = process.env) {
	const response = await fetch(
		`${env.GITHUB_API_URL || "https://api.github.com"}${path}`,
		{
			headers: {
				Authorization: `Bearer ${env.GITHUB_TOKEN}`,
				Accept: "application/vnd.github+json",
			},
		},
	);
	if (!response.ok)
		throw new Error(`GitHub request failed (${response.status})`);
	return response.json();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const env = process.env;
	const runners = JSON.parse(
		env.FULL_SUITE_RUNNER_LABELS || '["ubuntu-latest"]',
	);
	if (
		!Array.isArray(runners) ||
		!runners.length ||
		runners.some((label) => typeof label !== "string" || !label.trim())
	)
		throw new Error(
			"FULL_SUITE_RUNNER_LABELS must be a nonempty JSON array of runner labels",
		);
	const skip = await alreadyPassed({
		repository: env.GITHUB_REPOSITORY,
		sha: env.GITHUB_SHA,
		runId: env.GITHUB_RUN_ID,
		request: githubRequest,
	});
	appendFileSync(
		env.GITHUB_OUTPUT,
		`skip=${skip}\nmatrix=${JSON.stringify(workspaceMatrix())}\nrunners=${JSON.stringify(runners)}\n`,
	);
	appendFileSync(
		env.GITHUB_STEP_SUMMARY,
		`${skip ? "Already passed; skipping" : "Testing"} main ${env.GITHUB_SHA}\n`,
	);
}
