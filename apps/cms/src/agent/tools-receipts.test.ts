import git from "isomorphic-git";
import { GitMemoryFs } from "@tedix/worker-kit/git-memory-fs";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toJSONSchema, type ZodType } from "zod";
import { findSecretValuePattern } from "../../../mcp/src/mcp/utils/secret-egress-scan";
const mocks = vi.hoisted(() => ({
	inputSchemas: new Map<string, ZodType>(),
	outputSchemas: new Map<string, ZodType>(),
	handlers: new Map<
		string,
		(args: Record<string, unknown>) => Promise<{
			structuredContent: Record<string, unknown>;
		}>
	>(),
	start: vi.fn(),
	read: vi.fn(),
	cancel: vi.fn(),
}));
vi.mock("@tedix/mcp-shared/server", () => ({
	createMcpServer: () => ({
		registerTool: (
			name: string,
			config: { outputSchema: ZodType; inputSchema: ZodType },
			handler: never,
		) => {
			mocks.inputSchemas.set(name, config.inputSchema);
			mocks.outputSchemas.set(name, config.outputSchema);
			mocks.handlers.set(name, handler);
		},
	}),
}));
vi.mock("./preview-exec-runner", async (original) => ({
	...(await original<object>()),
	startCmsPreviewExec: mocks.start,
	readCmsPreviewExecStatus: mocks.read,
	cancelCmsPreviewExec: mocks.cancel,
}));
vi.mock("./build-runner", async (original) => ({
	...(await original<object>()),
	readCmsSandboxBuildStatus: mocks.read,
	cancelCmsSandboxBuild: mocks.cancel,
}));
vi.mock("./theme-artifacts", async (original) => ({
	...(await original<object>()),
	readThemeArtifactRepoSeedStatus: mocks.read,
	readThemeArtifactRepoCommitStatus: mocks.read,
	cancelThemeArtifactRepoSeed: mocks.cancel,
}));
import { buildSiteBuilderMcpServer } from "./tools";
import type { SiteBuilderToolContext } from "./tools-shared";

const terminal = {
	jobId: "one",
	status: "complete",
	exitCode: 0,
	running: false,
	startedAt: "2026-09-20T03:48:24.711Z",
	durationMs: 288,
	stdoutTail: "stdout\n",
	stderrTail: "stderr\n",
	logTail: "stdout\nstderr\n",
	command: "echo ok",
	seed: { commit: "abc", ok: true },
	successMarkerDetected: true,
	message: "complete",
};
const running = {
	...terminal,
	status: "running",
	exitCode: null,
	running: true,
};
const missing = {
	...terminal,
	status: "failed",
	exitCode: null,
	running: false,
	startedAt: null,
	durationMs: null,
	stdoutTail: "",
	stderrTail: "",
	logTail: "",
	seed: null,
	message: "process was not found",
};

