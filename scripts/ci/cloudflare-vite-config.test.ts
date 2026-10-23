import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(import.meta.dir));
const appsDir = join(repoRoot, "apps");

describe("Cloudflare Vite configuration", () => {
	test("uses Vite plugin v2 for cloudflare.config.ts apps", () => {
		const packageJson = JSON.parse(
			readFileSync(join(repoRoot, "package.json"), "utf8"),
		) as { catalog?: Record<string, string> };
		expect(packageJson.catalog?.["@cloudflare/vite-plugin"]).toMatch(/^2\./);
	});

	test("does not opt cloudflare.config.ts apps into the removed v1 API", () => {
		const legacyConfigs = readdirSync(appsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(appsDir, entry.name))
			.filter((appDir) => existsSync(join(appDir, "cloudflare.config.ts")))
			.filter((appDir) => {
				const viteConfig = join(appDir, "vite.config.ts");
				return (
					!existsSync(viteConfig) ||
					/newConfig|cfBuildOutput/.test(readFileSync(viteConfig, "utf8"))
				);
			})
			.map((appDir) => appDir.slice(repoRoot.length + 1));

		expect(legacyConfigs).toEqual([]);
	});
});
