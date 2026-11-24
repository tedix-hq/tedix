import { describe, expect, it } from "vite-plus/test";
import type { McpServer } from "@tedix/mcp-shared/server";
import {
	deriveToolWriteCapability,
	type ToolAnnotations,
} from "@tedix/api-contract/schemas/tools";
import { toolClassDeclarationGap } from "@tedix/api-contract/utils/tool-declared-class";
import { registerStarterTools } from "./tools-starter";
import type { SiteBuilderToolContext } from "./tools-shared";
import { GitMemoryFs } from "@tedix/worker-kit/git-memory-fs";
import type { TreeEntry } from "isomorphic-git";
import {
	listRepoFiles,
	listStarterChanges,
	listStarterCommits,
	readRepoText,
	resolveStarterBaseline,
	starterSnapshotHash,
	themeSourceWithStarterCommit,
} from "./starter-source";

type FakeCommit = {
	hash: string;
	tree: string;
	parents: string[];
	message: string;
	committedAt: number;
};

/** In-memory ArtifactsRepo backed by real isomorphic-git object ids. */
async function makeRepo(initial?: {
	files: Record<string, string>;
	message?: string;
}) {
	const { default: git } = await import("isomorphic-git");
	const fs = new GitMemoryFs(64 * 1024 * 1024, 65_536);
	const dir = "/repo";
	await git.init({ fs, dir, defaultBranch: "main" });

	type Node = { files: Map<string, string>; dirs: Map<string, Node> };
	const node = (): Node => ({ files: new Map(), dirs: new Map() });

	async function writeNode(
		n: Node,
	): Promise<{ oid: string; entries: TreeEntry[] }> {
		const entries: TreeEntry[] = [];
		for (const [name, content] of n.files) {
			const oid = await git.writeBlob({
				fs,
				dir,
				blob: new TextEncoder().encode(content),
			});
			blobs.set(oid, content);
			entries.push({ path: name, oid, mode: "100644", type: "blob" });
		}
		for (const [name, child] of n.dirs) {
			const written = await writeNode(child);
			entries.push({
				path: name,
				oid: written.oid,
				mode: "40000",
				type: "tree",
			});
		}
		entries.sort((a, b) => a.path.localeCompare(b.path));
		const oid = await git.writeTree({ fs, dir, tree: entries });
		trees.set(
			oid,
			entries.map((entry) => ({
				name: entry.path,
				mode: entry.mode,
				hash: entry.oid,
				type: entry.type,
			})),
		);
		return { oid, entries };
	}

	const commits = new Map<string, FakeCommit>();
	const trees = new Map<
		string,
		Array<{ name: string; mode: string; hash: string; type: string }>
	>();
	const blobs = new Map<string, string>();

	const heads = new Map<string, string>();
	async function commitNode(
		n: Node,
		parent: string | null,
		message: string,
	): Promise<string> {
		const { oid: tree } = await writeNode(n);
		const hash = await git.writeCommit({
			fs,
			dir,
			commit: {
				tree,
				parent: parent ? [parent] : [],
				message,
				author: {
					name: "test",
					email: "test@example.com",
					timestamp: Math.floor(Date.now() / 1000),
					timezoneOffset: 0,
				},
				committer: {
					name: "test",
					email: "test@example.com",
					timestamp: Math.floor(Date.now() / 1000),
					timezoneOffset: 0,
				},
			},
		});
		commits.set(hash, {
			hash,
			tree,
			parents: parent ? [parent] : [],
			message,
			committedAt: Math.floor(Date.now() / 1000),
		});
		return hash;
	}

	const buildNode = (files: Record<string, string>): Node => {
		const n = node();
		for (const [path, content] of Object.entries(files)) {
			const parts = path.split("/");
			let cursor = n;
			for (const part of parts.slice(0, -1)) {
				let next = cursor.dirs.get(part);
				if (!next) cursor.dirs.set(part, (next = node()));
				cursor = next;
			}
			cursor.files.set(parts[parts.length - 1]!, content);
		}
		return n;
	};

	let head: string | null = null;
	if (initial) {
		head = await commitNode(
			buildNode(initial.files),
			null,
			initial.message ?? "initial",
		);
		heads.set("main", head);
	}

	const repo = {
		async readCommit(hash: string) {
			const commit = commits.get(hash);
			if (!commit) return null;
			return {
				hash: commit.hash,
				treeHash: commit.tree,
				message: commit.message,
				author: { name: "test", email: "test@example.com" },
				committer: { name: "test", email: "test@example.com" },
				parents: commit.parents,
				authoredAt: commit.committedAt,
				committedAt: commit.committedAt,
			};
		},
		async readTree(hash: string) {
			return trees.get(hash) ?? null;
		},
		async readBlob(hash: string) {
			const content = blobs.get(hash);
			return content === undefined ? null : new Blob([content]);
		},
		async readFile(args: { ref: string; path: string }) {
			const commitHash =
				heads.get(args.ref) ??
				(commits.has(args.ref) ? args.ref : heads.get("main"));
			const commit = commitHash ? commits.get(commitHash) : undefined;
			if (!commit) return null;
			const parts = args.path.split("/");
			let hash = commit.tree;
			for (let i = 0; i < parts.length; i++) {
				const entry = (trees.get(hash) ?? []).find((e) => e.name === parts[i]);
				if (!entry) return null;
				if (i === parts.length - 1) {
					const content = blobs.get(entry.hash);
					return content === undefined ? null : new Blob([content]);
				}
				hash = entry.hash;
			}
			return null;
		},
		async log(opts?: { ref?: string; limit?: number }) {
			const ref = opts?.ref ?? "main";
			const limit = opts?.limit ?? 50;
			let hash = heads.get(ref) ?? (commits.has(ref) ? ref : null);
			const out = [];
			while (hash && out.length < limit) {
				const commit = commits.get(hash);
				if (!commit) break;
				out.push({
					hash: commit.hash,
					treeHash: commit.tree,
					message: commit.message,
					author: { name: "t", email: "t@e" },
					committer: { name: "t", email: "t@e" },
					parents: commit.parents,
					authoredAt: commit.committedAt,
					committedAt: commit.committedAt,
				});
				hash = commit.parents[0] ?? null;
			}
			return out;
		},
	} as unknown as ArtifactsRepo;

	return {
		repo,
		commitFiles: async (files: Record<string, string>, message: string) => {
			const parent = head;
			head = await commitNode(buildNode(files), parent, message);
			heads.set("main", head);
			return head;
		},
		head: () => head,
	};
}

