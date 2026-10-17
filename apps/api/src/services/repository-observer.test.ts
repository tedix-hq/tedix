import { describe, expect, it } from "vite-plus/test";
import { observerId, repairPathsAllowed } from "./repository-observer";
describe("repository observer safety", () => {
	it("keeps idempotency tenant-bound and stable across deliveries", async () => {
		expect(await observerId("org-a:repo:sha:surface")).toBe(
			await observerId("org-a:repo:sha:surface"),
		);
		expect(await observerId("org-a:repo:sha:surface")).not.toBe(
			await observerId("org-b:repo:sha:surface"),
		);
	});
	it("uses the shared matcher and excludes secrets, traversal and production configuration", () => {
		expect(repairPathsAllowed(["docs/public/a.md"], ["docs/**/*.md"])).toBe(
			true,
		);
		for (const path of [
			"../docs/a.md",
			"/docs/a.md",
			"docs/../secrets/token",
			".env",
			".env.local",
			".dev.vars",
			"secrets/token",
			"configuration/production-overlay.json",
			"apps/api/wrangler.jsonc",
			"apps/os/cloudflare.config.ts",
			"apps/api/src/a.ts",
		])
			expect(repairPathsAllowed([path], ["docs/**/*.md"])).toBe(false);
		for (const path of [
			".env",
			"secrets/token",
			"configuration/production-overlay.json",
			"apps/api/wrangler.jsonc",
			".github/workflows/deploy.yml",
			"packages/db/drizzle/change/migration.sql",
			"config/private.pem",
		])
			expect(repairPathsAllowed([path], ["**"])).toBe(false);
	});
});
