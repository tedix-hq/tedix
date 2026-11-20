import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

// A throwaway checkpoint signing key, made for each test run.
const signingKey = generateKeyPairSync("ed25519")
	.privateKey.export({ type: "pkcs8", format: "der" })
	.toString("base64");

// Isolated from production bindings: every binding here is a local fixture.
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: path.resolve(import.meta.dirname, "test/worker.ts"),
			additionalExports: {
				TurnFacet: "DurableObject",
			},
			miniflare: {
				compatibilityDate: "2026-05-14",
				compatibilityFlags: ["nodejs_compat"],
				workerLoaders: { LOADER: {} },
				d1Databases: ["DB"],
				r2Buckets: ["R2_BUCKET"],
				bindings: {
					DO_JURISDICTION: "",
					ENVIRONMENT: "test",
					CHANGE_RECORD_SIGNING_KEY: signingKey,
				},
				durableObjects: {
					WORKSPACE: { className: "WorkspaceDO", useSQLite: true },
					TEDI_AGENT: { className: "TediAgentFixture", useSQLite: true },
					COLLAB_ROOM: { className: "CollabRoomFixture", useSQLite: true },
					ORGANIZATION_LOG: {
						className: "OrganizationLogStore",
						useSQLite: true,
					},
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.workerd.test.ts"],
		testTimeout: 30_000,
		fsModuleCache: false,
	},
});
