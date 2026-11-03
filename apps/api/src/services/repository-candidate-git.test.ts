import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import git from "isomorphic-git";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	buildCandidateCommit,
	sendCandidateCommit,
	CANDIDATE_GIT_LIMITS,
	type CandidateCommitRecipe,
} from "./repository-candidate-git";
import { CandidateGitMemoryFs } from "./repository-candidate-git-fs";

const remote = `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/fixture/candidate.git`;
const recipe: CandidateCommitRecipe = {
	message: "Apply fictional sealed candidate\n",
	author: {
		name: "Fixture executor",
		email: "executor@example.test",
		timestamp: 1760000000,
		timezoneOffset: 0,
	},
	committer: {
		name: "Fixture executor",
		email: "executor@example.test",
		timestamp: 1760000000,
		timezoneOffset: 0,
	},
};
const packet = (text: string) =>
	`${(Buffer.byteLength(text) + 4).toString(16).padStart(4, "0")}${text}`;
const adv = (base: string, capabilities = "report-status") =>
	packet("# service=git-receive-pack\n") +
	"0000" +
	packet(`${base} refs/heads/main\0${capabilities}\n`) +
	"0000";
const response = (
	text: string,
	type = "application/x-git-receive-pack-advertisement",
) => new Response(text, { headers: { "Content-Type": type } });
const pack = new Uint8Array(32);
pack.set(new TextEncoder().encode("PACK"));
const sendInput = () => ({
	remote,
	targetRef: "refs/heads/main",
	expectedOldOid: "a".repeat(40),
	commitOid: "b".repeat(40),
	pack,
	authorization: "Bearer private-fixture-token",
	deadlineAt: Date.now() + 30_000,
	beforePost: vi.fn(async () => {}),
});

async function objectFixture() {
	const fs = new CandidateGitMemoryFs(),
		dir = "/fixture";
	await git.init({ fs, dir, defaultBranch: "main" });
	const blob = await git.writeBlob({
		fs,
		dir,
		blob: new TextEncoder().encode("before\n"),
	});
	const sibling = await git.writeBlob({
		fs,
		dir,
		blob: new TextEncoder().encode("unchanged"),
	});
	const subtree = await git.writeTree({
		fs,
		dir,
		tree: [
			{ mode: "100755", path: "file.ts", oid: blob, type: "blob" },
			{ mode: "120000", path: "link", oid: sibling, type: "blob" },
		],
	});
	const root = await git.writeTree({
		fs,
		dir,
		tree: [
			{ mode: "40000", path: "src", oid: subtree, type: "tree" },
			{ mode: "100644", path: "other", oid: sibling, type: "blob" },
			{ mode: "160000", path: "module", oid: "d".repeat(40), type: "commit" },
		],
	});
	const entries: Record<string, ArtifactsTreeEntry[]> = {
		[root]: [
			{ name: "src", mode: "40000", hash: subtree, type: "tree" },
			{ name: "other", mode: "100644", hash: sibling, type: "blob" },
			{ name: "module", mode: "160000", hash: "d".repeat(40), type: "gitlink" },
		],
		[subtree]: [
			{ name: "file.ts", mode: "100755", hash: blob, type: "exec" },
			{ name: "link", mode: "120000", hash: sibling, type: "symlink" },
		],
	};
	const input = {
		baseCommitOid: "c".repeat(40),
		baseTreeOid: root,
		frozenFiles: { "src/file.ts": "after\n" },
		selectedEntries: [{ path: "src/file.ts", blobRevision: blob, bytes: 7 }],
		commitRecipe: recipe,
		readTree: vi.fn(async (oid: string) => entries[oid] ?? null),
		deadlineAt: Date.now() + 30_000,
	};
	return { input, entries, root, subtree, blob, sibling };
}

