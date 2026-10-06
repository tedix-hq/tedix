import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	commandMayPush,
	pushPublicationProof,
	scopedArtifactsPublicationRemote,
	workstationCommandWithPushPublication,
	isProtectedWorkstationPushPath,
} from "./push-publication";
const quote = (value: string) => `'${value.replace(/'/g, "'\"'\"'")}'`;
const fixtureDirectories: string[] = [];
afterEach(() => {
	for (const directory of fixtureDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "tedix-publication-test-"));
	fixtureDirectories.push(directory);
	const repo = join(directory, "repo"),
		remote = join(directory, "remote.git");
	const env = {
		...(Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) =>
					!key.startsWith("GIT_") &&
					!key.startsWith("TEDIX_COMMIT_") &&
					!key.startsWith("TEDIX_PUSH_"),
			),
		) as NodeJS.ProcessEnv),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Publication Fixture",
		GIT_AUTHOR_EMAIL: "publication-fixture@tedix.tech",
		GIT_COMMITTER_NAME: "Publication Fixture",
		GIT_COMMITTER_EMAIL: "publication-fixture@tedix.tech",
	};
	mkdirSync(repo);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: repo,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "-b", "main");
	git("init", "--bare", remote);
	writeFileSync(join(repo, "initial"), "initial\n");
	git("add", ".");
	git("commit", "-m", "initial");
	git("remote", "add", "origin", remote);
	git("push", "-u", "origin", "main");
	git("config", "tedix.preparedStartSha", git("rev-parse", "HEAD"));
	const commit = (file = "change", content = "changed\n") => {
		writeFileSync(join(repo, file), content);
		git("add", file);
		git("commit", "-m", file);
		return git("rev-parse", "HEAD");
	};
	const run = async (
		command: string,
		bypassReason?: string,
		protectedPathExemptRemote?: string,
	) => {
		const script = await workstationCommandWithPushPublication(command, {
			bypassReason,
			protectedPathExemptRemote,
		});
		const result = spawnSync("bash", ["-c", script], {
			cwd: repo,
			env,
			encoding: "utf8",
			timeout: 30000,
		});
		return { ...result, proof: pushPublicationProof(result.stdout), script };
	};
	return { directory, repo, remote, git, commit, run };
}
describe("actual Git publication observation", () => {
	it("derives an exempt remote only from admitted shell scope and an exact Artifacts path", () => {
		const input = {
			preparation: "shell" as const,
			workItemId: "work-1",
			attemptId: "attempt-1",
			repository: {
				host: `${"a".repeat(32)}.artifacts.cloudflare.net`,
				path: "/git/tedix-prod/cms-theme-tedix-landing.git",
			},
		};
		expect(scopedArtifactsPublicationRemote(input)).toBe(
			`https://${input.repository.host}${input.repository.path}`,
		);
		expect(
			scopedArtifactsPublicationRemote({ ...input, preparation: "repository" }),
		).toBeNull();
		expect(
			scopedArtifactsPublicationRemote({ ...input, attemptId: null }),
		).toBeNull();
		expect(
			scopedArtifactsPublicationRemote({
				...input,
				repository: { ...input.repository, path: "/git/other/repo.git" },
			}),
		).toBe(`https://${input.repository.host}/git/other/repo.git`);
		expect(
			scopedArtifactsPublicationRemote({
				...input,
				repository: {
					...input.repository,
					path: "/git/tedix-prod/../repo.git",
				},
			}),
		).toBeNull();
	});
	it("observes exact remote ref/source after trailing commands", async () => {
		const f = fixture(),
			sha = f.commit();
		const r = await f.run(
			"git push origin HEAD:refs/heads/feature; printf 'after push\\n'",
		);
		expect(r.status, r.stderr).toBe(0);
		expect(r.proof).toMatchObject({
			status: "pushed",
			observations: [
				{
					remote: f.remote,
					ref: "refs/heads/feature",
					sourceSha: sha,
					observedSha: sha,
					pushExitCode: 0,
					status: "observed",
				},
			],
		});
		expect(r.stdout).toContain("after push");
	});
	it("runs tests and commits before guarding a combined push command", async () => {
		const f = fixture();
		mkdirSync(join(f.repo, ".githooks"));
		writeFileSync(
			join(f.repo, ".githooks/pre-push"),
			`#!/bin/sh\ncat > ${quote(join(f.directory, "combined-hook-input"))}\n`,
			{ mode: 0o755 },
		);
		f.git("config", "tedix.workstationCheckout", "true");
		f.git("config", "core.hooksPath", ".githooks");
		expect(f.git("rev-list", "origin/main..HEAD")).toBe("");
		writeFileSync(join(f.repo, "change"), "new contribution\n");
		const result = await f.run(
			"test -s change && git add change && git diff --cached --check && git commit -m 'combined contribution' && git push origin HEAD:refs/heads/combined",
		);
		const sha = f.git("rev-parse", "HEAD");
		expect(result.status, result.stderr).toBe(0);
		expect(result.proof).toMatchObject({
			status: "pushed",
			observations: [
				{ sourceSha: sha, observedSha: sha, ref: "refs/heads/combined" },
			],
		});
		expect(readFileSync(join(f.directory, "combined-hook-input"), "utf8")).toBe(
			`HEAD ${sha} refs/heads/combined ${"0".repeat(40)}\n`,
		);
	});
	it("does not publish a masked failed push", async () => {
		const f = fixture();
		f.commit();
		writeFileSync(join(f.remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", {
			mode: 0o755,
		});
		const r = await f.run("git push origin HEAD:refs/heads/feature; true");
		expect(r.status).toBe(0);
		expect(r.proof.status).toBe("failed");
		expect(r.proof.observations[0]?.pushExitCode).not.toBe(0);
	});
	it("uses non-HEAD source, multiple refs and Git -C", async () => {
		const f = fixture(),
			sha = f.commit();
		f.git("branch", "source");
		f.commit("later");
		const r = await f.run(
			`git -C ${quote(f.repo)} push origin source:refs/heads/one source:refs/heads/two`,
		);
		expect(r.proof.status, r.stdout + r.stderr).toBe("pushed");
		expect(
			r.proof.observations.map((x) => [x.ref, x.sourceSha, x.observedSha]),
		).toEqual([
			["refs/heads/one", sha, sha],
			["refs/heads/two", sha, sha],
		]);
	});
	it("observes actual push URL independently from fetch URL", async () => {
		const f = fixture(),
			other = join(f.directory, "other.git");
		f.git("init", "--bare", other);
		f.git("remote", "set-url", "--push", "origin", other);
		f.commit();
		const r = await f.run("git push origin HEAD:refs/heads/feature");
		expect(r.proof.status).toBe("pushed");
		expect(r.proof.observations[0]?.remote).toBe(other);
	});
	it("records empty-content commits without treating diff files as hooks", async () => {
		const f = fixture();
		f.git("commit", "--allow-empty", "-m", "empty change");
		const result = await f.run("git push origin HEAD:refs/heads/empty");
		expect(result.proof.status, result.stderr).toBe("pushed");
		expect(result.proof.observations).toHaveLength(1);
		expect(result.stderr).not.toContain("No such file");
	});
	it("preserves partial per-ref results", async () => {
		const f = fixture();
		f.commit();
		writeFileSync(
			join(f.remote, "hooks/update"),
			'#!/bin/sh\n[ "$1" != refs/heads/rejected ]\n',
			{ mode: 0o755 },
		);
		const r = await f.run(
			"git push origin HEAD:refs/heads/accepted HEAD:refs/heads/rejected; true",
		);
		expect(r.proof.status).toBe("partial");
		expect(r.proof.observations.map((x) => [x.ref, x.status])).toEqual([
			["refs/heads/accepted", "observed"],
			["refs/heads/rejected", "different"],
		]);
	});
	it("distinguishes dry-run and unchanged", async () => {
		const f = fixture();
		expect((await f.run("git push origin main")).proof.status).toBe(
			"unchanged",
		);
		f.commit();
		expect(
			(await f.run("git push --dry-run origin HEAD:refs/heads/dry")).proof
				.status,
		).toBe("dry_run");
		expect(
			(await f.run("git push -qn origin HEAD:refs/heads/dry")).proof.status,
		).toBe("dry_run");
		expect(f.git("ls-remote", "origin", "refs/heads/dry")).toBe("");
	});
	it.each([
		"bash -c 'git push origin HEAD:refs/heads/feature'",
		"bash <<'SCRIPT'\ngit push origin HEAD:refs/heads/feature\nSCRIPT",
		"bash <<< 'git push origin HEAD:refs/heads/feature'",
		"env SAFE=value git push origin HEAD:refs/heads/feature",
		"command git push origin HEAD:refs/heads/feature",
		"eval 'git push origin HEAD:refs/heads/feature'",
		"exec git push origin HEAD:refs/heads/feature",
	])("observes nested or wrapped command: %s", async (command) => {
		const f = fixture();
		f.commit();
		const r = await f.run(command);
		expect(r.status, r.stderr).toBe(0);
		expect(r.proof.status, r.stdout).toBe("pushed");
	});
	it("chains canonical hook with unchanged stdin and restores hook config", async () => {
		const f = fixture(),
			sha = f.commit();
		mkdirSync(join(f.repo, ".githooks"));
		writeFileSync(
			join(f.repo, ".githooks/pre-push"),
			`#!/bin/sh\ncat > ${quote(join(f.directory, "hook-input"))}\ngit config --get core.hooksPath > ${quote(join(f.directory, "hook-config"))}\ngit config --get sample.value > ${quote(join(f.directory, "user-config"))}\nexit 23\n`,
			{ mode: 0o755 },
		);
		f.git("config", "tedix.workstationCheckout", "true");
		f.git("config", "core.hooksPath", ".githooks");
		const r = await f.run(
			"git -c sample.value=preserved push origin HEAD:refs/heads/feature",
		);
		expect(r.stderr + r.stdout).not.toContain("fatal");
		expect(readFileSync(join(f.directory, "hook-input"), "utf8")).toBe(
			`HEAD ${sha} refs/heads/feature ${"0".repeat(40)}\n`,
		);
		expect(r.proof.status).toBe("failed");
		expect(readFileSync(join(f.directory, "hook-config"), "utf8")).toBe(
			".githooks\n",
		);
		expect(readFileSync(join(f.directory, "user-config"), "utf8")).toBe(
			"preserved\n",
		);
		expect(f.git("ls-remote", "origin", "refs/heads/feature")).toBe("");
	});
	it("refuses conflicting hook configuration before any push", async () => {
		const f = fixture();
		f.commit();
		mkdirSync(join(f.repo, ".githooks"));
		writeFileSync(join(f.repo, ".githooks/pre-push"), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
		f.git("config", "tedix.workstationCheckout", "true");
		const result = await f.run(
			"git -c core.hooksPath=/dev/null push origin HEAD:refs/heads/feature",
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain(
			"TEDIX_PUSH_GUARD=conflicting_hook_override",
		);
		expect(f.git("ls-remote", "origin", "refs/heads/feature")).toBe("");
	});
	it("admits over50 changed paths", async () => {
		const f = fixture();
		for (let i = 0; i < 60; i++)
			writeFileSync(join(f.repo, `file-${i}`), "data\n");
		f.git("add", ".");
		f.git("commit", "-m", "many files");
		expect(
			(await f.run("git push origin HEAD:refs/heads/feature")).proof.status,
		).toBe("pushed");
	});
	it("checks protected actual source instead of HEAD", async () => {
		const f = fixture();
		f.commit("package.json", "{}\n");
		f.git("branch", "protected");
		f.git("switch", "-c", "safe", "origin/main");
		f.commit("safe");
		const r = await f.run("git push origin protected:refs/heads/feature");
		expect(r.stdout).toContain("TEDIX_PUSH_GUARD=protected_path");
		expect(r.proof.status).toBe("failed");
	});
	it("allows protected theme files only for the exact trusted Artifacts remote", async () => {
		const f = fixture();
		const sha = f.commit("package.json", "{}\n");
		const denied = await f.run(
			"git push origin HEAD:refs/heads/theme",
			undefined,
			`${f.remote}-other`,
		);
		expect(denied.stdout).toContain("TEDIX_PUSH_GUARD=protected_path");
		expect(f.git("ls-remote", "origin", "refs/heads/theme")).toBe("");

		const allowed = await f.run(
			"git push origin HEAD:refs/heads/theme",
			undefined,
			f.remote,
		);
		expect(allowed.status, allowed.stderr).toBe(0);
		expect(allowed.proof).toMatchObject({
			status: "pushed",
			observations: [{ sourceSha: sha, observedSha: sha }],
		});
	});
	it("protects paths with Git-quoted non-ASCII directory names", async () => {
		const f = fixture();
		mkdirSync(join(f.repo, "café"));
		f.commit("café/package.json", "{}\n");
		const result = await f.run("git push origin HEAD:refs/heads/feature");
		expect(result.stdout).toContain("TEDIX_PUSH_GUARD=protected_path");
		expect(result.proof.status).toBe("failed");
	});
	it("audited path bypass never bypasses canonical hook", async () => {
		const f = fixture();
		f.commit("package.json", "{}\n");
		mkdirSync(join(f.repo, ".githooks"));
		writeFileSync(join(f.repo, ".githooks/pre-push"), "#!/bin/sh\nexit 1\n", {
			mode: 0o755,
		});
		f.git("config", "tedix.workstationCheckout", "true");
		const r = await f.run(
			"git push origin HEAD:refs/heads/feature",
			"independent operator approval",
		);
		expect(r.stdout).toContain("TEDIX_PUSH_GUARD_BYPASS=");
		expect(r.proof.status).toBe("failed");
	});
});
describe("receipt parsing", () => {
	it("rejects retired or incomplete markers", () => {
		for (const x of [
			undefined,
			`TEDIX_PUSHED_COMMIT=${"a".repeat(40)}\n`,
			"\nTEDIX_PUBLICATION_BEGIN\n",
			"TEDIX_PUBLICATION_END\n",
		])
			expect(pushPublicationProof(x).status).toBe("unknown");
	});
	it("classifies submitted push text without parsing the shell program", () => {
		expect(commandMayPush("printf done")).toBe(false);
		expect(commandMayPush("git -C repo push origin feature")).toBe(true);
		expect(commandMayPush("g'it' p\"ush\" origin feature")).toBe(true);
	});
	it("reports visible push text that executes no push as not applicable", async () => {
		const f = fixture();
		const result = await f.run("printf 'git push origin main\\n'");
		expect(result.status, result.stderr).toBe(0);
		expect(result.proof).toEqual({
			status: "not_applicable",
			observations: [],
		});
	});
	it.each([
		"git push --force origin main",
		"git push --delete origin main",
		"git push --no-verify origin main",
		"git push origin +HEAD:refs/heads/feature",
		"git push origin :refs/heads/main",
	])(
		"rejects dangerous push arguments at execution time: %s",
		async (command) => {
			const f = fixture();
			const result = await f.run(command);
			expect(result.status).toBe(64);
			expect(result.stdout).toContain("TEDIX_PUSH_GUARD=forbidden_");
			expect(f.git("ls-remote", "origin", "refs/heads/feature")).toBe("");
		},
	);
	it("fails closed when runtime expansion hides a push", async () => {
		const f = fixture();
		const script = await workstationCommandWithPushPublication(
			"action=push; git $action origin main",
			{ allowPush: false },
		);
		const result = spawnSync("bash", ["-c", script], {
			cwd: f.repo,
			env: process.env,
			encoding: "utf8",
		});
		expect(result.status).toBe(64);
		expect(result.stdout).toContain("TEDIX_PUSH_GUARD=undeclared_push");
	});
	it("protects hook implementation", () => {
		expect(isProtectedWorkstationPushPath(".githooks/pre-push")).toBe(true);
		expect(
			isProtectedWorkstationPushPath("apps/tedi/cloudflare.config.ts"),
		).toBe(true);
		expect(
			isProtectedWorkstationPushPath(
				"apps/tedi/src/workstation/push-publication.ts",
			),
		).toBe(false);
	});
});