function setup(
	initial: Record<string, unknown> | null,
	overrides: Partial<SiteBuilderToolContext> = {},
) {
	let value = initial;
	let revision = 1;
	let race: (() => void) | undefined;
	const put = vi.fn(
		async (_key: string, body: string, options: R2PutOptions) => {
			race?.();
			race = undefined;
			const condition = options.onlyIf as R2Conditional;
			if (
				value
					? condition.etagMatches !== String(revision)
					: condition.etagDoesNotMatch !== "*"
			)
				return null;
			value = JSON.parse(body);
			revision++;
			return { etag: String(revision) };
		},
	);
	const storage = {
		get: vi.fn(async () => {
			const snapshot = value;
			const etag = String(revision);
			return snapshot ? { etag, json: async () => snapshot } : null;
		}),
		put,
	};
	const artifactCommitSandbox = vi.fn(() => ({}));
	buildSiteBuilderMcpServer({
		orgSlug: "acme",
		templateSlug: "tedix",
		storage,
		sandbox: {},
		artifactCommitSandbox,
		...overrides,
	} as unknown as SiteBuilderToolContext);
	return {
		put,
		artifactCommitSandbox,
		stored: () => value,
		raceWith: (winner: Record<string, unknown>) => {
			race = () => {
				value = winner;
				revision++;
			};
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.handlers.clear();
	mocks.outputSchemas.clear();
});

it("returns schema-valid JSON preview output when process properties are RPC stubs", async () => {
	const status = vi.fn(async () => ({
		state: "running",
		command: ["bunx", "astro", "dev"],
		startedAt: terminal.startedAt,
	}));
	const process = {
		id: vi.fn(() => {
			throw new Error("Do not read the RPC id property");
		}),
		status,
		logSnapshot: vi.fn(async () => ({
			stdout: "ready",
			stderr: "",
			truncated: false,
		})),
		waitForPort: vi.fn(),
	};
	const getCmsJobId = vi
		.fn()
		.mockResolvedValueOnce(null)
		.mockResolvedValue("native-preview");
	setup(null, {
		previewHostname: "preview.example.com",
		sandbox: {
			getCmsJobId,
			launchCmsJob: vi.fn(async () => "native-preview"),
			getProcess: vi.fn(async () => process),
		} as unknown as SiteBuilderToolContext["sandbox"],
	});
	for (const tool of ["theme_preview_start", "theme_preview_status"]) {
		const { structuredContent } = await mocks.handlers.get(tool)!({});
		expect(structuredContent.processId).toBe("native-preview");
		expect(mocks.outputSchemas.get(tool)!.parse(structuredContent)).toEqual(
			structuredContent,
		);
		expect(JSON.parse(JSON.stringify(structuredContent))).toEqual(
			structuredContent,
		);
	}
});

it.each([false, true])(
	"commits editable files without a sandbox and fences a concurrent push (deletion: %s)",
	async (deletion) => {
		const fs = new GitMemoryFs();
		const dir = "/remote";
		await git.init({ fs, dir, defaultBranch: "main" });
		const blob = await git.writeBlob({
			fs,
			dir,
			blob: new TextEncoder().encode("existing"),
		});
		const pages = await git.writeTree({
			fs,
			dir,
			tree: [
				{ mode: "100755", type: "blob", oid: blob, path: "index.astro" },
				{ mode: "120000", type: "blob", oid: blob, path: "link" },
				{
					mode: "100644",
					type: "blob",
					oid: blob,
					path: "sitemap-apps.xml.ts",
				},
				{
					mode: "040000",
					type: "tree",
					oid: await git.writeTree({
						fs,
						dir,
						tree: [
							{ mode: "100644", type: "blob", oid: blob, path: "last.astro" },
						],
					}),
					path: "obsolete",
				},
			],
		});
		const src = await git.writeTree({
			fs,
			dir,
			tree: [{ mode: "040000", type: "tree", oid: pages, path: "pages" }],
		});
		const tree = await git.writeTree({
			fs,
			dir,
			tree: [
				{ mode: "040000", type: "tree", oid: src, path: "src" },
				{ mode: "100644", type: "blob", oid: blob, path: "README.md" },
			],
		});
		const author = {
			name: "Test",
			email: "test@example.invalid",
			timestamp: 1,
			timezoneOffset: 0,
		};
		const base = await git.writeCommit({
			fs,
			dir,
			commit: { tree, parent: [], author, committer: author, message: "Base" },
		});
		let head = base;
		let wrongReadback = false;
		const competitor = "b".repeat(40);
		const createToken = vi.fn(async () => ({ plaintext: "fixture-private" }));
		const repo = {
			log: async () => [{ hash: head }],
			readCommit: vi.fn(async (oid: string) => ({
				hash: oid,
				treeHash:
					wrongReadback && oid !== base
						? tree
						: (await git.readCommit({ fs, dir, oid })).commit.tree,
			})),
			readTree: async (oid: string) =>
				(await git.readTree({ fs, dir, oid })).tree.map((entry) => ({
					name: entry.path,
					mode: entry.mode,
					type: entry.type,
					hash: entry.oid,
				})),
			createToken,
			[Symbol.dispose]() {},
		};
		const receipts = new Map<string, string>();
		const f = setup(null, {
			artifacts: {
				get: async () => repo,
			} as unknown as SiteBuilderToolContext["artifacts"],
			artifactsAccountId: "a".repeat(32),
			artifactsNamespace: "test",
			storage: {
				get: async (key: string) => {
					const body = receipts.get(key);
					return body
						? { etag: "saved", json: async () => JSON.parse(body) }
						: null;
				},
				put: async (key: string, body: string) => {
					receipts.set(key, body);
					return { etag: "saved" };
				},
			} as unknown as R2Bucket,
			sandbox: new Proxy({} as SiteBuilderToolContext["sandbox"], {
				get() {
					throw new Error("Authoring sandbox unavailable");
				},
			}),
		});
		f.artifactCommitSandbox.mockImplementation(() => {
			throw new Error("Job sandbox unavailable");
		});
		let race = false;
		const ref = "refs/heads/main";
		const packet = (value: string) =>
			(value.length + 4).toString(16).padStart(4, "0") + value;
		const fetcher = vi.fn<typeof fetch>(async (_url, init = {}) => {
			expect(new Headers(init.headers).get("Authorization")).toBe(
				"Bearer fixture-private",
			);
			expect(init.redirect).toBe("manual");
			if (init.method === "GET") {
				return new Response(
					packet("# service=git-receive-pack\n") +
						"0000" +
						// Captured Artifacts advertisement shape; repository names and OIDs replaced.
						packet(
							head +
								" HEAD\0agent=gitty/1.0 object-format=sha1 report-status report-status-v2 delete-refs atomic ofs-delta side-band side-band-64k symref=HEAD:refs/heads/main\n",
						) +
						packet(competitor + " refs/heads/agent/draft\n") +
						packet(head + " " + ref + "\n") +
						packet(competitor + " refs/tags/bundle-v1\n") +
						packet(head + " refs/tags/bundle-v1^{}\n") +
						"0000",
					{
						headers: {
							"Content-Type": "application/x-git-receive-pack-advertisement",
						},
					},
				);
			}
			const body = init.body as Uint8Array;
			const decoder = new TextDecoder();
			const size = Number.parseInt(decoder.decode(body.subarray(0, 4)), 16);
			const [oldOid, newOid] = decoder
				.decode(body.subarray(4, size))
				.split(" ");
			expect(oldOid).toBe(base);
			expect(decoder.decode(body.subarray(size, size + 4))).toBe("0000");
			if (race) head = competitor;
			let status = "ng " + ref + " failed to lock\n";
			if (oldOid === head) {
				const filepath = ".git/objects/pack/fixture.pack";
				await fs.promises.mkdir(dir + "/.git/objects/pack", {
					recursive: true,
				});
				await fs.promises.writeFile(
					dir + "/" + filepath,
					body.subarray(size + 4),
				);
				const { oids } = await git.indexPack({ fs, dir, filepath });
				expect(oids).toContain(newOid);
				head = newOid!;
				status = "ok " + ref + "\n";
			}
			return new Response(packet("unpack ok\n") + packet(status) + "0000", {
				headers: { "Content-Type": "application/x-git-receive-pack-result" },
			});
		});
		vi.stubGlobal("fetch", fetcher);
		try {
			const commit = mocks.handlers.get("commit_theme_artifact_files")!;
			const path = "src/pages/sitemap-apps.xml.ts";
			const args = {
				expectedHead: base,
				message: "Fix app sitemap",
				themeRelease: {
					upstreamStarterRevision: "1234567890abcdef1234567890abcdef12345678",
					supportedBlocks: { marketing_hero: [1, 2] },
				},
				files: [
					...(deletion
						? [
								{ path, delete: true },
								{ path: "src/pages/obsolete/last.astro", delete: true },
								{ path: "src/pages/missing/file.astro", delete: true },
							]
						: [{ path, content: "new route\n" }]),
					{
						path: "src/pages/index.astro",
						content: deletion ? "" : "updated page\n",
					},
				],
			};
			const input = mocks.inputSchemas.get("commit_theme_artifact_files")!;
			expect(input.safeParse(args).success).toBe(true);
			const jsonSchema = toJSONSchema(input, { unrepresentable: "any" });
			expect(findSecretValuePattern(args, jsonSchema)).toBeNull();
			expect(input.safeParse({ ...args, files: [] }).success).toBe(true);
			for (const themeRelease of [
				{ ...args.themeRelease, upstreamStarterRevision: "invalid" },
				{ ...args.themeRelease, supportedBlocks: { marketing_hero: [0] } },
				{ ...args.themeRelease, credential: "unexpected" },
			])
				expect(input.safeParse({ ...args, themeRelease }).success).toBe(false);
			for (const credentials of [
				{ ...args, message: "Bearer fixture_credential_1234567890" },
				{
					...args,
					files: [
						{
							path,
							content: "token=AbCd0123456789AbCd0123456789AbCd0123456789",
						},
					],
				},
				{
					...args,
					themeRelease: {
						...args.themeRelease,
						supportedBlocks: {
							AbCd0123456789AbCd0123456789AbCd0123456789: [1],
						},
					},
				},
				{
					...args,
					themeRelease: {
						...args.themeRelease,
						upstreamStarterRevision: "ghp_" + "123456".repeat(6),
					},
				},
			])
				expect(findSecretValuePattern(credentials, jsonSchema)).not.toBeNull();
			expect(
				findSecretValuePattern(
					{
						...args,
						themeRelease: undefined,
						files: [
							{
								path: "src/theme-release.json",
								content: JSON.stringify(args.themeRelease),
							},
						],
					},
					jsonSchema,
				),
			).toBe("long opaque token");
			for (const invalid of [
				{ ...args, themeRelease: undefined, files: [] },
				{ ...args, files: [{ path: "src/theme-release.json", delete: true }] },
			])
				expect(await commit(invalid)).toMatchObject({ isError: true });
			for (const file of [
				{ path },
				{ path, delete: false },
				{ path, delete: true, content: "" },
			])
				expect(input.safeParse({ ...args, files: [file] }).success).toBe(false);
			for (const files of [
				[{ path: "package.json", delete: true }],
				[{ path: "src/pages/../index.astro", delete: true }],
				[
					{ path, delete: true },
					{ path, content: "" },
				],
			])
				expect(await commit({ ...args, files })).toMatchObject({
					isError: true,
				});
			const reply = await commit(args);
			const committed = head;
			expect(reply.structuredContent).toMatchObject({
				status: "complete",
				result: { committed: true, commit: committed },
			});
			expect(JSON.stringify(reply)).not.toContain("fixture-private");
			const stored = await git.readCommit({ fs, dir, oid: committed });
			expect(stored.commit.parent).toEqual([base]);
			expect(
				JSON.parse(
					new TextDecoder().decode(
						(
							await git.readBlob({
								fs,
								dir,
								oid: committed,
								filepath: "src/theme-release.json",
							})
						).blob,
					),
				),
			).toEqual(args.themeRelease);
			expect(
				(await git.readBlob({ fs, dir, oid: committed, filepath: "README.md" }))
					.oid,
			).toBe(blob);
			if (deletion) {
				expect(repo.readCommit).toHaveBeenCalledWith(committed);
				expect(reply.structuredContent.result).toMatchObject({
					deletedPaths: args.files
						.filter((file) => "delete" in file)
						.map((file) => file.path),
				});
				await expect(
					git.readBlob({ fs, dir, oid: committed, filepath: path }),
				).rejects.toThrow();
			} else
				expect(
					new TextDecoder().decode(
						(await git.readBlob({ fs, dir, oid: committed, filepath: path }))
							.blob,
					),
				).toBe("new route\n");
			const updatedPages = await git.readTree({
				fs,
				dir,
				oid: committed,
				filepath: "src/pages",
			});
			expect(updatedPages.tree).toContainEqual(
				expect.objectContaining({ path: "index.astro", mode: "100755" }),
			);
			expect(updatedPages.tree).toContainEqual({
				path: "link",
				mode: "120000",
				type: "blob",
				oid: blob,
			});
			if (deletion) {
				expect(
					updatedPages.tree.some((entry) =>
						["obsolete", "missing", "sitemap-apps.xml.ts"].includes(entry.path),
					),
				).toBe(false);
				expect(
					(
						await git.readBlob({
							fs,
							dir,
							oid: committed,
							filepath: "src/pages/index.astro",
						})
					).blob.byteLength,
				).toBe(0);
			}
			const status = await mocks.handlers.get("theme_artifact_commit_status")!({
				jobId: reply.structuredContent.jobId,
			});
			expect(status.structuredContent).toMatchObject({
				result: { committed: true, commit: committed },
			});
			expect((await commit(args)).structuredContent).toMatchObject({
				result: { conflict: true, remoteHead: committed },
			});
			expect(
				(await commit({ ...args, expectedHead: committed })).structuredContent,
			).toMatchObject({ result: { unchanged: true, commit: committed } });
			await expect(
				commit({
					...args,
					expectedHead: committed,
					files: [{ path: "src/pages/link/route.ts", content: "blocked" }],
				}),
			).rejects.toThrow("parent is not a directory");
			expect(createToken).toHaveBeenCalledOnce();
			expect(fetcher).toHaveBeenCalledTimes(2);

			head = base;
			for (const path of ["src/pages/link", "src/pages/obsolete"])
				await expect(
					commit({ ...args, files: [{ path, delete: true }] }),
				).rejects.toThrow("destination is not a regular file");
			race = true;
			expect((await commit(args)).structuredContent).toMatchObject({
				result: { conflict: true, remoteHead: competitor },
			});
			expect(head).toBe(competitor);
			if (deletion) {
				head = base;
				race = false;
				wrongReadback = true;
				await expect(commit(args)).rejects.toThrow(
					"Artifacts tree was not confirmed at commit",
				);
			}
			if (!deletion) {
				head = base;
				race = false;
				expect(
					(await commit({ ...args, files: [] })).structuredContent,
				).toMatchObject({
					result: { committed: true, commit: head },
				});
				expect(
					JSON.parse(
						new TextDecoder().decode(
							(
								await git.readBlob({
									fs,
									dir,
									oid: head,
									filepath: "src/theme-release.json",
								})
							).blob,
						),
					),
				).toEqual(args.themeRelease);
			}
			expect(f.artifactCommitSandbox).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	},
);

it("refuses unknown isolated commit status before obtaining a container", async () => {
	const f = setup(null);
	await expect(
		mocks.handlers.get("theme_artifact_commit_status")!({
			jobId: "tac-00000000-0000-4000-8000-000000000000",
		}),
	).rejects.toThrow("job receipt was not found");
	expect(f.artifactCommitSandbox).not.toHaveBeenCalled();
	expect(mocks.read).not.toHaveBeenCalled();
});

it("polls only the admitted isolated job and preserves its terminal receipt", async () => {
	const jobId = "tac-00000000-0000-4000-8000-000000000000";
	const f = setup({ ...running, jobId });
	mocks.read.mockResolvedValue({
		...terminal,
		jobId,
		startedAt: Date.parse(terminal.startedAt),
	});
	const result = await mocks.handlers.get("theme_artifact_commit_status")!({
		jobId,
	});
	expect(result.structuredContent).toMatchObject({ jobId, status: "complete" });
	expect(f.artifactCommitSandbox).toHaveBeenCalledWith(jobId);
	expect(f.artifactCommitSandbox).toHaveBeenCalledOnce();
});

it("allows a native container cold start beyond the short probe timeout", async () => {
	vi.useFakeTimers();
	try {
		setup(null);
		mocks.start.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30_000));
			return {
				jobId: "one",
				processId: "native-one",
				startedAt: Date.parse(terminal.startedAt),
			};
		});
		mocks.read.mockResolvedValue({
			...terminal,
			startedAt: Date.parse(terminal.startedAt),
		});
		const result = mocks.handlers.get("theme_preview_exec")!({
			command: "echo ok",
			waitMs: 0,
		});
		let settled = false;
		void result.finally(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(25_001);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(4_999);
		expect((await result).structuredContent.status).toBe("complete");
	} finally {
		vi.useRealTimers();
	}
});