describe("explicit candidate object builder", () => {
	it("is deterministic and packs only changed objects, preserving sibling modes and OIDs", async () => {
		const f = await objectFixture(),
			first = await buildCandidateCommit(f.input),
			second = await buildCandidateCommit(f.input);
		expect(first.commitOid).toBe(second.commitOid);
		expect(first.objectManifestDigest).toBe(second.objectManifestDigest);
		expect(first.pack).toEqual(second.pack);
		expect(first.counters.looseObjectCount).toBe(6);
		expect(first.counters.treeCount).toBe(2);
		const fs = new CandidateGitMemoryFs(),
			dir = "/verify";
		await git.init({ fs, dir });
		await fs.promises.mkdir(`${dir}/.git/objects/pack`, { recursive: true });
		await fs.promises.writeFile(
			`${dir}/.git/objects/pack/pack-candidate.pack`,
			first.pack,
		);
		await git.indexPack({
			fs,
			dir,
			filepath: ".git/objects/pack/pack-candidate.pack",
		});
		const commit = (await git.readCommit({ fs, dir, oid: first.commitOid }))
			.commit;
		expect(commit.parent).toEqual([f.input.baseCommitOid]);
		const root = (await git.readTree({ fs, dir, oid: commit.tree })).tree;
		expect(root.find((entry) => entry.path === "other")).toMatchObject({
			mode: "100644",
			oid: f.sibling,
		});
		expect(root.find((entry) => entry.path === "module")).toMatchObject({
			mode: "160000",
			oid: "d".repeat(40),
		});
		const src = (
			await git.readTree({
				fs,
				dir,
				oid: root.find((entry) => entry.path === "src")!.oid,
			})
		).tree;
		expect(src.find((entry) => entry.path === "file.ts")).toMatchObject({
			mode: "100755",
		});
		expect(src.find((entry) => entry.path === "link")).toMatchObject({
			mode: "120000",
			oid: f.sibling,
		});
		await expect(git.readBlob({ fs, dir, oid: f.sibling })).rejects.toThrow();
	});
	it("does not prepare a new commit for an unchanged selection", async () => {
		const f = await objectFixture();
		const result = await buildCandidateCommit({
			...f.input,
			frozenFiles: { "src/file.ts": "before\n" },
		});
		expect(result).toMatchObject({
			unchanged: true,
			commitOid: f.input.baseCommitOid,
			treeOid: f.root,
		});
		expect(result.pack.byteLength).toBe(0);
	});
	it("refuses mismatched base blobs, changed provider trees and nonregular selected paths", async () => {
		const f = await objectFixture();
		await expect(
			buildCandidateCommit({
				...f.input,
				selectedEntries: [
					{ ...f.input.selectedEntries[0]!, blobRevision: "f".repeat(40) },
				],
			}),
		).rejects.toThrow("file_base");
		f.entries[f.root]![1]!.hash = "e".repeat(40);
		await expect(buildCandidateCommit(f.input)).rejects.toThrow(
			"tree_roundtrip",
		);
		const g = await objectFixture();
		await expect(
			buildCandidateCommit({
				...g.input,
				frozenFiles: { "src/link": "change" },
				selectedEntries: [
					{ path: "src/link", blobRevision: g.sibling, bytes: 9 },
				],
			}),
		).rejects.toThrow("file_base");
	});
	it("rejects excess depth, invalid text and expired deadlines before tree reads", async () => {
		const f = await objectFixture();
		for (const change of [
			{ deadlineAt: Date.now() - 1 },
			{ frozenFiles: { "src/file.ts": "\ud800" } },
			{
				selectedEntries: [
					{
						...f.input.selectedEntries[0]!,
						path: Array(33).fill("dir").join("/"),
					},
				],
			},
		])
			await expect(
				buildCandidateCommit({ ...f.input, ...change }),
			).rejects.toThrow();
		expect(f.input.readTree).not.toHaveBeenCalled();
	});
	it("bounds an individual serialized ancestor tree", async () => {
		const f = await objectFixture(),
			fs = new CandidateGitMemoryFs(),
			dir = "/wide";
		await git.init({ fs, dir });
		const tree = Array.from({ length: 500 }, (_, index) => ({
			path: `${index}`.padStart(4, "0") + "x".repeat(200),
			mode: "100644",
			oid: f.sibling,
			type: "blob" as const,
		}));
		tree.push({ path: "selected", mode: "100644", oid: f.blob, type: "blob" });
		const oid = await git.writeTree({ fs, dir, tree });
		const writeTree = vi.spyOn(git, "writeTree");
		try {
			await expect(
				buildCandidateCommit({
					...f.input,
					baseTreeOid: oid,
					frozenFiles: { selected: "new" },
					selectedEntries: [
						{ path: "selected", blobRevision: f.blob, bytes: 7 },
					],
					readTree: async () =>
						tree.map((entry) => ({
							name: entry.path,
							mode: entry.mode,
							hash: entry.oid,
							type: "blob",
						})),
				}),
			).rejects.toThrow("tree_budget");
			expect(writeTree).not.toHaveBeenCalled();
		} finally {
			writeTree.mockRestore();
		}
	});
});

