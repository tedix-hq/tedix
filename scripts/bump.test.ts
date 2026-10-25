import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CMS_TEMPLATE_SLUGS } from "../packages/api-contract/src/schemas/cms-template";
import { detachedGitEnv } from "./oss/git-env";

for (const mode of ["--check", "--verify"]) {
	test(`bump ${mode} covers every canonical CMS scaffold`, () => {
		const fixture = mkdtempSync(join(tmpdir(), "tedix-bump-test-"));
		const cwd = join(fixture, "repo");
		const bin = join(fixture, "bin");
		const callsFile = join(fixture, "calls.jsonl");
		const env = detachedGitEnv({
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			PATH: `${bin}:${process.env.PATH}`,
			BUMP_TEST_COMMANDS: callsFile,
		});
		let logs: string | undefined;
		try {
			mkdirSync(cwd);
			mkdirSync(bin);
			writeFileSync(join(cwd, "package.json"), "{}\n");
			for (const slug of CMS_TEMPLATE_SLUGS) {
				const directory = join(cwd, "apps/cms/templates", slug);
				mkdirSync(directory, { recursive: true });
				writeFileSync(
					join(directory, "package.json"),
					JSON.stringify({ name: `fixture-${slug}` }),
				);
			}
			for (const command of ["bunx", "bun"]) {
				const path = join(bin, command);
				writeFileSync(
					path,
					`#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.BUMP_TEST_COMMANDS, JSON.stringify([${JSON.stringify(command)}, ...process.argv.slice(2)]) + "\\n");\nconsole.log("{}");\n`,
				);
				chmodSync(path, 0o755);
			}
			for (const args of [
				["init", "--quiet"],
				["add", "."],
				[
					"-c",
					"user.name=Fixture",
					"-c",
					"user.email=fixture@example.com",
					"-c",
					"core.hooksPath=/dev/null",
					"commit",
					"--quiet",
					"-m",
					"Fixture",
				],
			]) {
				const git = spawnSync("git", args, { cwd, env, encoding: "utf8" });
				expect(git.status, git.stderr).toBe(0);
			}
			const result = spawnSync(
				process.execPath,
				[join(import.meta.dir, "bump.ts"), mode],
				{ cwd, env, encoding: "utf8", timeout: 10_000 },
			);
			logs = result.stdout.match(/bump: logs and result: (.+)/)?.[1];
			expect(result.status, result.stderr || result.stdout).toBe(0);
			const calls = readFileSync(callsFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			const templateCalls =
				mode === "--check"
					? calls.filter((call) => call.includes("--packageFile"))
					: calls.filter(
							(call) =>
								call[0] === "bun" &&
								call[1] === "install" &&
								call.includes("--cwd"),
						);
			const paths = templateCalls.map((call) => {
				const flag = mode === "--check" ? "--packageFile" : "--cwd";
				return call[call.indexOf(flag) + 1];
			});
			expect(paths).toEqual(
				CMS_TEMPLATE_SLUGS.map(
					(slug) =>
						`apps/cms/templates/${slug}${mode === "--check" ? "/package.json" : ""}`,
				),
			);
			if (mode === "--check") {
				expect(calls.every((call) => call[0] === "bunx")).toBe(true);
				expect(calls.some((call) => call.includes("--upgrade"))).toBe(false);
			}
			expect(
				spawnSync("git", ["status", "--porcelain"], {
					cwd,
					env,
					encoding: "utf8",
				}).stdout,
			).toBe("");
		} finally {
			if (logs) rmSync(logs, { recursive: true, force: true });
			rmSync(fixture, { recursive: true, force: true });
		}
	});
}
