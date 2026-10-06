import { describe, expect, it } from "vite-plus/test";
import type { ArtifactsBinding } from "../types";
import { digestEditableThemeSource } from "./source-provenance";
import { inspectWorkspaceSourceStatus } from "./workspace-source-status";

const COMMIT = "a".repeat(40);
const TOKEN = "test-secret-do-not-return";
const activeRevision = { kind: "artifacts_commit" as const, value: COMMIT };

function fixture(input: {
	workspace?: Record<string, string>;
	committed?: Record<string, string>;
	failCommit?: boolean;
	missingBlob?: boolean;
	unsafeMode?: boolean;
	invalidUtf8?: boolean;
	readFileDelayMs?: number;
}) {
	const files = new Map(
		Object.entries(input.workspace ?? {}).map(([path, content]) => [
			`/workspace/src/${path}`,
			content,
		]),
	);
	const operations: string[] = [];
	const tokenScopes: unknown[] = [];
	let activeReads = 0,
		maxActiveReads = 0;
	async function delayed<T>(value: T) {
		activeReads++;
		maxActiveReads = Math.max(maxActiveReads, activeReads);
		try {
			if (input.readFileDelayMs)
				await new Promise((resolve) =>
					setTimeout(resolve, input.readFileDelayMs),
				);
			return value;
		} finally {
			activeReads--;
		}
	}
	const trees = new Map<
		string,
		Array<{ name: string; type: string; mode: string; hash: string }>
	>();
	const blobs = new Map<string, string>();
	let next = 1;
	const root = "b".repeat(40);
	trees.set(root, []);
	for (const [path, content] of Object.entries(input.committed ?? {})) {
		let tree = root;
		const parts = ["src", ...path.split("/")];
		for (let i = 0; i < parts.length; i++) {
			const entries = trees.get(tree)!;
			let entry = entries.find((entry) => entry.name === parts[i]);
			if (!entry) {
				const hash = (next++).toString(16).padStart(40, "0");
				entry = {
					name: parts[i]!,
					type: i === parts.length - 1 ? "blob" : "tree",
					mode: i === parts.length - 1 ? "100644" : "40000",
					hash,
				};
				entries.push(entry);
				if (entry.type === "tree") trees.set(hash, []);
				else blobs.set(hash, content);
			}
			tree = entry.hash;
		}
	}
	const artifacts = {
		async get(name: string) {
			expect(name).toBe("cms-theme-acme");
			return {
				[Symbol.dispose]() {
					operations.push("dispose");
				},
				async readCommit(commit: string) {
					operations.push("readCommit");
					expect(commit).toBe(COMMIT);
					if (input.failCommit) throw new Error(TOKEN);
					return { hash: COMMIT, treeHash: root };
				},
				async readTree(hash: string) {
					const entries = trees.get(hash);
					if (input.unsafeMode && entries)
						return entries.map((entry) =>
							entry.type === "blob"
								? { ...entry, type: "symlink", mode: "120000" }
								: entry,
						);
					return entries ?? null;
				},
				async readBlob(hash: string) {
					const content = blobs.get(hash);
					if (input.missingBlob || content === undefined) return null;
					return delayed(
						new Blob([input.invalidUtf8 ? new Uint8Array([255]) : content]),
					);
				},
				async createToken() {
					throw new Error("must not mint tokens");
				},
			};
		},
	} as unknown as ArtifactsBinding;
	const sandbox = {
		async listFiles(root: string) {
			return [...files.keys()]
				.filter((path) => path.startsWith(`${root}/`))
				.map((path) => ({
					type: "file",
					relativePath: path.slice(root.length + 1),
				}));
		},
		async readFile(path: string) {
			const content = files.get(path);
			if (content === undefined) throw new Error("Missing file");
			return delayed({
				content,
				size: new TextEncoder().encode(content).byteLength,
			});
		},
	};
	const inspect = (
		revision: Parameters<
			typeof inspectWorkspaceSourceStatus
		>[0]["activeSourceRevision"] = activeRevision,
	) =>
		inspectWorkspaceSourceStatus({
			orgSlug: "acme",
			templateSlug: "tedix",
			sandbox: sandbox as Parameters<
				typeof inspectWorkspaceSourceStatus
			>[0]["sandbox"],
			activeVersion: 4,
			activeSourceRevision: revision,
			artifacts,
		});
	return {
		inspect,
		workspaceDigest: () => digestEditableThemeSource(sandbox, "tedix"),
		files,
		operations,
		tokenScopes,
		maxConcurrentReads: () => maxActiveReads,
	};
}

