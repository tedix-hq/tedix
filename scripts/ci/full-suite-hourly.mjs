import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { affectedWorkspaces } from "./preflight-test-targets.mjs";

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

const playwrightBrowsers = ["chromium", "firefox", "webkit"];
const sourceExtensions = ["", ".ts", ".tsx", ".mts", ".js", ".mjs"];

function resolveSource(from, specifier) {
	const base = resolve(dirname(from), specifier);
	for (const candidate of [
		...sourceExtensions.map((extension) => `${base}${extension}`),
		...sourceExtensions
			.slice(1)
			.map((extension) => join(base, `index${extension}`)),
	])
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	return undefined;
}

// The browsers a file launches: names imported from Playwright by the file or
// by any module it reaches through relative imports.
export function sourceBrowsers(file, seen = new Set()) {
	// A missing file fails its own job when it runs; it needs no browser.
	if (seen.has(file) || !existsSync(file)) return [];
	seen.add(file);
	const source = readFileSync(file, "utf8");
	const browsers = new Set();
	for (const [, names] of source.matchAll(
		/import\s*\{([^}]*)\}\s*from\s*["'](?:playwright|playwright-core|@playwright\/test)["']/g,
	))
		for (const name of names.split(","))
			if (playwrightBrowsers.includes(name.trim())) browsers.add(name.trim());
	for (const [, specifier] of source.matchAll(
		/(?:from\s*|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g,
	)) {
		const imported = resolveSource(file, specifier);
		if (imported)
			for (const browser of sourceBrowsers(imported, seen))
				browsers.add(browser);
	}
	return [...browsers].sort();
}

// The Playwright browsers a package script needs, from the files its
// `bun <file> [<file>...]` commands run (a runner and the specs it is given),
// following `bun run <script>` references.
export function scriptBrowsers(workspaceRoot, scripts, name, ancestors = []) {
	if (ancestors.includes(name)) throw new Error(`Cyclic test script: ${name}`);
	if (!scripts[name]) throw new Error(`Unknown script: ${name}`);
	const browsers = new Set();
	for (const command of scripts[name].split("&&").map((part) => part.trim())) {
		const reference = /^bun run ([\w:.-]+)$/.exec(command)?.[1];
		const files = /^bun (?:[\w./-]+\.(?:[mc]?[jt]sx?)(?: |$))+$/.test(command)
			? command.split(" ").slice(1)
			: [];
		const found = reference
			? scriptBrowsers(workspaceRoot, scripts, reference, [...ancestors, name])
			: files.flatMap((file) => sourceBrowsers(join(workspaceRoot, file)));
		for (const browser of found) browsers.add(browser);
	}
	return [...browsers].sort();
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
					const browsers = scriptBrowsers(
						join(root, workspace),
						scripts,
						script,
					).join(" ");
					if (!Number.isInteger(count) || count < 1)
						throw new Error(`Invalid shard count for ${workspace} ${script}`);
					for (let shard = 1; shard <= count; shard++)
						include.push({
							workspace,
							test: true,
							testScript: script,
							...(count > 1 ? { shard: `${shard}/${count}` } : {}),
							...(browsers ? { browsers } : {}),
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

// Unknown paths and shared execution/configuration inputs deliberately run all checks.
const GLOBAL_INPUT =
	/^(?:package\.json$|(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|(?:tsconfig[^/]*\.json|(?:vite|vitest)[^/]*\.config\.[^/]+)$|\.ox(?:lint|fmt)[^/]*$|\.github\/|scripts\/|packages\/api-contract\/|packages\/db\/(?:src\/schema|migrations|drizzle)(?:\/|$))/;
const DEPLOY_CONFIG =
	/(?:^|\/)(?:wrangler\.(?:jsonc?|toml)|cloudflare\.config\.[^/]+)$/;
const PROSE = /(?:^docs\/|\.mdx?$)/i;

export function suiteSelection(root, { eventName, files }) {
	const matrix = workspaceMatrix(root);
	const full = () => ({ matrix, repository: true, scope: "full" });
	if (eventName !== "push" || files === null) return full();
	if (files.some((file) => GLOBAL_INPUT.test(file) || DEPLOY_CONFIG.test(file)))
		return full();
	const source = files.filter((file) => !PROSE.test(file));
	if (!source.length)
		return { matrix: { include: [] }, repository: false, scope: "docs" };
	const manifests = new Map();
	for (const directory of ["apps", "packages"])
		for (const entry of readdirSync(join(root, directory), {
			withFileTypes: true,
		})) {
			if (!entry.isDirectory()) continue;
			const workspace = `${directory}/${entry.name}`;
			const path = join(root, workspace, "package.json");
			if (!existsSync(path)) continue;
			const manifest = JSON.parse(readFileSync(path, "utf8"));
			manifests.set(workspace, {
				name: manifest.name,
				deps: new Set(
					[
						"dependencies",
						"devDependencies",
						"peerDependencies",
						"optionalDependencies",
					].flatMap((key) => Object.keys(manifest[key] ?? {})),
				),
			});
		}
	if (
		source.some((file) => !manifests.has(file.split("/").slice(0, 2).join("/")))
	)
		return full();
	const affected = new Set(
		affectedWorkspaces(source, {
			workspaceDirs: [...manifests.keys()],
			readManifest: (workspace) => manifests.get(workspace),
			isRelevantWorkspace: () => true,
		}),
	);
	return {
		matrix: {
			include: matrix.include.filter((job) => affected.has(job.workspace)),
		},
		repository: false,
		scope: "affected",
	};
}

// Compare against a green ancestor, rather than the push parent: a docs push
// must not certify code from an earlier red or still-running push.
export async function certificationFiles({
	repository,
	sha,
	runId,
	request,
	git = (args) =>
		execFileSync("git", args, {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		}),
}) {
	const seen = new Set();
	const green = new Map();
	for (let page = 1; page <= 10; page++) {
		const result = await request(
			`/repos/${repository}/actions/workflows/full-suite-hourly.yml/runs?branch=main&per_page=100&page=${page}`,
		);
		for (const run of result.workflow_runs) {
			if (String(run.id) === String(runId) || seen.has(run.head_sha)) continue;
			seen.add(run.head_sha);
			if (
				run.status === "completed" &&
				run.conclusion === "success" &&
				run.head_branch === "main" &&
				run.head_repository?.full_name === repository
			)
				green.set(run.head_sha, run);
		}
		if (result.workflow_runs.length < 100) break;
	}
	for (const ancestor of git([
		"rev-list",
		"--first-parent",
		"--max-count=1000",
		sha,
	])
		.trim()
		.split("\n")) {
		const run = green.get(ancestor);
		if (!run) continue;
		const jobs = [];
		for (let page = 1; ; page++) {
			const result = await request(
				`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
			);
			jobs.push(...result.jobs);
			if (result.jobs.length < 100) break;
		}
		const aggregate = jobs.filter((job) => job.name === "Main CI");
		if (aggregate.length !== 1 || aggregate[0].conclusion !== "success")
			continue;
		return git([
			"diff",
			"--name-only",
			"--no-renames",
			"-z",
			ancestor,
			sha,
			"--",
		])
			.split("\0")
			.filter(Boolean);
	}
	return null;
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
	import.meta.url === pathToFileURL(process.argv[1]).href &&
	process.argv[2] === "browsers"
) {
	// node scripts/ci/full-suite-hourly.mjs browsers <workspace> <script>
	const [, , , workspace, script] = process.argv;
	const { scripts = {} } = JSON.parse(
		readFileSync(join(workspace, "package.json"), "utf8"),
	);
	console.log(
		`browsers=${scriptBrowsers(workspace, scripts, script).join(" ")}`,
	);
} else if (
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
	const files =
		env.GITHUB_EVENT_NAME === "push"
			? await certificationFiles({
					repository: env.GITHUB_REPOSITORY,
					sha: env.GITHUB_SHA,
					runId: env.GITHUB_RUN_ID,
					request: githubRequest,
				})
			: null;
	const plan = suiteSelection(".", { eventName: env.GITHUB_EVENT_NAME, files });
	appendFileSync(
		env.GITHUB_OUTPUT,
		`matrix=${JSON.stringify(plan.matrix)}\nworkspace=${plan.matrix.include.length > 0}\nrepository=${plan.repository}\nrunners=${JSON.stringify(runners)}\n`,
	);
	appendFileSync(
		env.GITHUB_STEP_SUMMARY,
		`Main ${env.GITHUB_SHA}: ${plan.matrix.include.length} workspace shards; repository=${plan.repository}; scope=${plan.scope}\n`,
	);
}
