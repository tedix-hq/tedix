import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	packageFiles,
	zipStored,
} from "../../../packages/cli/scripts/package-plugin";

const output = resolve(import.meta.dir, "../out");
const product = resolve(import.meta.dir, "../../..");
const claude = packageFiles({ host: "claude" });
writeFileSync(join(output, "Tedix-Claude.zip"), zipStored(claude));

for (const host of ["claude", "codex"] as const) {
	const marketplace = join(output, "tedix-plugin", host);
	const manifest = host === "claude" ? ".claude-plugin" : ".codex-plugin";
	const catalog = host === "claude" ? ".claude-plugin" : ".agents/plugins";
	const plugin = "plugins/tedix";
	const write = (relative: string, content: Uint8Array) => {
		const file = join(marketplace, relative);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	};

	for (const [path, content] of claude) write(join(plugin, path), content);
	for (const path of [
		join(catalog, "marketplace.json"),
		join(plugin, manifest, "plugin.json"),
		join(plugin, ".mcp.json"),
	])
		write(path, readFileSync(join(product, path)));

	const hooksFile = packageFiles({
		host: host === "claude" ? "claude" : "openai",
		local: true,
	}).get("hooks/hooks.json");
	const hooks = JSON.parse(new TextDecoder().decode(hooksFile)) as {
		hooks: Record<string, { hooks: { type: string; command?: string }[] }[]>;
	};
	// Apps opened from Finder can start hooks without the shell's login PATH.
	for (const entry of Object.values(hooks.hooks).flat())
		for (const hook of entry.hooks)
			if (hook.type === "command" && hook.command)
				hook.command = 'export PATH="$PATH:$HOME/.local/bin"; ' + hook.command;
	write(
		join(plugin, "config/host-hooks.json"),
		Buffer.from(JSON.stringify(hooks, null, "\t") + "\n"),
	);
}
