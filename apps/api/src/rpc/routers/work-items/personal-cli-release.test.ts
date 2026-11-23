import { execFile, execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { workItemsContractRouter } from "../work-items";
import { detachedGitEnv } from "../../../../../../scripts/oss/git-env";

const org = "11111111-1111-4111-8111-111111111111";
const workId = "22222222-2222-4222-8222-222222222222";
// Canonical human subjects are opaque strings, not agent/principal UUIDs.
const user = "UfixtureMaintainer00000000001";
const source = resolve(import.meta.dirname, "../../../../../..");
// Replay the migration ledger at collection, outside the Git case timers.
createMigratedSqlite().close();
const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const sqlite = createMigratedSqlite();
	sqlite
		.prepare(
			"INSERT INTO organizations(id,name,slug) VALUES (?,'Fixture','fixture')",
		)
		.run(org);
	sqlite
		.prepare("INSERT INTO users(id,email) VALUES (?,'maintainer@example.test')")
		.run(user);
	sqlite
		.prepare(
			"INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,role,status) VALUES ('member',?,?,'UfixtureLoginSubject','maintainer@example.test','owner','active')",
		)
		.run(org, user);
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,work_kind,work_class,purpose_exception_expires_at,acceptance_contract,admission_spec_revision,created_at) VALUES (?,?,'Release CLI 1.0.1','accepted','operations','maintenance','9999-01-01T00:00:00.000Z',?, 'release-revision',?)",
		)
		.run(
			workId,
			org,
			JSON.stringify({ version: 1, doneLooksLike: "Release CLI 1.0.1" }),
			new Date().toISOString(),
		);
	const ctx = {
		db: createDbClient(createD1Facade(sqlite)),
		env: { DB: createD1Facade(sqlite) },
		authType: "user",
		user: { sub: "UfixtureLoginSubject" },
		userId: user,
		userRole: "owner",
		organizationId: org,
		headers: new Headers(),
		url: new URL("https://api.example.test/rpc"),
		rateLimiter: { limit: async () => ({ success: true }) },
		waitUntil: () => {},
	} as unknown as BaseContext;
	return {
		sqlite,
		ctx,
		client: createRouterClient(workItemsContractRouter, { context: ctx }),
	};
}