const EDITABLE = "src/components/Hero.astro";
const EDITABLE_B = "src/pages/about.astro";

describe("starter source", () => {
	it("computes a stable snapshot hash", async () => {
		const a = await starterSnapshotHash("tedix");
		const b = await starterSnapshotHash("tedix");
		expect(a).toMatch(/^[a-f0-9]{64}$/);
		expect(a).toBe(b);
	});

	it("classifies starter changes against the site tree", async () => {
		const starter = await makeRepo({
			files: {
				[EDITABLE]: "v1",
				[EDITABLE_B]: "keep",
				"src/theme-source.json": '{"version":2}',
			},
		});
		const from = starter.head()!;
		// Starter head: A modified, B deleted, C added.
		const starterHead = await starter.commitFiles(
			{
				[EDITABLE]: "v2",
				"src/components/New.astro": "new",
				"src/theme-source.json": '{"version":2}',
			},
			"starter v2",
		);
		const site = await makeRepo({
			files: {
				// Site never touched A or New -> clean / clean add.
				[EDITABLE]: "v1",
				"src/components/New.astro": "site-added",
				// Site edited B -> conflict on starter delete.
				[EDITABLE_B]: "site-edit",
				"src/theme-source.json": '{"version":2}',
			},
		});
		// New.astro exists on site with different content -> conflict (site
		// added a file the starter also added).
		const changeset = await listStarterChanges({
			siteRepo: site.repo,
			siteHead: site.head()!,
			starterRepo: starter.repo,
			fromCommit: from,
			toCommit: starterHead,
			templateSlug: "tedix",
		});
		const byPath = new Map(
			changeset.changes.map((change) => [change.path, change]),
		);
		expect(byPath.get(EDITABLE)).toMatchObject({
			kind: "modified",
			status: "clean",
		});
		expect(byPath.get(EDITABLE_B)).toMatchObject({
			kind: "deleted",
			status: "conflict",
		});
		expect(byPath.get("src/components/New.astro")).toMatchObject({
			kind: "added",
			status: "conflict",
		});
		// theme-source.json is managed by apply, never listed.
		expect(byPath.has("src/theme-source.json")).toBe(false);
		expect(changeset.counts).toEqual({ clean: 1, conflict: 2, current: 0 });
	});

	it("marks already-applied files current", async () => {
		const starter = await makeRepo({ files: { [EDITABLE]: "v1" } });
		const from = starter.head()!;
		const head = await starter.commitFiles({ [EDITABLE]: "v2" }, "v2");
		const site = await makeRepo({ files: { [EDITABLE]: "v2" } });
		const changeset = await listStarterChanges({
			siteRepo: site.repo,
			siteHead: site.head()!,
			starterRepo: starter.repo,
			fromCommit: from,
			toCommit: head,
			templateSlug: "tedix",
		});
		expect(changeset.changes[0]).toMatchObject({
			path: EDITABLE,
			status: "current",
		});
	});

	it("resolves baseline from theme-source.json starterCommit", async () => {
		const starter = await makeRepo({ files: {} });
		const recorded = starter.head()!;
		const site = await makeRepo({
			files: {
				"src/theme-source.json": JSON.stringify({
					version: 2,
					starterCommit: recorded,
				}),
			},
		});
		const baseline = await resolveStarterBaseline({
			siteRepo: site.repo,
			siteHead: site.head()!,
			starterRepo: starter.repo,
			templateSlug: "tedix",
		});
		expect(baseline).toEqual({ commit: recorded, via: "theme_source" });
	});

	it("falls back to upstreamStarterRevision marker matching", async () => {
		const marker = (rev: string) =>
			JSON.stringify({
				templateSlug: "tedix",
				snapshotHash: "h",
				upstreamStarterRevision: rev,
			});
		const starter = await makeRepo({
			files: { ".cms-starter.json": marker("abc123") },
		});
		const oldest = starter.head()!;
		// A later starter commit keeps the same upstream revision; the oldest
		// match is the baseline so already-applied states read as "current".
		await starter.commitFiles(
			{ ".cms-starter.json": marker("abc123"), "extra.txt": "x" },
			"second",
		);
		const site = await makeRepo({
			files: {
				"src/theme-release.json": JSON.stringify({
					upstreamStarterRevision: "abc123",
				}),
			},
		});
		const baseline = await resolveStarterBaseline({
			siteRepo: site.repo,
			siteHead: site.head()!,
			starterRepo: starter.repo,
			templateSlug: "tedix",
		});
		expect(baseline).toEqual({ commit: oldest, via: "upstream_revision" });
	});

	it("merges starterCommit into theme-source.json", async () => {
		const site = await makeRepo({
			files: {
				"src/theme-source.json": JSON.stringify({
					version: 2,
					custom: "keep-me",
				}),
			},
		});
		const change = await themeSourceWithStarterCommit(
			site.repo,
			site.head()!,
			"a".repeat(40),
		);
		expect(change.path).toBe("src/theme-source.json");
		if (!("content" in change)) throw new Error("expected content change");
		expect(JSON.parse(change.content)).toEqual({
			version: 2,
			custom: "keep-me",
			starterCommit: "a".repeat(40),
		});
	});

	it("reads repo text and lists files", async () => {
		const repo = await makeRepo({
			files: {
				"src/components/A.astro": "alpha",
				"src/components/nested/B.astro": "beta",
				"package.json": "{}",
			},
		});
		const head = repo.head()!;
		const files = await listRepoFiles(repo.repo, head);
		expect(files.get("src/components/A.astro")).toMatch(/^[a-f0-9]{40}$/);
		expect(files.has("src/components/nested/B.astro")).toBe(true);
		expect(await readRepoText(repo.repo, head, "package.json")).toBe("{}");
		expect(
			await readRepoText(repo.repo, head, "src/components/missing.astro"),
		).toBeNull();
	});

	it("lists starter commits newest first", async () => {
		const repo = await makeRepo({ files: { "a.txt": "1" } });
		await repo.commitFiles({ "a.txt": "2" }, "two");
		const commits = await listStarterCommits(repo.repo, 10);
		expect(commits).toHaveLength(2);
		expect(commits[0]!.commit).toMatch(/^[a-f0-9]{40}$/);
		expect(commits[0]!.commit).toBe(repo.head());
	});

	it("passes catalog import classification for both starter tools", () => {
		const classes = new Map<string, string | null>();
		const server = {
			registerTool(
				name: string,
				definition: {
					annotations?: ToolAnnotations;
					_meta?: Record<string, unknown>;
				},
			) {
				const writeCapability = deriveToolWriteCapability(
					definition.annotations,
				);
				expect(
					toolClassDeclarationGap({ writeCapability, meta: definition._meta }),
					name,
				).toBeNull();
				classes.set(name, writeCapability);
			},
		};
		registerStarterTools(
			server as unknown as McpServer,
			{} as SiteBuilderToolContext,
		);
		expect(classes.get("theme_starter_diff")).toBe("read");
		expect(classes.get("theme_starter_apply")).toBe("destructive");
	});
});
