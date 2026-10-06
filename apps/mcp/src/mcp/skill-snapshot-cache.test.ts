import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ApiClient } from "../lib/api-client";
import type { ServerContext } from "./server-context";
import type { SkillDocumentEntry } from "./skill-document";
import type { McpSkillEntry } from "@tedix/mcp-shared/skills";
import {
	__resetSkillSnapshotCache,
	readRenderedSkills,
	readSkillSnapshot,
	renderedSkillsCacheKey,
	skillSnapshotCacheKey,
	writeRenderedSkills,
	writeSkillSnapshot,
} from "./skill-snapshot-cache";
import { loadCachedSkillSnapshot } from "./tool-registration";

function entry(id: string): SkillDocumentEntry {
	return {
		id,
		title: id.toUpperCase(),
		slug: id,
		summary: null,
		description: null,
		content: `# ${id}`,
		files: null,
		tags: null,
		toolIds: null,
		successCount: 0,
		revision: 1,
		appId: "app-1",
		audience: null,
		r2Path: null,
		updatedAt: null,
		createdAt: null,
		source: "d1",
	};
}

const SOFT_TTL_MS = 120_000;
const HARD_TTL_MS = 600_000;

afterEach(() => {
	__resetSkillSnapshotCache();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("skillSnapshotCacheKey", () => {
	const base = {
		appId: "app-1",
		upstreamAppId: undefined,
		appSlug: "app-1",
		orgId: "org-1",
		tediId: "tedi-1",
		guidanceSlugs: undefined,
		fingerprint: "sha-1",
	} as const;

	it("partitions by org, tedi, guidance set, and fingerprint", () => {
		const k = skillSnapshotCacheKey(base);
		expect(skillSnapshotCacheKey({ ...base, orgId: "org-2" })).not.toBe(k);
		expect(skillSnapshotCacheKey({ ...base, tediId: "tedi-2" })).not.toBe(k);
		expect(skillSnapshotCacheKey({ ...base, fingerprint: "sha-2" })).not.toBe(
			k,
		);
		expect(skillSnapshotCacheKey({ ...base, guidanceSlugs: ["a"] })).not.toBe(
			k,
		);
	});

	it("is order-insensitive for the guidance slug set", () => {
		expect(skillSnapshotCacheKey({ ...base, guidanceSlugs: ["a", "b"] })).toBe(
			skillSnapshotCacheKey({ ...base, guidanceSlugs: ["b", "a"] }),
		);
	});

	it("treats absent org/tedi as stable sentinels", () => {
		const k1 = skillSnapshotCacheKey({
			...base,
			orgId: undefined,
			tediId: undefined,
		});
		const k2 = skillSnapshotCacheKey({
			...base,
			orgId: undefined,
			tediId: undefined,
		});
		expect(k1).toBe(k2);
	});
});

describe("readSkillSnapshot / writeSkillSnapshot (L1)", () => {
	it("round-trips through L1 and reports fresh, then stale, then expired", async () => {
		vi.stubGlobal("caches", undefined); // L1-only, deterministic
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const key = "k-ttl";
		await writeSkillSnapshot(key, [entry("s1")]);

		const fresh = await readSkillSnapshot(key);
		expect(fresh?.entries.map((e) => e.id)).toEqual(["s1"]);
		expect(fresh?.stale).toBe(false);

		vi.setSystemTime(SOFT_TTL_MS + 1);
		expect((await readSkillSnapshot(key))?.stale).toBe(true);

		vi.setSystemTime(HARD_TTL_MS + 1);
		expect(await readSkillSnapshot(key)).toBeNull();
	});

	it("fails open to null/no-op when the Cache API throws", async () => {
		vi.stubGlobal("caches", {
			default: {
				match: async () => {
					throw new Error("cache boom");
				},
				put: async () => {
					throw new Error("cache boom");
				},
			},
		});
		// L1 empty → falls through to the throwing L2 → null (live path).
		expect(await readSkillSnapshot("k-missing")).toBeNull();
		// Write swallows the L2 error and still populates L1.
		await expect(
			writeSkillSnapshot("k-w", [entry("s1")]),
		).resolves.toBeUndefined();
	});
});

function makeAgent(opts: {
	listByApp: (input: unknown) => Promise<{ skills: unknown[] }>;
	tediId?: string;
	orgId?: string;
	appId?: string;
	gitSha?: string;
}): ServerContext {
	return {
		appId: opts.appId ?? "app-1",
		appSlug: "app-1",
		upstreamAppId: undefined,
		appMetadata: { mcpConfig: {} },
		callerIdentity: {
			organizationId: opts.orgId ?? "org-1",
			tediId: opts.tediId,
		},
		apiClient: {
			skills: {
				listByApp: opts.listByApp,
				listByOrg: async () => ({ entries: [] }),
			},
		} as unknown as ApiClient,
		env: { GIT_SHA: opts.gitSha ?? "test-sha" },
		ctx: {
			waitUntil: (p: Promise<unknown>) => {
				void p.catch(() => {});
			},
		},
		loadedTools: new Map(),
	} as unknown as ServerContext;
}

describe("loadCachedSkillSnapshot", () => {
	it("serves the second build from cache without re-issuing the D1 skill fetch", async () => {
		vi.stubGlobal("caches", undefined); // L1-only
		let calls = 0;
		const listByApp = async () => {
			calls++;
			return {
				skills: [
					{ id: "s1", title: "S1", content: "b", successCount: 0, revision: 1 },
				],
			};
		};

		const first = await loadCachedSkillSnapshot(
			makeAgent({ listByApp, gitSha: "sha-hit" }),
		);
		expect([...first.keys()]).toEqual(["s1"]);
		expect(calls).toBe(1);

		const second = await loadCachedSkillSnapshot(
			makeAgent({ listByApp, gitSha: "sha-hit" }),
		);
		expect([...second.keys()]).toEqual(["s1"]);
		expect(calls).toBe(1); // cache hit — no second D1 fetch
	});

	it("does NOT share a snapshot across tedis (personalized skills)", async () => {
		vi.stubGlobal("caches", undefined);
		let calls = 0;
		const listByApp = async (input: unknown) => {
			calls++;
			const tediId = (input as { tediId?: string }).tediId;
			return {
				skills: [
					{
						id: `skill-${tediId}`,
						title: tediId,
						content: "b",
						successCount: 0,
						revision: 1,
					},
				],
			};
		};

		const a = await loadCachedSkillSnapshot(
			makeAgent({ listByApp, tediId: "tedi-a", gitSha: "sha-part" }),
		);
		const b = await loadCachedSkillSnapshot(
			makeAgent({ listByApp, tediId: "tedi-b", gitSha: "sha-part" }),
		);
		expect(calls).toBe(2); // distinct keys → distinct live fetches
		expect([...a.keys()]).toEqual(["skill-tedi-a"]);
		expect([...b.keys()]).toEqual(["skill-tedi-b"]);
	});

	it("falls through to the live fan-out when the cache read throws", async () => {
		vi.stubGlobal("caches", {
			default: {
				match: async () => {
					throw new Error("cache boom");
				},
				put: async () => {
					throw new Error("cache boom");
				},
			},
		});
		let calls = 0;
		const listByApp = async () => {
			calls++;
			return {
				skills: [
					{ id: "s1", title: "S1", content: "b", successCount: 0, revision: 1 },
				],
			};
		};
		const result = await loadCachedSkillSnapshot(
			makeAgent({ listByApp, gitSha: "sha-fail" }),
		);
		expect([...result.keys()]).toEqual(["s1"]);
		expect(calls).toBe(1); // live path served the build
	});
});

function rendered(uri: string): McpSkillEntry {
	return {
		uri,
		frontmatter: { name: uri, description: uri },
		resources: [{ uri, digest: `sha256:${"0".repeat(64)}`, size: 0 }],
	};
}

describe("renderedSkillsCacheKey", () => {
	const base = {
		fingerprint: "sha-1",
		appSlug: "app-1",
		skillRevisions: [["s1", 1] as const, ["s2", 3] as const],
		toolIdMap: [["uuid-a", "do_thing"] as const],
	};

	it("partitions by fingerprint, appSlug, skill revisions, and tool map", () => {
		const k = renderedSkillsCacheKey(base);
		expect(renderedSkillsCacheKey({ ...base, fingerprint: "sha-2" })).not.toBe(
			k,
		);
		expect(renderedSkillsCacheKey({ ...base, appSlug: "app-2" })).not.toBe(k);
		// a skill revision bump must re-render (content changed)
		expect(
			renderedSkillsCacheKey({
				...base,
				skillRevisions: [["s1", 2] as const, ["s2", 3] as const],
			}),
		).not.toBe(k);
		// a changed tool surface changes frontmatter/digests → must re-render
		expect(
			renderedSkillsCacheKey({
				...base,
				toolIdMap: [["uuid-a", "renamed_tool"] as const],
			}),
		).not.toBe(k);
	});

	it("is order-insensitive for skill and tool lists", () => {
		expect(
			renderedSkillsCacheKey({
				...base,
				skillRevisions: [["s2", 3] as const, ["s1", 1] as const],
			}),
		).toBe(renderedSkillsCacheKey(base));
	});
});

describe("readRenderedSkills / writeRenderedSkills (L1)", () => {
	it("round-trips through L1 and reports fresh, then stale, then expired", async () => {
		vi.stubGlobal("caches", undefined); // L1-only, deterministic
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const key = "render-ttl";
		await writeRenderedSkills(key, [rendered("skill://a/SKILL.md")]);

		const fresh = await readRenderedSkills(key);
		expect(fresh?.entries.map((e) => e.uri)).toEqual(["skill://a/SKILL.md"]);
		expect(fresh?.stale).toBe(false);

		vi.setSystemTime(SOFT_TTL_MS + 1);
		expect((await readRenderedSkills(key))?.stale).toBe(true);

		vi.setSystemTime(HARD_TTL_MS + 1);
		expect(await readRenderedSkills(key)).toBeNull();
	});

	it("fails open to null/no-op when the Cache API throws", async () => {
		vi.stubGlobal("caches", {
			default: {
				match: async () => {
					throw new Error("cache boom");
				},
				put: async () => {
					throw new Error("cache boom");
				},
			},
		});
		expect(await readRenderedSkills("render-missing")).toBeNull();
		await expect(
			writeRenderedSkills("render-w", [rendered("skill://a/SKILL.md")]),
		).resolves.toBeUndefined();
	});
});
