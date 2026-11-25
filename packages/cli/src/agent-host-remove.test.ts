import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	pruneTedixHooks,
	removeFromDevin,
	removeFromOpencode,
	removeTedix,
} from "./agent-host-remove";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const folder = () => {
	const root = mkdtempSync(join(tmpdir(), "tedix-remove-"));
	roots.push(root);
	return root;
};
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("removing Tedix from an agent", () => {
	it("takes only Tedix's hooks out of a hooks file and keeps the person's own", () => {
		const path = join(folder(), "hooks.json");
		writeFileSync(
			path,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command: "/Users/a/.local/bin/tedix hooks session-start",
								},
							],
						},
					],
					Stop: [
						{
							hooks: [
								{ type: "command", command: "tedix hooks capture-stop" },
								{ type: "command", command: "say done" },
							],
						},
					],
				},
				other: true,
			}),
		);
		expect(pruneTedixHooks(path)).toBe(true);
		expect(json(path)).toEqual({
			hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
			other: true,
		});
		expect(pruneTedixHooks(path)).toBe(false);
	});

	it("removes Codex's Tedix sign-in, plugins, marketplaces and hooks", () => {
		const home = folder();
		writeFileSync(
			join(home, "config.toml"),
			'[marketplaces.tedix-plugins]\nsource = "x"\n\n[plugins."tedix@tedix-plugins"]\nenabled = true\n',
		);
		mkdirSync(join(home, "plugins", "cache", "tedix-plugins"), {
			recursive: true,
		});
		writeFileSync(
			join(home, "hooks.json"),
			JSON.stringify({
				hooks: { Stop: [{ hooks: [{ command: "tedix hooks status" }] }] },
			}),
		);
		const calls: string[] = [];
		const done = removeTedix(
			"codex",
			(command, args) => {
				calls.push(`${command} ${args.join(" ")}`);
				// Like Codex, every command answers success.
				return { status: 0, stdout: "", stderr: "" };
			},
			{ CODEX_HOME: home },
		);
		expect(calls[0]).toStartWith("codex mcp logout tedix");
		expect(calls).toContain("codex plugin remove tedix@tedix-plugins");
		expect(calls).toContain("codex plugin marketplace remove tedix-plugins");
		expect(done).toEqual([
			"signed Codex out of Tedix",
			"removed the Tedix plugin (tedix@tedix-plugins)",
			"removed the tedix-plugins marketplace",
			"removed the Tedix hooks from hooks.json",
		]);
		expect(calls).not.toContain("codex plugin remove tedix@tedix-repo");
		expect(json(join(home, "hooks.json"))).toEqual({ hooks: {} });
		expect(existsSync(join(home, "plugins", "cache", "tedix-plugins"))).toBe(
			false,
		);
	});

	it("leaves a Claude plugin synced from the account alone", () => {
		const calls: string[] = [];
		removeTedix("claude", (command, args) => {
			calls.push(args.join(" "));
			return args[1] === "list"
				? {
						status: 0,
						stdout: JSON.stringify([
							{ id: "tedix@tedix" },
							{ id: "tedix@synced" },
							{ id: "other@tedix" },
						]),
						stderr: "",
					}
				: { status: 0, stdout: "", stderr: "" };
		});
		expect(calls).toContain("plugin uninstall tedix@tedix");
		expect(calls.join("\n")).not.toContain("tedix@synced");
		expect(calls.join("\n")).not.toContain("other@tedix");
	});

	it("keeps Devin's other servers and hooks", () => {
		const directory = folder();
		writeFileSync(
			join(directory, "mcp_config.json"),
			JSON.stringify({
				mcpServers: { tedix: { url: "x" }, other: { url: "y" } },
			}),
		);
		writeFileSync(
			join(directory, "config.json"),
			JSON.stringify({
				attribution: false,
				hooks: {
					Stop: [
						{
							hooks: [
								{
									command:
										"tedix hooks capture-stop --host devin || true # tedix-managed-devin-hook",
								},
							],
						},
						{ hooks: [{ command: "echo mine" }] },
					],
				},
			}),
		);
		expect(removeFromDevin(directory)).toEqual([
			"removed the Tedix connection",
			"removed the Tedix hooks",
		]);
		expect(json(join(directory, "mcp_config.json"))).toEqual({
			mcpServers: { other: { url: "y" } },
		});
		expect(json(join(directory, "config.json"))).toEqual({
			attribution: false,
			hooks: { Stop: [{ hooks: [{ command: "echo mine" }] }] },
		});
	});

	it("keeps OpenCode's comments and other plugins, and deletes the Tedix copy", () => {
		const root = folder();
		const env = {
			XDG_CONFIG_HOME: join(root, "config"),
			TEDIX_CONFIG_DIR: join(root, "tedix"),
		} as NodeJS.ProcessEnv;
		mkdirSync(join(root, "config", "opencode"), { recursive: true });
		mkdirSync(join(root, "tedix", "plugins", "opencode"), { recursive: true });
		const path = join(root, "config", "opencode", "opencode.jsonc");
		writeFileSync(
			path,
			`{\n  // my settings\n  "plugin": ["other-plugin", "${join(root, "tedix", "plugins", "opencode", ".opencode-plugin")}"]\n}\n`,
		);
		expect(removeFromOpencode(env)).toEqual([
			"removed the Tedix plugin from opencode.jsonc",
			"deleted the Tedix plugin copy",
		]);
		const text = readFileSync(path, "utf8");
		expect(text).toContain("// my settings");
		expect(text).toContain("other-plugin");
		expect(text).not.toContain(".opencode-plugin");
		expect(existsSync(join(root, "tedix", "plugins", "opencode"))).toBe(false);
	});
});
