import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detachedGitEnv } from "../oss/git-env.ts";
import {
	checkOverlayReferences,
	missingOverlayReferences,
} from "./ops-overlay-reference.mjs";

const sha = "a".repeat(40);
const api = "apps/api/wrangler.jsonc";
const cms = "apps/cms/cloudflare.config.ts";

test("each deployable config needs its own full, nonzero ops SHA reference", () => {
	const paths = [
		api,
		cms,
		"apps/cms/templates/tedix/wrangler.jsonc",
		"packages/db/wrangler.jsonc",
		"apps/api/src/index.ts",
	];
	expect(missingOverlayReferences(paths, `${sha} ${api}`)).toEqual(
		paths.slice(1, 4),
	);
	expect(missingOverlayReferences([api], `abc123 ${api}`)).toEqual([api]);
	expect(missingOverlayReferences([api], `${"0".repeat(40)} ${api}`)).toEqual([
		api,
	]);
	expect(
		missingOverlayReferences([api, cms], `${sha} ${api}\n${sha} ${cms}`),
	).toEqual([]);
});

test("real pushed commits fail without a trailer; unrelated commits cannot supply it", () => {
	const root = mkdtempSync(join(tmpdir(), "ops-overlay-gate-"));
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, {
			cwd: root,
			encoding: "utf8",
			env: detachedGitEnv(),
		});
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	try {
		git("init", "-q");
		git("config", "user.name", "Fixture");
		git("config", "user.email", "fixture@example.com");
		git("config", "commit.gpgsign", "false");
		git("commit", "--allow-empty", "-qm", "base");
		const base = git("rev-parse", "HEAD");
		mkdirSync(join(root, "apps/api"), { recursive: true });
		writeFileSync(join(root, api), "{}\n");
		git("add", ".");
		git("commit", "-qm", "config without overlay");
		expect(checkOverlayReferences(root, [{ base, head: "HEAD" }])).toHaveLength(
			1,
		);
		git(
			"commit",
			"--allow-empty",
			"-qm",
			`unrelated\n\nOps-Overlay: ${sha} ${api}`,
		);
		expect(checkOverlayReferences(root, [{ base, head: "HEAD" }])).toHaveLength(
			1,
		);
		const before = git("rev-parse", "HEAD");
		writeFileSync(join(root, api), '{"vars":{}}\n');
		git("add", ".");
		git("commit", "-qm", `matching config\n\nOps-Overlay: ${sha} ${api}`);
		expect(
			checkOverlayReferences(root, [{ base: before, head: "HEAD" }]),
		).toEqual([]);
		git("update-ref", "refs/remotes/origin/main", before);
		expect(
			checkOverlayReferences(root, [{ base: "0".repeat(40), head: "HEAD" }]),
		).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
