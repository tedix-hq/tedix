import { afterEach, expect, it, vi } from "vite-plus/test";
import { encryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import {
	REPO_CLONE_MAX_CHECKOUT_KB,
	REPO_LOAD_MAX_TOTAL_BYTES,
	runRepoClone,
	runRepoLoad,
	type RepoLoadDeps,
} from "../src/repo-load";
import {
	BROAD_MONOREPO_PATHS,
	monorepoTree,
	monorepoTreeBytes,
} from "./monorepo-tree-fixture";

// Runs the production clone_repo/repo_load selection inside workerd, the
// runtime whose Durable Object isolate the CTO tedi exhausted on 25 Oct.
// GitHub is scripted; nothing leaves the test.

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const TEDI_ID = "00000000-0000-4000-8000-0000000000c7";
const PAT = "ghp_fixture_never_surfaced";

async function repoDeps(
	writeFile: RepoLoadDeps["writeFile"],
): Promise<RepoLoadDeps> {
	const encrypted = await encryptTediSecret(MASTER_KEY, TEDI_ID, PAT);
	return {
		masterKey: MASTER_KEY,
		writeFile,
		db: {
			prepare: (sql: string) => ({
				bind: () => ({
					first: async <T>() =>
						(sql.includes("repo_config")
							? {
									repo_config: JSON.stringify({
										repoUrl: "https://github.com/example/monorepo",
										branch: "main",
									}),
								}
							: sql.includes("tedi_secrets")
								? { encrypted_value: encrypted }
								: null) as T | null,
				}),
			}),
		},
	};
}

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

it("refuses a broad monorepo clone from tree metadata, downloading no blob", async () => {
	const tree = monorepoTree();
	expect(monorepoTreeBytes(tree)).toBeGreaterThan(
		REPO_CLONE_MAX_CHECKOUT_KB * 1024,
	);
	let blobReads = 0;
	const github = async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/git/trees/")) return json({ truncated: false, tree });
		blobReads++;
		return json({ content: "", encoding: "base64" });
	};
	vi.stubGlobal("fetch", github);
	let writes = 0;
	const deps = await repoDeps(async () => {
		writes++;
	});
	let cloned = false;

	const result = await runRepoClone(
		{
			...deps,
			fetchImpl: github as typeof fetch,
			clone: async () => {
				cloned = true;
			},
			removeCloneDir: async () => {},
			loadFilesFallback: ({ ref, paths }) =>
				runRepoLoad(deps, { tediId: TEDI_ID, paths, ref }),
			replaceFallbackSnapshot: async () => {
				throw new Error("a refused selection never replaces repo/");
			},
		},
		{ tediId: TEDI_ID, paths: BROAD_MONOREPO_PATHS },
	);

	expect(result).toMatchObject({
		ok: false,
		error: "too_large_for_native",
		escalate: "workstation",
		selection: { fileCount: 8_483 },
		fallback: { result: { error: "too_many_files" } },
	});
	expect(cloned).toBe(false);
	expect(blobReads).toBe(0);
	expect(writes).toBe(0);
	expect(JSON.stringify(result)).not.toContain(PAT);
});

it("holds at most the in-flight blobs of a within-budget selection", async () => {
	const fileCount = 150;
	const fileBytes = 30_000; // 4.5 MB in total, under the 5 MB repo_load cap
	expect(fileCount * fileBytes).toBeLessThan(REPO_LOAD_MAX_TOTAL_BYTES);
	const body = "z".repeat(fileBytes);
	const encoded = btoa(body);
	let heldBytes = 0;
	let peakHeldBytes = 0;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/git/trees/")) {
			return json({
				truncated: false,
				tree: Array.from({ length: fileCount }, (_, i) => ({
					type: "blob",
					path: `packages/db/src/f${i}.ts`,
					sha: `sha-${i}`,
					size: fileBytes,
				})),
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		heldBytes += fileBytes;
		peakHeldBytes = Math.max(peakHeldBytes, heldBytes);
		return json({ content: encoded, encoding: "base64" });
	});
	const persisted: string[] = [];
	const deps = await repoDeps(async (path, content) => {
		expect(content.length).toBe(fileBytes);
		persisted.push(path);
		heldBytes -= fileBytes;
	});

	const result = await runRepoLoad(deps, {
		tediId: TEDI_ID,
		paths: ["packages/db"],
		maxFiles: 200,
	});

	expect(result).toMatchObject({
		ok: true,
		fileCount,
		totalBytes: fileCount * fileBytes,
	});
	expect(persisted).toHaveLength(fileCount);
	// Six concurrent blob reads bound what is resident at once: the selection
	// never accumulates in the isolate before it is written out.
	expect(peakHeldBytes).toBeLessThanOrEqual(6 * fileBytes);
});
