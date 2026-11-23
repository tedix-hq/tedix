import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { authorizePush } from "./push-authorization";
import { detachedGitEnv } from "../oss/git-env";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const workId = "11111111-1111-4111-8111-111111111111";
const principal = "22222222-2222-4222-8222-222222222222";
const org = "33333333-3333-4333-8333-333333333333";
const session = "codex:fixture-session";

function fixture(release = false, marker = release) {
	const root = mkdtempSync(join(tmpdir(), "push-authorization-"));
	roots.push(root);
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	mkdirSync(repo);
	const env: NodeJS.ProcessEnv = {
		...detachedGitEnv(),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: "0",
	};
	delete env.GIT_CONFIG_PARAMETERS;
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: repo,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.test");
	mkdirSync(join(repo, "packages/cli"), { recursive: true });
	writeFileSync(join(repo, "packages/cli/package.json"), '{"version":"1.0.0"}');
	git("add", ".");
	git("commit", "-qm", "base");
	const base = git("rev-parse", "HEAD");
	git("init", "--bare", "-q", remote);
	git("remote", "add", "origin", remote);
	git("push", "-q", "origin", "HEAD:main");
	if (release)
		writeFileSync(
			join(repo, "packages/cli/package.json"),
			'{"version":"1.0.1"}',
		);
	else writeFileSync(join(repo, "source.txt"), "changed");
	git("add", ".");
	git(
		"commit",
		"-qm",
		`${release ? "chore(cli): release 1.0.1" : "fix behavior"}\n\nWork-Item: ${workId}\nAgent-Session: ${session}${marker ? `\nRelease-Work-Item: ${workId}` : ""}`,
	);
	const head = git("rev-parse", "HEAD");
	const auth = {
		wouldUse: "external-agent:fixture",
		externalAgent: {
			configured: true,
			key: "fixture",
			principalId: principal,
			organizationId: org,
		},
	};
	const work = {
		id: workId,
		orgId: org,
		disposition: "accepted",
		workKind: release ? "operations" : "coding",
	};
	const attempt = {
		id: "44444444-4444-4444-8444-444444444444",
		runtimeState: "running",
		outcome: null as string | null,
		finishedAt: null as string | null,
		executorType: "external_agent",
		executorId: principal,
		externalSessionKey: session,
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
	};
	const read = (args: string[]) =>
		args[0] === "auth"
			? auth
			: args[1] === "context"
				? work
				: { data: [attempt] };
	return {
		root,
		repo,
		remote,
		env,
		git,
		base,
		head,
		auth,
		work,
		attempt,
		read,
	};
}

