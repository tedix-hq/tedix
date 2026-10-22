import { expect, test } from "bun:test";
import { HIGH_RISK_PATHS, isHighRisk } from "./high-risk-paths.mjs";

test("explicit policy covers irreversible boundaries", () => {
	for (const path of [
		"packages/db/src/schema/work.ts",
		"packages/db/migrations/001.sql",
		"packages/auth/src/descope.ts",
		"apps/session-broker/src/index.ts",
		"apps/api/src/lib/mcp-grant.ts",
		"apps/api/src/rpc/routers/external-agent-identity.ts",
		"apps/mcp/src/external-agent-session.ts",
		"apps/mcp/src/mcp/owner-host-session.ts",
		"apps/mcp/src/mcp/handler.ts",
		"apps/api/src/rpc/orpc.ts",
		"apps/os/src/auth/session-broker.ts",
		"apps/os/src/worker.ts",
		"wrangler.jsonc",
		"apps/api/cloudflare.config.ts",
		"apps/os/wrangler.jsonc",
		"scripts/ci/full-suite-hourly.mjs",
		".github/workflows/full-suite-hourly.yml",
		"packages/db/src/utils/secrets-encryption.ts",
		"scripts/secrets/rotate-master-key.ts",
		"apps/api/src/rpc/routers/app-secrets.ts",
		"apps/api/src/services/master-key-fingerprints.ts",
	])
		expect(isHighRisk([path])).toBe(true);
	expect(new Set(HIGH_RISK_PATHS).size).toBe(HIGH_RISK_PATHS.length);
});

test("unknown and UI-only paths do not request review", () => {
	for (const path of [
		"apps/os/src/components/button.tsx",
		"docs/auth.md",
		"unknown/file.ts",
		"apps/api/src/rpc/routers/billing.ts",
		"wrangler.jsonc.backup",
	])
		expect(isHighRisk([path])).toBe(false);
	expect(isHighRisk([])).toBe(false);
	expect(isHighRisk(["docs/a.md", "packages/db/migrations/deleted.sql"])).toBe(
		true,
	);
});
