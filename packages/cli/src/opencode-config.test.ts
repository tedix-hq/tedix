import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mergeOpencodeConfig,
	opencodePluginEntry,
	opencodeStatus,
	setupOpencode,
} from "./opencode-config";

const ENTRY = "/data/tedix/plugins/opencode/.opencode-plugin";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "tedix-opencode-"));
	roots.push(root);
	return {
		XDG_CONFIG_HOME: join(root, "config"),
		TEDIX_CONFIG_DIR: join(root, "tedix"),
		PATH: "",
	} as NodeJS.ProcessEnv;
}

async function fakePlugin(target: string, version = "0.2.15") {
	mkdirSync(join(target, ".opencode-plugin"), { recursive: true });
	mkdirSync(join(target, "skills"));
	writeFileSync(join(target, ".opencode-plugin/index.js"), "export default {}");
	writeFileSync(join(target, "plugin.json"), JSON.stringify({ version }));
	writeFileSync(join(target, "mcp.json"), "{}");
}

describe("mergeOpencodeConfig", () => {
	it("replaces an earlier Tedix plugin, keeps its options, comments and other plugins", () => {
		const text = `{
  // my model
  "model": "azure/gpt",
  "plugin": [
    "other-plugin",
    ["/Users/a/.local/share/tedix/plugins/tedix-0.2.12/.opencode-plugin", { "hooks": false }],
    "/Users/a/tedix/plugins/tedix/.opencode-plugin/tedix.js"
  ]
}
`;
		const next = mergeOpencodeConfig(text, ENTRY);
		expect(next).toContain("// my model");
		expect(JSON.parse(next.replace(/\/\/.*$/m, ""))).toEqual({
			model: "azure/gpt",
			plugin: ["other-plugin", [ENTRY, { hooks: false }]],
		});
		expect(mergeOpencodeConfig(next, ENTRY)).toBe(next);
	});

	it("creates settings when there are none and refuses a malformed file", () => {
		expect(JSON.parse(mergeOpencodeConfig("", ENTRY)).plugin).toEqual([ENTRY]);
		expect(() => mergeOpencodeConfig("[1]", ENTRY)).toThrow("not changed");
		expect(() => mergeOpencodeConfig('{"plugin": "x"}', ENTRY)).toThrow(
			"not changed",
		);
	});
});

describe("setupOpencode", () => {
	it("backs up changed settings once and reports the plugin as current", async () => {
		const env = sandbox();
		const directory = join(env.XDG_CONFIG_HOME!, "opencode");
		mkdirSync(directory, { recursive: true });
		const original =
			'{\n  // keep\n  "plugin": ["/old/tedix/.opencode-plugin"]\n}\n';
		writeFileSync(join(directory, "opencode.jsonc"), original);

		const first = await setupOpencode(env, (target) => fakePlugin(target));
		expect(first.configPath).toBe(join(directory, "opencode.jsonc"));
		expect(readFileSync(first.backup!, "utf8")).toBe(original);
		expect(readFileSync(first.configPath, "utf8")).toContain(
			opencodePluginEntry(env),
		);
		expect(opencodeStatus(env)).toMatchObject({
			installed: true,
			current: true,
			version: "0.2.15",
		});

		const second = await setupOpencode(env, (target) =>
			fakePlugin(target, "0.2.16"),
		);
		expect(second.backup).toBeUndefined();
		expect(
			readdirSync(directory).filter((name) => name.includes(".bak-")),
		).toHaveLength(1);
		expect(opencodeStatus(env).version).toBe("0.2.16");
	});

	it("leaves the previous plugin and settings alone when a download is incomplete", async () => {
		const env = sandbox();
		await setupOpencode(env, (target) => fakePlugin(target));
		const settings = join(env.XDG_CONFIG_HOME!, "opencode", "opencode.json");
		const before = readFileSync(settings, "utf8");
		await expect(
			setupOpencode(env, async (target) => {
				mkdirSync(join(target, "skills"));
			}),
		).rejects.toThrow("nothing was changed");
		expect(existsSync(join(opencodePluginEntry(env), "index.js"))).toBe(true);
		expect(readFileSync(settings, "utf8")).toBe(before);
	});
});