describe("cumulative object bounds", () => {
	it("bounds cumulative original and rebuilt ancestor tree bytes", async () => {
		const fs = new CandidateGitMemoryFs(),
			dir = "/aggregate";
		await git.init({ fs, dir });
		const blob = await git.writeBlob({
			fs,
			dir,
			blob: new TextEncoder().encode("old"),
		});
		const trees: Record<string, ArtifactsTreeEntry[]> = {};
		let oid = "";
		for (let depth = 27; depth >= 0; depth--) {
			const entries: ArtifactsTreeEntry[] = Array.from(
				{ length: 200 },
				(_, index) => ({
					name: `${index}`.padStart(4, "0") + "s".repeat(160),
					mode: "100644",
					hash: "e".repeat(40),
					type: "blob",
				}),
			);
			entries.push(
				depth === 27
					? { name: "file", mode: "100644", hash: blob, type: "blob" }
					: { name: "d", mode: "40000", hash: oid, type: "tree" },
			);
			oid = await git.writeTree({
				fs,
				dir,
				tree: entries.map((entry) => ({
					path: entry.name,
					mode: entry.mode,
					oid: entry.hash,
					type: entry.type === "tree" ? "tree" : "blob",
				})),
			});
			trees[oid] = entries;
		}
		const path = Array(27).fill("d").concat("file").join("/");
		await expect(
			buildCandidateCommit({
				baseCommitOid: "f".repeat(40),
				baseTreeOid: oid,
				frozenFiles: { [path]: "new" },
				selectedEntries: [{ path, blobRevision: blob, bytes: 3 }],
				commitRecipe: recipe,
				readTree: async (hash) => trees[hash] ?? null,
				deadlineAt: Date.now() + 30_000,
			}),
		).rejects.toThrow("tree_budget");
	});
	it("caps distinct tree reads even when each individual tree is small", async () => {
		const fs = new CandidateGitMemoryFs(),
			dir = "/many";
		await git.init({ fs, dir });
		const blob = await git.writeBlob({
			fs,
			dir,
			blob: new TextEncoder().encode("old"),
		});
		const trees: Record<string, ArtifactsTreeEntry[]> = {},
			roots: ArtifactsTreeEntry[] = [],
			selectedEntries: Array<{
				path: string;
				blobRevision: string;
				bytes: number;
			}> = [],
			frozenFiles: Record<string, string> = {};
		for (let branch = 0; branch < 8; branch++) {
			let oid = "";
			for (let depth = 8; depth >= 0; depth--) {
				const entries: ArtifactsTreeEntry[] = [
					{
						name: `marker-${branch}-${depth}`,
						mode: "100644",
						hash: "e".repeat(40),
						type: "blob",
					},
					depth === 8
						? { name: "file", mode: "100644", hash: blob, type: "blob" }
						: { name: "d", mode: "40000", hash: oid, type: "tree" },
				];
				oid = await git.writeTree({
					fs,
					dir,
					tree: entries.map((entry) => ({
						path: entry.name,
						mode: entry.mode,
						oid: entry.hash,
						type: entry.type === "tree" ? "tree" : "blob",
					})),
				});
				trees[oid] = entries;
			}
			roots.push({
				name: `branch${branch}`,
				mode: "40000",
				hash: oid,
				type: "tree",
			});
			const path = [`branch${branch}`, ...Array(8).fill("d"), "file"].join("/");
			frozenFiles[path] = "new";
			selectedEntries.push({ path, blobRevision: blob, bytes: 3 });
		}
		const root = await git.writeTree({
			fs,
			dir,
			tree: roots.map((entry) => ({
				path: entry.name,
				mode: entry.mode,
				oid: entry.hash,
				type: "tree",
			})),
		});
		trees[root] = roots;
		const readTree = vi.fn(async (hash: string) => trees[hash] ?? null);
		await expect(
			buildCandidateCommit({
				baseCommitOid: "f".repeat(40),
				baseTreeOid: root,
				frozenFiles,
				selectedEntries,
				commitRecipe: recipe,
				readTree,
				deadlineAt: Date.now() + 30_000,
			}),
		).rejects.toThrow("tree_count");
		expect(readTree).toHaveBeenCalledTimes(64);
	});
});