describe("CMS builder workspace source status", () => {
	it("matches the active commit without writing to the workspace", async () => {
		const source = {
			"pages/index.astro": "<h1>Active</h1>",
			"styles/theme.css": ":root{color:blue}",
		};
		const { inspect, files, operations, tokenScopes } = fixture({
			workspace: { ...source, "middleware.ts": "workspace lock" },
			committed: { ...source, "middleware.ts": "commit lock" },
		});
		const result = await inspect();
		expect(result.status).toBe("matches_active_source");
		expect(result.activeVersion).toBe(4);
		expect(result.activeSourceCommit).toBe(COMMIT);
		expect(result.workspaceSource).toEqual(result.activeSource);
		expect(tokenScopes).toEqual([]);
		expect(operations).toContain("dispose");
		expect(
			operations.some((entry) => entry.startsWith("write:/workspace")),
		).toBe(false);
		expect([...files.keys()]).toEqual(
			expect.arrayContaining(["/workspace/src/pages/index.astro"]),
		);
		expect([...files.keys()].some((path) => path.startsWith("/tmp/"))).toBe(
			false,
		);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("reads editable files concurrently on both sides of the comparison", async () => {
		const source = Object.fromEntries(
			Array.from({ length: 20 }, (_, index) => [
				`components/Card${index}.astro`,
				`<p>${index}</p>`,
			]),
		);
		const { inspect, maxConcurrentReads, operations } = fixture({
			workspace: source,
			committed: source,
			readFileDelayMs: 5,
		});
		expect((await inspect()).status).toBe("matches_active_source");
		expect(maxConcurrentReads()).toBeGreaterThan(1);
		expect(maxConcurrentReads()).toBeLessThanOrEqual(8);
		expect(
			operations.filter((operation) => operation === "readCommit"),
		).toHaveLength(1);
	});

	it("reports changed, added, or missing editable files as drift", async () => {
		const cases: Array<{
			workspace: Record<string, string>;
			committed: Record<string, string>;
		}> = [
			{
				workspace: { "pages/index.astro": "<h1>Draft</h1>" },
				committed: { "pages/index.astro": "<h1>Active</h1>" },
			},
			{
				workspace: {
					"pages/index.astro": "<h1>Active</h1>",
					"styles/theme.css": "x",
				},
				committed: { "pages/index.astro": "<h1>Active</h1>" },
			},
			{
				workspace: { "pages/index.astro": "<h1>Active</h1>" },
				committed: {
					"pages/index.astro": "<h1>Active</h1>",
					"styles/theme.css": "x",
				},
			},
		];
		for (const { workspace, committed } of cases) {
			const { inspect } = fixture({
				workspace,
				committed,
			});
			const result = await inspect();
			expect(result.status).toBe("differs_from_active_source");
			expect(result.message).toMatch(/intentional draft edits or stale\/reset/);
		}
	});

	it("does not access Artifacts when there is no active Artifacts source", async () => {
		const { inspect, operations } = fixture({});
		const result = await inspect(null);
		expect(result.status).toBe("no_artifacts_source");
		expect(operations).toEqual([]);
	});

	it("compares a digest-backed bundle without accessing Artifacts or changing the workspace", async () => {
		const { inspect, workspaceDigest, operations } = fixture({
			workspace: {
				"pages/index.astro": "<h1>Active</h1>",
				"styles/theme.css": ":root{color:blue}",
			},
		});
		const source = await workspaceDigest();
		const result = await inspect({
			kind: "editable_source_digest",
			value: source.digest,
		});
		expect(result).toMatchObject({
			status: "matches_active_source",
			activeSourceCommit: null,
			activeSourceDigest: source.digest,
			workspaceSource: source,
		});
		expect(operations).toEqual([]);
	});

	it("holds a digest-backed bundle when the workspace drifts or is unreadable", async () => {
		const drifted = fixture({
			workspace: { "pages/index.astro": "<h1>Draft</h1>" },
		});
		const activeSourceDigest = "b".repeat(64);
		const drift = await drifted.inspect({
			kind: "editable_source_digest",
			value: activeSourceDigest,
		});
		expect(drift.status).toBe("differs_from_active_source");
		expect(drift.activeSourceDigest).toBe(activeSourceDigest);
		expect(drift.message).toContain("Do not seed Artifacts");
		expect(drifted.operations).toEqual([]);

		const unreadable = fixture({});
		const unknown = await unreadable.inspect({
			kind: "editable_source_digest",
			value: activeSourceDigest,
		});
		expect(unknown.status).toBe("unavailable");
		expect(unknown.activeSourceDigest).toBe(activeSourceDigest);
		expect(unreadable.operations).toEqual([]);
	});

	it("disposes the native handle and hides provider errors when commit read fails", async () => {
		const { inspect, files, operations } = fixture({
			workspace: { "pages/index.astro": "active" },
			failCommit: true,
		});
		const result = await inspect();
		expect(result.status).toBe("unavailable");
		expect(operations).toContain("dispose");
		expect([...files.keys()].some((path) => path.startsWith("/tmp/"))).toBe(
			false,
		);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("fails closed if a native blob is missing", async () => {
		const { inspect } = fixture({
			workspace: { "pages/index.astro": "active" },
			committed: { "pages/index.astro": "active" },
			missingBlob: true,
		});
		expect((await inspect()).status).toBe("unavailable");
	});
	it.each([{ unsafeMode: true }, { invalidUtf8: true }])(
		"rejects unsafe editable native content %j",
		async (option) => {
			const f = fixture({
				workspace: { "pages/index.astro": "active" },
				committed: { "pages/index.astro": "active" },
				...option,
			});
			expect((await f.inspect()).status).toBe("unavailable");
			expect(f.operations).toContain("dispose");
		},
	);
});