it.each(["settled", "expired", "live"] as const)(
	"human release admission and actual disposable refs: %s",
	async (state) => {
		const f = fixture();
		const root = mkdtempSync(join(tmpdir(), "personal-cli-release-"));
		roots.push(root);
		const repo = join(root, "repo");
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
		git("config", "user.name", "Fixture Maintainer");
		git("config", "user.email", "maintainer@example.test");
		mkdirSync(join(repo, "packages/cli"), { recursive: true });
		writeFileSync(
			join(repo, "packages/cli/package.json"),
			'{"version":"1.0.0"}',
		);
		git("add", ".");
		git("commit", "-qm", "base");
		const base = git("rev-parse", "HEAD");
		git("init", "--bare", "-q", join(root, "remote.git"));
		git("remote", "add", "origin", join(root, "remote.git"));
		git("push", "-q", "origin", "HEAD:main");
		writeFileSync(
			join(repo, "packages/cli/package.json"),
			'{"version":"1.0.1"}',
		);
		git("add", ".");
		git(
			"commit",
			"-qm",
			`chore(cli): release 1.0.1\n\nWork-Item: ${workId}\nRelease-Work-Item: ${workId}\nAgent-Session: human:${workId}`,
		);
		const head = git("rev-parse", "HEAD");
		if (state === "expired") {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(Date.now() - 600_000);
		}
		const started = await f.client.startAttempt({
			id: workId,
			metadata: { cliRelease: { commitSha: head, version: "1.0.1" } },
		});
		vi.useRealTimers();
		expect(started.attempt).toMatchObject({
			executorType: "human",
			executorId: user,
			externalSessionKey: null,
		});
		if (state === "settled")
			await f.client.settleAttempt({
				id: workId,
				attemptId: started.attempt.id,
				outcome: "cancelled",
				summary: "Disposable release cancelled",
			});
		if (state === "live") {
			await f.client.heartbeatAttempt({
				id: workId,
				attemptId: started.attempt.id,
			});
			expect(() =>
				f.sqlite
					.prepare(
						"UPDATE work_attempts SET metadata=?,version=version+1 WHERE id=?",
					)
					.run(
						JSON.stringify({
							cliRelease: { commitSha: base, version: "1.0.1" },
						}),
						started.attempt.id,
					),
			).toThrow("immutable");
			for (const mismatch of [
				{ commitSha: base },
				{ version: "1.0.2" },
				{ ref: "refs/tags/cli-v1.0.2" },
			])
				await expect(
					f.client.authorizePersonalCliRelease({
						id: workId,
						commitSha: head,
						version: "1.0.1",
						ref: "refs/heads/main",
						...mismatch,
					}),
				).rejects.toThrow("exact release");
			f.sqlite.exec(
				"INSERT INTO users(id,email) VALUES ('UfixtureOtherMaintainer','other@example.test'); INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,role,status) VALUES ('other-member','11111111-1111-4111-8111-111111111111','UfixtureOtherMaintainer','another-subject','other@example.test','owner','active');",
			);
			f.ctx.userId = "UfixtureOtherMaintainer";
			f.ctx.user = { sub: "another-subject" };
			await expect(
				f.client.authorizePersonalCliRelease({
					id: workId,
					commitSha: head,
					version: "1.0.1",
					ref: "refs/heads/main",
				}),
			).rejects.toThrow("exact release");
			f.ctx.userId = user;
			f.ctx.user = { sub: "UfixtureLoginSubject" };
		}
		for (const file of [
			".githooks/pre-push",
			".githooks/pre-push-checks",
			"scripts/dev/push-gate-lock.py",
			"scripts/dev/push-authorization.ts",
			"scripts/oss/git-env.ts",
		]) {
			mkdirSync(dirname(join(repo, file)), { recursive: true });
			copyFileSync(join(source, file), join(repo, file));
		}
		mkdirSync(join(repo, "scripts/ci"), { recursive: true });
		writeFileSync(
			join(repo, "scripts/ci/preflight-gates.mjs"),
			"// Source gates are exercised in the source checkout.\n",
		);
		const hook = join(repo, ".git/hooks/pre-push");
		writeFileSync(
			hook,
			"#!/bin/sh\nexec bash .githooks/pre-push origin https://github.com/tedix-hq/tedix.git\n",
		);
		chmodSync(hook, 0o755);
		// Only CLI transport is replaced. Authorization uses the real router, membership,
		// admission, SQL guards and migrated database while Git runs the actual hook.
		const server = createServer(async (req, res) => {
			let body = "";
			for await (const chunk of req) body += chunk;
			try {
				const args = JSON.parse(body) as string[];
				const value =
					args[4] === "auth"
						? { wouldUse: "stored-login" }
						: await f.client.authorizePersonalCliRelease({
								id: args[6]!,
								...JSON.parse(args[8]!),
							});
				res.end(JSON.stringify(value));
			} catch (error) {
				res.statusCode = 403;
				res.end(String(error));
			}
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No server port");
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "tedix"),
			`#!/usr/bin/env bun\nconst r=await fetch('http://127.0.0.1:${address.port}',{method:'POST',body:JSON.stringify(process.argv.slice(2))});const body=await r.text();if(!r.ok){console.error(body);process.exit(1)}console.log(body);\n`,
		);
		chmodSync(join(bin, "tedix"), 0o755);
		const updates: Array<{
			ref: string;
			sha: string;
			allowed: boolean;
			case: string;
		}> = [
			{
				ref: "refs/heads/main",
				sha: head,
				allowed: state === "live",
				case: state,
			},
			{
				ref: "refs/tags/cli-v1.0.1",
				sha: head,
				allowed: state === "live",
				case: state,
			},
		];
		if (state === "live") {
			git(
				"commit",
				"--allow-empty",
				"-qm",
				`chore(cli): release changed candidate\n\nWork-Item: ${workId}\nRelease-Work-Item: ${workId}\nAgent-Session: human:${workId}`,
			);
			updates.unshift(
				{
					ref: "refs/heads/main",
					sha: git("rev-parse", "HEAD"),
					allowed: false,
					case: "wrong-commit",
				},
				{
					ref: "refs/tags/cli-v1.0.2",
					sha: head,
					allowed: false,
					case: "wrong-tag",
				},
			);
		}
		try {
			for (const update of updates) {
				const { ref, sha, allowed } = update;
				const remoteRef = () =>
					git("ls-remote", "origin", ref).split(/\s/)[0] || "absent";
				const before = remoteRef();
				const result = await promisify(execFile)(
					"git",
					["push", "origin", `${sha}:${ref}`],
					{
						cwd: repo,
						env: {
							...env,
							PATH: `${bin}:${env.PATH}`,
							TEDIX_PUSH_ORGANIZATION: "fixture",
							TEDIX_PUSH_WORKSPACE: "fixture",
						},
					},
				).then(
					(r) => ({ exit: 0, ...r }),
					(e) => ({ exit: e.code, stderr: String(e.stderr) }),
				);
				const after = remoteRef();
				console.info(
					JSON.stringify({
						state: update.case,
						ref,
						before,
						after,
						exit: result.exit,
						attemptId: started.attempt.id,
						authorization: result.stderr
							.split("\n")
							.filter((line) => line.startsWith("pre-push:")),
					}),
				);
				expect(result.exit).toBe(allowed ? 0 : 1);
				expect(after).toBe(allowed ? sha : before);
				expect(result.stderr).toContain(
					allowed ? "authorized personal CLI release" : "push refused",
				);
			}
		} finally {
			await new Promise<void>((done, reject) =>
				server.close((e) => (e ? reject(e) : done())),
			);
		}
	},
);

it("human release admission rejects missing targets and non-human credentials", async () => {
	const f = fixture();
	await expect(f.client.startAttempt({ id: workId })).rejects.toThrow(
		"exact cliRelease target",
	);
	f.ctx.authType = "apikey";
	await expect(
		f.client.startAttempt({
			id: workId,
			metadata: { cliRelease: { commitSha: "a".repeat(40), version: "1.0.1" } },
		}),
	).rejects.toThrow();
});