describe.each(["theme_preview_exec", "theme_build", "theme_artifact_seed"])(
	"%s receipts",
	(tool) => {
		const call = (suffix: string) =>
			mocks.handlers.get(`${tool}_${suffix}`)!({ jobId: "one" });
		it.each([
			["complete", 0],
			["timeout", 124],
			["cancelled", null],
			["failed", 1],
		])(
			"retains %s after process loss on status and cancel",
			async (status, exitCode) => {
				const receipt = { ...terminal, status, exitCode };
				const f = setup(receipt);
				expect((await call("status")).structuredContent).toEqual(receipt);
				expect((await call("cancel")).structuredContent).toEqual({
					...receipt,
					cancelled: false,
					previousStatus: status,
				});
				expect(mocks.read).not.toHaveBeenCalled();
				expect(mocks.cancel).not.toHaveBeenCalled();
				expect(f.put).not.toHaveBeenCalled();
				expect(f.stored()).toEqual(receipt);
			},
		);
		it("does not turn loss of a running process into a terminal proof", async () => {
			const f = setup(running);
			mocks.read.mockResolvedValue(missing);
			const lost = (await call("status")).structuredContent;
			expect(lost).toMatchObject({
				status: "failed",
				exitCode: null,
				durationMs: 288,
				logTail: terminal.logTail,
			});
			mocks.read.mockResolvedValue({
				...terminal,
				startedAt: Date.parse(terminal.startedAt),
			});
			expect((await call("status")).structuredContent.status).toBe("complete");
			expect(f.stored()?.status).toBe("complete");
			expect(mocks.read).toHaveBeenCalledTimes(2);
		});
		it.each([null, running])(
			"a stale observation cannot overwrite a concurrent terminal receipt",
			async (initial) => {
				const f = setup(initial);
				mocks.read.mockResolvedValue({
					...running,
					startedAt: Date.parse(terminal.startedAt),
				});
				f.raceWith(terminal);
				expect((await call("status")).structuredContent).toEqual(terminal);
				expect(f.stored()).toEqual(terminal);
				expect(mocks.read).toHaveBeenCalledOnce();
			},
		);
		it("persists the first observed terminal result with an absence condition", async () => {
			const f = setup(null);
			mocks.read.mockResolvedValue({
				...terminal,
				startedAt: Date.parse(terminal.startedAt),
			});
			const result = await call("status");
			expect(result.structuredContent).toMatchObject({
				status: "complete",
				exitCode: 0,
				durationMs: 288,
			});
			expect(f.put.mock.calls[0]?.[2].onlyIf).toEqual({
				etagDoesNotMatch: "*",
			});
			expect(f.stored()).toEqual(result.structuredContent);
		});
		it("surfaces repeated CAS conflicts without an unconditional write or repeated cancellation", async () => {
			const f = setup(running);
			f.put.mockResolvedValue(null);
			mocks.cancel.mockResolvedValue({
				...terminal,
				startedAt: Date.parse(terminal.startedAt),
				cancelled: false,
				previousStatus: "complete",
			});
			await expect(call("cancel")).rejects.toThrow("changed concurrently");
			expect(mocks.cancel).toHaveBeenCalledOnce();
			expect(f.stored()).toEqual(running);
			expect(
				f.put.mock.calls.every(
					(call) => (call[2].onlyIf as R2Conditional).etagMatches === "1",
				),
			).toBe(true);
		});
		it("cancel preserves terminal winner and does not repeat the native effect after CAS conflict", async () => {
			const f = setup(running);
			mocks.cancel.mockResolvedValue({
				...terminal,
				status: "cancelled",
				exitCode: 143,
				startedAt: Date.parse(terminal.startedAt),
				cancelled: true,
				previousStatus: "running",
			});
			f.raceWith(terminal);
			expect((await call("cancel")).structuredContent).toMatchObject({
				status: "complete",
				exitCode: 0,
				durationMs: 288,
				cancelled: false,
			});
			expect(f.stored()).toEqual(terminal);
			expect(mocks.cancel).toHaveBeenCalledOnce();
		});
	},
);
