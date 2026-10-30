import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HOST_MANIFESTS = {
	claude: ".claude-plugin/plugin.json",
	codex: ".codex-plugin/plugin.json",
	devin: ".devin-plugin/plugin.json",
} as const;

export function hostManifest(root: string, host: keyof typeof HOST_MANIFESTS) {
	const canonical = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
	const manifest = JSON.parse(
		readFileSync(join(root, HOST_MANIFESTS[host]), "utf8"),
	);
	for (const key of [
		"name",
		"version",
		"description",
		"author",
		"homepage",
		"repository",
		"license",
		"keywords",
	])
		manifest[key] = canonical[key];
	const { interface: listing, ...extension } =
		canonical.extensions["com.openai"];
	if (host === "codex") {
		manifest.interface = listing;
		manifest.extensions = { "com.openai": extension };
	}
	if (host === "devin") {
		manifest.displayName = listing.displayName;
		manifest.shortDescription = listing.shortDescription;
		manifest.logo = listing.logo.replace(/^\.\//, "");
		const mcp = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8"));
		manifest.mcpServers.tedix.url = mcp.mcpServers.tedix.url;
	}
	return manifest;
}
