import { describe, expect, it } from "vite-plus/test";
import {
	PortableTediFactSchema,
	PortableTediManifestSchema,
	PortableTediSkillSchema,
	PortableTediSnapshotPageInputSchema,
} from "./portable-tedi";

const digest = "a".repeat(64);
const manifest = {
	format: "tedix-tedi-git-bundle",
	version: 1,
	exportedAt: "2026-09-28T02:00:00.000Z",
	sourceTediId: "a4d6765f-786b-446b-b9d1-3573b4330b9a",
	identity: {
		name: "CTO",
		slug: "cto",
		displayName: "CTO",
		personality: "Careful and direct",
		avatar: null,
		timezone: "Europe/Berlin",
		language: "en",
		tags: [],
		installedSkills: ["review-code"],
		installedPlugins: [],
	},
	bindings: {
		runtimeProfile: { scope: "system", slug: "default", version: 1 },
		policyPack: { scope: "system", slug: "standard", version: 2 },
		workspaceTemplateSet: { scope: "system", slug: "default", version: 1 },
		apps: ["github"],
	},
	artifacts: { defaultBranch: "main", head: "b".repeat(40) },
	files: {
		memoryDomains: {
			path: "snapshot/memory-domains.ndjson",
			sha256: digest,
			count: 1,
		},
		memoryFacts: {
			path: "snapshot/memory-facts.ndjson",
			sha256: digest,
			count: 2,
		},
		memoryEdges: {
			path: "snapshot/memory-edges.ndjson",
			sha256: digest,
			count: 1,
		},
		skills: { path: "snapshot/skills.ndjson", sha256: digest, count: 1 },
		rationale: { path: "snapshot/rationale.ndjson", sha256: digest, count: 1 },
	},
} as const;

describe("portable tedi manifest", () => {
	it("accepts a complete content-addressed snapshot", () => {
		expect(PortableTediManifestSchema.parse(manifest)).toEqual(manifest);
	});

	it("rejects credential-shaped extension fields", () => {
		expect(
			PortableTediManifestSchema.safeParse({
				...manifest,
				accessToken: "should-never-be-serialized",
			}).success,
		).toBe(false);
	});

	it("rejects a redirected snapshot file", () => {
		expect(
			PortableTediManifestSchema.safeParse({
				...manifest,
				files: {
					...manifest.files,
					memoryFacts: {
						...manifest.files.memoryFacts,
						path: "snapshot/skills.ndjson",
					},
				},
			}).success,
		).toBe(false);
	});
});

describe("portable tedi page boundary", () => {
	it("strips source tenant and projection IDs from facts", () => {
		const fact = PortableTediFactSchema.parse({
			id: "fact-one",
			organizationId: "source-org",
			tediId: "source-tedi",
			domainId: null,
			content: "A fact",
			factType: "fact",
			confidence: 0.8,
			embeddingId: "source-projection",
			accessCount: 0,
			usageCount: 0,
		});
		expect(fact).not.toHaveProperty("organizationId");
		expect(fact).not.toHaveProperty("tediId");
		expect(fact).not.toHaveProperty("embeddingId");
	});

	it("strips source skill owner and R2 storage pointers", () => {
		const skill = PortableTediSkillSchema.parse({
			id: "skill-one",
			organizationId: "source-org",
			tediId: "source-tedi",
			title: "Procedure",
			content: "Do this",
			successCount: 0,
			failureCount: 0,
			revision: 1,
			visibility: "private",
			paceLayer: "innovation",
			r2Path: "source-bucket/skill",
		});
		expect(skill).not.toHaveProperty("organizationId");
		expect(skill).not.toHaveProperty("tediId");
		expect(skill).not.toHaveProperty("r2Path");
	});

	it("keeps API pages bounded", () => {
		expect(
			PortableTediSnapshotPageInputSchema.safeParse({
				tediId: manifest.sourceTediId,
				section: "memoryFacts",
				limit: 101,
			}).success,
		).toBe(false);
	});
});
