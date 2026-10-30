import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_MANIFESTS, hostManifest } from "./plugin-manifest";
import { ROOT } from "./package-plugin";

export function syncPluginManifests(root = ROOT, check = false): void {
	const canonical = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
	const manifests = new Map<string, unknown>([
		["listing.json", canonical.extensions["com.openai"].interface],
		...Object.entries(HOST_MANIFESTS).map(
			([host, path]) =>
				[path, hostManifest(root, host as keyof typeof HOST_MANIFESTS)] as [
					string,
					unknown,
				],
		),
	]);
	const marketplacePath = "../../.claude-plugin/marketplace.json";
	if (existsSync(join(root, marketplacePath))) {
		const marketplace = JSON.parse(
			readFileSync(join(root, marketplacePath), "utf8"),
		);
		marketplace.description = canonical.description;
		marketplace.plugins[0].description = canonical.description;
		manifests.set(marketplacePath, marketplace);
	}
	for (const [path, manifest] of manifests) {
		const filename = join(root, path);
		if (check) {
			if (
				JSON.stringify(JSON.parse(readFileSync(filename, "utf8"))) !==
				JSON.stringify(manifest)
			)
				throw new Error(
					`${path} differs from plugin.json; run bun packages/cli/scripts/sync-plugin-manifests.ts`,
				);
		} else writeFileSync(filename, `${JSON.stringify(manifest, null, "\t")}\n`);
	}
}

if (import.meta.main)
	syncPluginManifests(ROOT, process.argv.includes("--check"));
