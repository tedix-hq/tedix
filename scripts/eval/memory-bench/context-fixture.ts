import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { detachedGitEnv } from "../../oss/git-env";
import { orgs } from "./fixtures";

export const sessionIds = [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
];

/** All credentials, Git roots and bindings live in this temporary fixture directory. */
export async function contextFixture(sourceRoot: string) {
	const load = (path: string) =>
		import(pathToFileURL(resolve(sourceRoot, path)).href);
	const [context, credentials] = await Promise.all([
		load("packages/cli/src/agent-context.ts"),
		load("packages/cli/src/credential-store.ts"),
	]);
	const base = mkdtempSync(join(tmpdir(), "tedix-memory-bench-"));
	const configDir = join(base, "config");
	const options = sessionIds.map((sessionId, o) => ({
		cwd: join(base, `fable-${o}`),
		configDir,
		sessionId,
		env: { CODEX_THREAD_ID: sessionId },
	}));
	try {
		for (const [o, opts] of options.entries()) {
			mkdirSync(opts.cwd);
			for (const args of [
				["init", "-b", "main"],
				["remote", "add", "origin", `https://example.invalid/fable-${o}.git`],
			])
				execFileSync("git", args, {
					cwd: opts.cwd,
					env: detachedGitEnv(),
					stdio: "pipe",
				});
			credentials.writeWorkspaceCredentials(
				`fixture-${o}`,
				{
					loginId: `fictional-owner-${o}`,
					org: orgs[o],
					mcpUrl: `https://fixture-${o}.example.invalid/mcp`,
				},
				{ configDir },
			);
			context.changeAgentContext(
				"bind",
				{ workspace: `fixture-${o}`, projectId: sessionIds[o] },
				opts,
			);
		}
		return {
			binding(o: number) {
				return context.resolveAgentContext(options[o]);
			},
			close() {
				rmSync(base, { recursive: true, force: true });
			},
		};
	} catch (error) {
		rmSync(base, { recursive: true, force: true });
		throw error;
	}
}