test.each(["ordinary", "release-main", "release-tag"])(
	"actual pre-push guard on disposable refs: %s settled, expired and live",
	(path) => {
		const f = fixture(path !== "ordinary");
		const { root, repo, git, env } = f;
		for (const file of [
			".githooks/pre-push",
			".githooks/pre-push-checks",
			"scripts/dev/push-gate-lock.py",
			"scripts/dev/push-authorization.ts",
			"scripts/oss/git-env.ts",
		]) {
			mkdirSync(dirname(join(repo, file)), { recursive: true });
			copyFileSync(new URL(`../../${file}`, import.meta.url), join(repo, file));
		}
		mkdirSync(join(repo, "scripts/ci"), { recursive: true });
		writeFileSync(
			join(repo, "scripts/ci/preflight-gates.mjs"),
			`import {readFileSync,writeFileSync} from 'node:fs'; if(process.env.EXPIRE_DURING_CHECK){const f=process.env.AUTH_FIXTURE; const v=JSON.parse(readFileSync(f,'utf8'));v.attempt.expiresAt='2000-01-01T00:00:00Z';writeFileSync(f,JSON.stringify(v));}`,
		);
		const hook = join(repo, ".git/hooks/pre-push");
		writeFileSync(
			hook,
			"#!/bin/sh\nexec bash .githooks/pre-push origin https://github.com/tedix-hq/tedix.git\n",
		);
		chmodSync(hook, 0o755);
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "tedix"),
			`#!${process.execPath}\nimport {readFileSync,appendFileSync} from 'node:fs'; const args=process.argv.slice(2);appendFileSync(process.env.AUTH_CALLS,JSON.stringify({args,cwd:process.cwd()})+'\\n');const v=JSON.parse(readFileSync(process.env.AUTH_FIXTURE,'utf8'));if(v.unavailable)process.exit(1);console.log(JSON.stringify(args[4]==='auth'?v.auth:args[5]==='context'?v.work:{data:[v.attempt]}));\n`,
		);
		chmodSync(join(bin, "tedix"), 0o755);
		const data = join(root, "data.json");
		const calls = join(root, "calls.jsonl");
		const runEnv = {
			...env,
			PATH: `${bin}:${process.env.PATH}`,
			AUTH_FIXTURE: data,
			AUTH_CALLS: calls,
			TEDIX_PUSH_ORGANIZATION: "fixture-org",
			TEDIX_PUSH_WORKSPACE: "fixture-workspace",
		};
		const ref =
			path === "release-tag" ? "refs/tags/cli-v1.0.1" : "refs/heads/main";
		if (path === "release-tag") {
			// The release commit is already on main: a tag-only push still needs authority.
			git("--git-dir", f.remote, "fetch", repo, `${f.head}:refs/heads/main`);
		}
		const remoteRef = () =>
			git("ls-remote", "origin", ref).split(/\s/)[0] || "absent";
		for (const state of ["settled", "expired", "live"] as const) {
			const attempt = {
				...f.attempt,
				...(state === "settled"
					? {
							runtimeState: "finished",
							outcome: "succeeded",
							finishedAt: new Date().toISOString(),
						}
					: state === "expired"
						? { expiresAt: "2000-01-01T00:00:00Z" }
						: {}),
			};
			writeFileSync(
				data,
				JSON.stringify({ auth: f.auth, work: f.work, attempt }),
			);
			const before = remoteRef();
			const result = spawnSync("git", ["push", "origin", `${f.head}:${ref}`], {
				cwd: repo,
				env: runEnv,
				encoding: "utf8",
			});
			const after = remoteRef();
			console.info(
				JSON.stringify({
					path,
					state,
					ref,
					before,
					after,
					exit: result.status,
					authorization: result.stderr
						.split("\n")
						.filter((line) => line.startsWith("pre-push:")),
				}),
			);
			expect(result.status).toBe(state === "live" ? 0 : 1);
			expect(after).toBe(state === "live" ? f.head : before);
			expect(result.stderr).toContain(
				state === "live" ? "authorized" : "live matching Work Attempt",
			);
		}
		const logged = readFileSync(calls, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(
			logged.every(
				(call) =>
					call.args.slice(0, 4).join(" ") ===
					"--organization fixture-org --workspace fixture-workspace",
			),
		).toBe(true);
		expect(logged.every((call) => call.cwd !== repo)).toBe(true);
		// A lease that expires while checks run refuses a subsequent candidate.
		if (path === "ordinary") {
			git(
				"commit",
				"--allow-empty",
				"-qm",
				`next\n\nWork-Item: ${workId}\nAgent-Session: ${session}`,
			);
			writeFileSync(
				data,
				JSON.stringify({ auth: f.auth, work: f.work, attempt: f.attempt }),
			);
			const result = spawnSync("git", ["push", "origin", "HEAD:main"], {
				cwd: repo,
				env: { ...runEnv, EXPIRE_DURING_CHECK: "1" },
				encoding: "utf8",
			});
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("live matching Work Attempt");
			expect(remoteRef()).toBe(f.head);
		}
	},
);

test("wrong Work, organization, holder or session cannot authorize a commit", () => {
	const f = fixture();
	const update = [{ ref: "refs/heads/main", before: f.base, after: f.head }];
	for (const [target, key, value] of [
		[f.work, "id", principal],
		[f.work, "orgId", principal],
		[f.work, "disposition", "completed"],
		[f.attempt, "externalSessionKey", "codex:other"],
		[f.attempt, "executorId", org],
		[f.attempt, "outcome", "succeeded"],
		[f.attempt, "expiresAt", "invalid"],
	] as const) {
		const object = target as Record<string, unknown>;
		const old = object[key];
		object[key] = value;
		expect(() => authorizePush(f.repo, update, f.read)).toThrow(
			"live matching",
		);
		object[key] = old;
	}
	expect(() =>
		authorizePush(f.repo, update, () => {
			throw new Error("unavailable");
		}),
	).toThrow("unavailable");
	expect(() =>
		authorizePush(f.repo, update, (args) =>
			args[1] === "attempts" ? { data: [] } : f.read(args),
		),
	).toThrow("no current Attempt");
	f.auth.wouldUse = "stored-login:fixture";
	expect(() => authorizePush(f.repo, update, f.read)).toThrow(
		"external-agent credentials",
	);
});

test("CLI release Work and marker are required for version commits and tags", () => {
	const f = fixture(true, false);
	for (const ref of ["refs/heads/main", "refs/tags/cli-v1.0.1"]) {
		expect(() =>
			authorizePush(
				f.repo,
				[
					{
						ref,
						before: ref.includes("tags") ? "0".repeat(40) : f.base,
						after: f.head,
					},
				],
				f.read,
			),
		).toThrow("Release-Work-Item");
	}
	const marked = fixture(true);
	marked.work.workKind = "coding";
	expect(() =>
		authorizePush(
			marked.repo,
			[{ ref: "refs/heads/main", before: marked.base, after: marked.head }],
			marked.read,
		),
	).toThrow("dedicated operations Work");
	expect(() =>
		authorizePush(
			marked.repo,
			[
				{
					ref: "refs/tags/cli-v1.0.1",
					before: marked.base,
					after: marked.head,
				},
			],
			marked.read,
		),
	).toThrow("rewriting release tags");
	expect(() =>
		authorizePush(
			marked.repo,
			[{ ref: "refs/heads/main", before: marked.head, after: "0".repeat(40) }],
			marked.read,
		),
	).toThrow("deleting published refs");
});
