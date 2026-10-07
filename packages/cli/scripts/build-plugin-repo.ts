/**
 * Build the public tedix-hq/tedix-plugins tree from plugins/tedix: one
 * repository, one plugin at its root, a manifest per host sharing the same
 * skills and remote MCP server. It ships no hooks; those stay in the CLI's
 * local install. A new host is one more manifest written here.
 *
 *   bun packages/cli/scripts/build-plugin-repo.ts <empty-or-existing-dir>
 */
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { packageFiles, ROOT } from "./package-plugin";

export const PLUGIN_REPOSITORY = "https://github.com/tedix-hq/tedix-plugins";
const MARKETPLACE = "tedix-plugins";

const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;
const readJson = (path: string) =>
	JSON.parse(readFileSync(join(ROOT, path), "utf8"));

export function pluginRepoFiles(): Map<string, string | Uint8Array> {
	const files = new Map<string, string | Uint8Array>(
		packageFiles({ host: "claude" }),
	);
	const claude = readJson(".claude-plugin/plugin.json");
	const codex = readJson(".codex-plugin/plugin.json");
	if (claude.version !== codex.version)
		throw new Error(
			`Claude ${claude.version} and Codex ${codex.version} manifests disagree`,
		);
	files.set(
		".claude-plugin/plugin.json",
		json({ ...claude, repository: PLUGIN_REPOSITORY }),
	);
	files.set(
		".codex-plugin/plugin.json",
		json({ ...codex, repository: PLUGIN_REPOSITORY }),
	);
	const description = claude.description as string;
	files.set(
		".claude-plugin/marketplace.json",
		json({
			name: MARKETPLACE,
			description: "The Tedix plugin for Claude Code",
			owner: { name: "Tedix", url: "https://tedix.dev" },
			plugins: [{ name: "tedix", source: "./", description }],
		}),
	);
	files.set(
		".agents/plugins/marketplace.json",
		json({
			name: MARKETPLACE,
			interface: { displayName: "Tedix" },
			plugins: [
				{
					name: "tedix",
					source: { source: "local", path: "./" },
					policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
					category: "Productivity",
				},
			],
		}),
	);
	files.set("README.md", readFileSync(join(ROOT, "repo/README.md"), "utf8"));
	files.set("LICENSE", readFileSync(resolve(ROOT, "../../LICENSE"), "utf8"));
	for (const path of files.keys()) {
		if (path.startsWith("hooks/"))
			throw new Error("The public plugin repository ships no hooks");
	}
	return files;
}

/** Replace everything except .git with a fresh build, so removed files disappear. */
export function writePluginRepo(destination: string): string[] {
	const root = resolve(destination);
	mkdirSync(root, { recursive: true });
	for (const entry of readdirSync(root)) {
		if (entry !== ".git")
			rmSync(join(root, entry), { recursive: true, force: true });
	}
	const files = pluginRepoFiles();
	for (const [path, content] of files) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return [...files.keys()].sort();
}

if (import.meta.main) {
	const destination = process.argv[2];
	if (!destination) {
		console.error("Usage: bun packages/cli/scripts/build-plugin-repo.ts <dir>");
		process.exit(2);
	}
	for (const path of writePluginRepo(destination)) console.log(path);
}