describe("bounded receive-pack transport", () => {
	it("checks advertised CAS and durable fence before exactly one update", async () => {
		const input = sendInput();
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetcher: typeof fetch = async (url, init = {}) => {
			calls.push({ url: String(url), init });
			if (init.method === "GET") return response(adv(input.expectedOldOid));
			expect(input.beforePost).toHaveBeenCalledOnce();
			return response(
				packet("unpack ok\n") + packet("ok refs/heads/main\n") + "0000",
				"application/x-git-receive-pack-result",
			);
		};
		expect(await sendCandidateCommit({ ...input, fetcher })).toEqual({
			kind: "acknowledged",
			ref: input.targetRef,
			oldOid: input.expectedOldOid,
			newOid: input.commitOid,
		});
		expect(calls).toHaveLength(2);
		expect(calls.every((call) => call.init.redirect === "manual")).toBe(true);
		const body = Buffer.from(calls[1]!.init.body as Uint8Array).toString();
		expect(body).toContain(
			`${input.expectedOldOid} ${input.commitOid} refs/heads/main\0report-status\n`,
		);
		expect(body).not.toContain("side-band");
	});
	it("does not POST when the advertised base changed or authority denies", async () => {
		const input = sendInput();
		const fetcher = vi.fn(async () => response(adv("d".repeat(40))));
		expect(await sendCandidateCommit({ ...input, fetcher })).toMatchObject({
			kind: "rejected",
			reason: "candidate_git_base_changed",
		});
		expect(input.beforePost).not.toHaveBeenCalled();
		expect(fetcher).toHaveBeenCalledOnce();
		const denied = sendInput();
		denied.beforePost.mockRejectedValue(new Error("authority denied"));
		await expect(
			sendCandidateCommit({
				...denied,
				fetcher: async () => response(adv(denied.expectedOldOid)),
			}),
		).rejects.toThrow("authority denied");
	});
	it.each([
		"0001",
		packet("# service=git-receive-pack\n") + "0000",
		adv("a".repeat(40), "side-band-64k"),
		adv("a".repeat(40)).slice(0, -1),
	])(
		"rejects malformed or unsupported advertisements without publishing",
		async (body) => {
			const input = sendInput();
			await expect(
				sendCandidateCommit({ ...input, fetcher: async () => response(body) }),
			).rejects.toThrow();
			expect(input.beforePost).not.toHaveBeenCalled();
		},
	);
	it("denies redirects, foreign endpoints, and oversized packs or advertisements", async () => {
		const input = sendInput();
		for (const remote of [
			"https://example.com/repo.git",
			input.remote + "?token=x",
			input.remote.replace("https://", "https://user:pass@"),
		])
			await expect(sendCandidateCommit({ ...input, remote })).rejects.toThrow(
				"remote",
			);
		await expect(
			sendCandidateCommit({
				...input,
				pack: new Uint8Array(CANDIDATE_GIT_LIMITS.packBytes + 1),
			}),
		).rejects.toThrow("pack");
		await expect(
			sendCandidateCommit({
				...input,
				fetcher: async () =>
					new Response(null, {
						status: 307,
						headers: { Location: input.remote },
					}),
			}),
		).rejects.toThrow("http");
		await expect(
			sendCandidateCommit({
				...input,
				fetcher: async () => response("x".repeat(65537)),
			}),
		).rejects.toThrow("response_budget");
	});
	it("distinguishes explicit rejection from lost or malformed post-send responses", async () => {
		for (const [body, kind] of [
			[
				packet("unpack ok\n") +
					packet("ng refs/heads/main stale reference\n") +
					"0000",
				"rejected",
			],
			[
				packet("unpack bad pack\n") +
					packet("ng refs/heads/main failed\n") +
					"0000",
				"rejected",
			],
			["truncated", "unknown"],
			[
				packet("unpack ok\n") + packet("ok refs/heads/other\n") + "0000",
				"unknown",
			],
		]) {
			const input = sendInput();
			const fetcher: typeof fetch = async (_url, init) =>
				init?.method === "GET"
					? response(adv(input.expectedOldOid))
					: response(body!, "application/x-git-receive-pack-result");
			expect(await sendCandidateCommit({ ...input, fetcher })).toMatchObject({
				kind,
			});
		}
		const input = sendInput();
		const result = await sendCandidateCommit({
			...input,
			fetcher: async (_url, init) => {
				if (init?.method === "GET") return response(adv(input.expectedOldOid));
				throw new Error(input.authorization);
			},
		});
		expect(result).toEqual({
			kind: "unknown",
			reason: "candidate_git_publication_unknown",
		});
	});
	it("keeps a timed-out or oversized post-send response unknown", async () => {
		const input = sendInput();
		const oversized: typeof fetch = async (_url, init) =>
			init?.method === "GET"
				? response(adv(input.expectedOldOid))
				: response("x".repeat(65537), "application/x-git-receive-pack-result");
		expect(
			await sendCandidateCommit({ ...input, fetcher: oversized }),
		).toMatchObject({ kind: "unknown" });
		vi.useFakeTimers();
		try {
			const postStarted = Promise.withResolvers<void>();
			const stalled: typeof fetch = async (_url, init) => {
				if (init?.method === "GET") return response(adv(input.expectedOldOid));
				postStarted.resolve();
				return new Promise(() => {});
			};
			const sent = sendCandidateCommit({
				...input,
				fetcher: stalled,
				deadlineAt: Date.now() + 20_000,
			});
			await postStarted.promise;
			await vi.advanceTimersByTimeAsync(10_001);
			expect(await sent).toMatchObject({ kind: "unknown" });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("standard Git receiver interoperability", () => {
	it("accepts the explicit pack and rejects a branch race without force", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "candidate-git-")),
			seed = join(scratch, "seed"),
			bare = join(scratch, "git/fixture/candidate.git");
		const cli = (cwd: string, args: string[], input?: string | Uint8Array) =>
			execFileSync("git", ["-C", cwd, ...args], {
				input,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
		try {
			await mkdir(seed);
			cli(seed, ["init", "-b", "main"]);
			cli(seed, ["config", "user.name", "Fixture"]);
			cli(seed, ["config", "user.email", "fixture@example.test"]);
			cli(seed, ["config", "commit.gpgsign", "false"]);
			await writeFile(join(seed, "selected.txt"), "before\n");
			await writeFile(join(seed, "untouched.txt"), "unchanged\n");
			cli(seed, ["add", "--", "selected.txt", "untouched.txt"]);
			cli(seed, ["commit", "-m", "Fictional base"]);
			await mkdir(join(scratch, "git/fixture"), { recursive: true });
			execFileSync("git", ["clone", "--bare", seed, bare], { stdio: "pipe" });
			cli(bare, ["config", "http.receivepack", "true"]);
			const base = cli(seed, ["rev-parse", "HEAD"]),
				tree = cli(seed, ["rev-parse", "HEAD^{tree}"]),
				blob = cli(seed, ["rev-parse", "HEAD:selected.txt"]);
			const readTree = async (oid: string): Promise<ArtifactsTreeEntry[]> =>
				cli(seed, ["ls-tree", oid])
					.split("\n")
					.map((line) => {
						const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(line)!;
						return {
							mode: match[1]!,
							type: match[2] as "blob",
							hash: match[3]!,
							name: match[4]!,
						};
					});
			const built = await buildCandidateCommit({
				baseCommitOid: base,
				baseTreeOid: tree,
				frozenFiles: { "selected.txt": "after\n" },
				selectedEntries: [
					{ path: "selected.txt", blobRevision: blob, bytes: 7 },
				],
				commitRecipe: recipe,
				readTree,
				deadlineAt: Date.now() + 30_000,
			});
			const fetcher: typeof fetch = async (url, init = {}) => {
				const target = new URL(String(url)),
					body = init.body
						? Buffer.from(init.body as Uint8Array)
						: Buffer.alloc(0);
				const child = spawn("git", ["http-backend"], {
					env: {
						PATH: process.env.PATH,
						GIT_PROJECT_ROOT: scratch,
						GIT_HTTP_EXPORT_ALL: "1",
						REQUEST_METHOD: init.method ?? "GET",
						PATH_INFO: target.pathname,
						QUERY_STRING: target.search.slice(1),
						CONTENT_TYPE: new Headers(init.headers).get("Content-Type") ?? "",
						CONTENT_LENGTH: String(body.length),
						REMOTE_USER: "fixture",
					},
					stdio: ["pipe", "pipe", "pipe"],
				});
				const chunks: Buffer[] = [];
				child.stdout.on("data", (chunk) => chunks.push(chunk));
				child.stderr.resume();
				child.stdin.end(body);
				await new Promise<void>((resolve, reject) => {
					child.on("error", reject);
					child.on("exit", (code) =>
						code === 0
							? resolve()
							: reject(new Error("fixture Git backend failed")),
					);
				});
				const output = Buffer.concat(chunks),
					split = output.indexOf("\r\n\r\n"),
					headers = new Headers();
				for (const line of output.subarray(0, split).toString().split("\r\n")) {
					const colon = line.indexOf(":");
					if (colon > 0)
						headers.set(line.slice(0, colon), line.slice(colon + 1).trim());
				}
				return new Response(output.subarray(split + 4), {
					status: Number(headers.get("Status")?.slice(0, 3) ?? 200),
					headers,
				});
			};
			const request = {
				remote,
				targetRef: "refs/heads/main",
				expectedOldOid: base,
				commitOid: built.commitOid,
				pack: built.pack,
				authorization: "Bearer fixture-private",
				fetcher,
				deadlineAt: Date.now() + 30_000,
				beforePost: async () => {},
			};
			expect(await sendCandidateCommit(request)).toMatchObject({
				kind: "acknowledged",
			});
			expect(cli(bare, ["rev-parse", "main"])).toBe(built.commitOid);
			expect(cli(bare, ["show", "main:selected.txt"])).toBe("after");
			expect(cli(bare, ["show", "main:untouched.txt"])).toBe("unchanged");
			expect(
				cli(bare, [
					"diff-tree",
					"--no-commit-id",
					"--name-only",
					"-r",
					base,
					built.commitOid,
				]),
			).toBe("selected.txt");
			cli(bare, ["update-ref", "refs/heads/main", base]);
			const other = cli(
				bare,
				[
					"-c",
					"user.name=Fixture",
					"-c",
					"user.email=fixture@example.test",
					"commit-tree",
					tree,
					"-p",
					base,
				],
				"Another writer\n",
			);
			expect(
				await sendCandidateCommit({
					...request,
					deadlineAt: Date.now() + 30_000,
					beforePost: async () => {
						cli(bare, ["update-ref", "refs/heads/main", other]);
					},
				}),
			).toMatchObject({ kind: "rejected" });
			expect(cli(bare, ["rev-parse", "main"])).toBe(other);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});
});
