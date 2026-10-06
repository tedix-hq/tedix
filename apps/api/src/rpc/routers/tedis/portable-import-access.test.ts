import { describe, expect, it, vi } from "vite-plus/test";
import { PortableTediManifestSchema } from "@tedix/api-contract/schemas/portable-tedi";
import type { BaseContext } from "../../orpc";
import { beginPortableTediImport } from "./portable-import-access";

vi.mock("./crud", () => ({
	createTediForPortableImport: vi.fn(async () => ({
		id: "22222222-2222-4222-8222-222222222222",
	})),
}));
vi.mock("@tedix/db/queries/tedis", () => ({ updateTedi: vi.fn() }));

describe("portable import Git access", () => {
	it("uses the remote returned by the installation's Artifacts binding", async () => {
		const remote =
			"https://example.artifacts.cloudflare.net/git/example-installation/worker.git";
		const context = {
			authType: "user",
			organizationId: "11111111-1111-4111-8111-111111111111",
			db: {},
			env: {
				ARTIFACTS: {
					create: vi.fn(async () => ({ remote, token: "test-token" })),
				},
				API_URL: "https://api.example.test",
				SECRETS_MASTER_KEY: "test-master-key",
			},
		} as unknown as BaseContext;
		const section = (path: string) => ({
			path,
			sha256: "a".repeat(64),
			count: 0,
		});
		const manifest = PortableTediManifestSchema.parse({
			format: "tedix-tedi-git-bundle",
			version: 1,
			exportedAt: "2026-01-01T00:00:00.000Z",
			sourceTediId: "33333333-3333-4333-8333-333333333333",
			identity: {
				name: "Example worker",
				slug: "example-worker",
				displayName: null,
				personality: null,
				avatar: null,
				timezone: null,
				language: null,
				tags: [],
				installedSkills: [],
				installedPlugins: [],
			},
			bindings: {
				runtimeProfile: null,
				policyPack: null,
				workspaceTemplateSet: null,
				apps: [],
			},
			artifacts: { defaultBranch: "main", head: null },
			files: {
				memoryDomains: section("snapshot/memory-domains.ndjson"),
				memoryFacts: section("snapshot/memory-facts.ndjson"),
				memoryEdges: section("snapshot/memory-edges.ndjson"),
				skills: section("snapshot/skills.ndjson"),
				rationale: section("snapshot/rationale.ndjson"),
			},
		});
		const result = await beginPortableTediImport(context, {
			manifest,
			destinationSlug: "example-worker",
		});
		expect(result.git).toMatchObject({ remote, token: "test-token" });
	});
});
