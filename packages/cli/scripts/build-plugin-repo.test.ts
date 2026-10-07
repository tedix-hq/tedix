import { describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PLUGIN_REPOSITORY,
	pluginRepoFiles,
	writePluginRepo,
} from "./build-plugin-repo";

const text = (value: string | Uint8Array | undefined) =>
	typeof value === "string" ? value : new TextDecoder().decode(value);

describe("public plugin repository", () => {
	const files = pluginRepoFiles();

	test("ships one plugin for every host and no hooks", () => {
		for (const path of [
			".claude-plugin/plugin.json",
			".claude-plugin/marketplace.json",
			".codex-plugin/plugin.json",
			".agents/plugins/marketplace.json",
			".mcp.json",
			"README.md",
			"LICENSE",
		])
			expect(files.has(path)).toBe(true);
		expect([...files.keys()].some((path) => path.startsWith("hooks/"))).toBe(
			false,
		);
		expect([...files.keys()].some((path) => path.startsWith("skills/"))).toBe(
			true,
		);
	});

	test("manifests agree on version and point at the plugin repository", () => {
		const claude = JSON.parse(text(files.get(".claude-plugin/plugin.json")));
		const codex = JSON.parse(text(files.get(".codex-plugin/plugin.json")));
		expect(claude.version).toBe(codex.version);
		expect(claude.repository).toBe(PLUGIN_REPOSITORY);
		expect(codex.repository).toBe(PLUGIN_REPOSITORY);
	});

	test("both marketplaces install the root plugin", () => {
		const claude = JSON.parse(
			text(files.get(".claude-plugin/marketplace.json")),
		);
		const codex = JSON.parse(
			text(files.get(".agents/plugins/marketplace.json")),
		);
		expect(claude.plugins).toEqual([
			expect.objectContaining({ name: "tedix", source: "./" }),
		]);
		expect(codex.plugins[0].source).toEqual({ source: "local", path: "./" });
		const mcp = JSON.parse(text(files.get(".mcp.json")));
		expect(mcp.mcpServers.tedix).toMatchObject({
			type: "http",
			url: "https://connect.mcp.tedix.dev/mcp",
		});
	});

	test("a rebuild removes files that are no longer published", () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-plugin-repo-"));
		try {
			writeFileSync(join(dir, "stale.txt"), "old");
			writePluginRepo(dir);
			expect(existsSync(join(dir, "stale.txt"))).toBe(false);
			expect(readFileSync(join(dir, "README.md"), "utf8")).toContain(
				"tedix-hq/tedix-plugins",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
