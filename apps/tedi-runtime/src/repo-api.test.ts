/**
 * Offline tests for the GitHub REST API module (Phase 1: read, Phase 2: write).
 * Mocks `globalThis.fetch` — no real network calls.
 *
 * Run: `bun run src/repo-api.test.ts`
 */
import assert from "node:assert/strict";
import {
	commitRepoChanges,
	loadRepoFilesResult,
	openPullRequest,
	RepoAuthError,
	RepoNotFoundError,
	RepoRateLimitError,
	RepoSecondaryRateLimitError,
	RepoTreeTruncatedError,
	RepoUnsafeRefError,
	readRepoBlob,
	utf8ToBase64,
} from "./repo-api";

// ── Minimal fetch mock helpers ─────────────────────────────────────────────────

// loadRepoFilesResult is the only tree reader, so tree-level assertions read
// blob refs back through it: a blob read the handler does not answer echoes
// the requested sha as the file content.
function mockFetch(handler: (url: string) => Response): void {
	globalThis.fetch = async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		const res = handler(url);
		const blob = /\/git\/blobs\/([^/?#]+)$/.exec(url);
		if (blob && res.status === 404) {
			return jsonResponse({
				content: utf8ToBase64(blob[1]!),
				encoding: "base64",
			});
		}
		return res;
	};
}

function jsonResponse(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

const OWNER = "tedix";
const REPO = "platform";
const REF = "main";
const TOKEN = "ghp_test_token_never_logged";

async function loadTree(opts: {
	owner: string;
	repo: string;
	ref: string;
	token: string;
	paths?: string[];
}): Promise<Array<{ path: string; sha: string }>> {
	const { files } = await loadRepoFilesResult({
		...opts,
		paths: opts.paths ?? [],
	});
	return files.map((file) => ({ path: file.path, sha: file.content }));
}

// ── 1. tree read: basic load, blobs only, path-prefix filter ───────────────

{
	mockFetch((url) => {
		if (!url.includes(`/repos/${OWNER}/${REPO}/git/trees/${REF}?recursive=1`)) {
			return jsonResponse({ message: "Not Found" }, 404);
		}
		return jsonResponse({
			truncated: false,
			tree: [
				{ type: "tree", path: "src", sha: "tree-sha-1", size: 0 },
				{ type: "blob", path: "src/index.ts", sha: "blob-sha-1", size: 100 },
				{ type: "blob", path: "src/utils.ts", sha: "blob-sha-2", size: 200 },
				{ type: "blob", path: "README.md", sha: "blob-sha-3", size: 50 },
			],
		});
	});

	const all = await loadTree({
		owner: OWNER,
		repo: REPO,
		ref: REF,
		token: TOKEN,
	});
	// Only blobs returned — the tree entry is excluded
	assert.equal(all.length, 3, "returns 3 blobs (no tree entries)");
	assert.ok(
		all.every((b) => b.sha && b.path),
		"each entry has path/sha",
	);
	console.log("✓ test 1a: tree read returns only blobs");
}

{
	mockFetch(() =>
		jsonResponse({
			truncated: false,
			tree: [
				{ type: "blob", path: "src/index.ts", sha: "blob-sha-1", size: 100 },
				{ type: "blob", path: "src/utils.ts", sha: "blob-sha-2", size: 200 },
				{ type: "blob", path: "README.md", sha: "blob-sha-3", size: 50 },
			],
		}),
	);

	const filtered = await loadTree({
		owner: OWNER,
		repo: REPO,
		ref: REF,
		token: TOKEN,
		paths: ["src/"],
	});
	assert.equal(filtered.length, 2, "path-prefix filter returns 2 src/ blobs");
	assert.ok(
		filtered.every((b) => b.path.startsWith("src/")),
		"all results start with src/",
	);
	console.log("✓ test 1b: tree read path-prefix filter");
}

// ── 2. readRepoBlob: sha/size fields preserved; base64 decode ────────────────

{
	const rawText = "export const x = 1;\n";
	const b64 = btoa(rawText);

	// GitHub wraps base64 at 60 chars — simulate that
	const wrapped = b64.match(/.{1,60}/g)?.join("\n") ?? b64;

	mockFetch((url) => {
		assert.ok(
			url.includes("/git/blobs/blob-sha-1"),
			"calls blobs API with sha",
		);
		return jsonResponse({ content: wrapped, encoding: "base64" });
	});

	const content = await readRepoBlob({
		owner: OWNER,
		repo: REPO,
		sha: "blob-sha-1",
		token: TOKEN,
	});
	assert.equal(
		content,
		rawText,
		"base64 decode with wrapped lines returns original text",
	);
	console.log("✓ test 2: readRepoBlob base64 decode");
}

// ── 2b. readRepoBlob: multi-byte UTF-8 survives the base64 decode ─────────────

{
	// Regression: atob() alone left em dashes as Latin-1 bytes, which the
	// write path then double-encoded (e2 80 94 → c3 a2 c2 80 c2 94).
	const rawText = "runtime swap — état must survive 🙂\n";
	const utf8Bytes = new TextEncoder().encode(rawText);
	let binary = "";
	for (const byte of utf8Bytes) binary += String.fromCharCode(byte);
	const b64 = btoa(binary);
	const wrapped = b64.match(/.{1,60}/g)?.join("\n") ?? b64;

	mockFetch(() => jsonResponse({ content: wrapped, encoding: "base64" }));

	const content = await readRepoBlob({
		owner: OWNER,
		repo: REPO,
		sha: "blob-sha-utf8",
		token: TOKEN,
	});
	assert.equal(
		content,
		rawText,
		"multi-byte UTF-8 (em dash, accents, emoji) survives blob decode",
	);
	console.log("✓ test 2b: readRepoBlob multi-byte UTF-8 decode");
}

// ── 3. tree truncated WITH paths → Contents API fallback ──────────────

{
	let callCount = 0;
	mockFetch((url) => {
		callCount++;
		if (url.includes("/git/trees/")) {
			return jsonResponse({ truncated: true, tree: [] });
		}
		// Contents API per-path
		if (
			url.includes("/contents/src%2Findex.ts") ||
			url.includes("/contents/src/index.ts")
		) {
			return jsonResponse({
				type: "file",
				path: "src/index.ts",
				sha: "c-sha-1",
				size: 111,
			});
		}
		if (
			url.includes("/contents/src%2Futils.ts") ||
			url.includes("/contents/src/utils.ts")
		) {
			return jsonResponse({
				type: "file",
				path: "src/utils.ts",
				sha: "c-sha-2",
				size: 222,
			});
		}
		return jsonResponse({ message: "Not Found" }, 404);
	});

	const blobs = await loadTree({
		owner: OWNER,
		repo: REPO,
		ref: REF,
		token: TOKEN,
		paths: ["src/index.ts", "src/utils.ts"],
	});
	assert.equal(blobs.length, 2, "fallback resolves 2 paths via Contents API");
	assert.ok(
		blobs.some((b) => b.sha === "c-sha-1"),
		"first blob sha preserved",
	);
	assert.ok(
		blobs.some((b) => b.sha === "c-sha-2"),
		"second blob sha preserved",
	);
	assert.equal(
		callCount,
		5,
		"1 tree call + 2 per-path Contents calls + 2 blob reads",
	);
	console.log("✓ test 3: truncated tree WITH paths falls back to Contents API");
}

// ── 4. tree truncated WITHOUT paths → throws RepoTreeTruncatedError ───

{
	mockFetch(() => jsonResponse({ truncated: true, tree: [] }));

	await assert.rejects(
		() => loadTree({ owner: OWNER, repo: REPO, ref: REF, token: TOKEN }),
		(err: unknown) => {
			assert.ok(
				err instanceof RepoTreeTruncatedError,
				"throws RepoTreeTruncatedError",
			);
			assert.ok(
				(err as RepoTreeTruncatedError).message.includes("paths"),
				"message mentions paths",
			);
			return true;
		},
		"truncated tree without paths throws",
	);
	console.log(
		"✓ test 4: truncated tree WITHOUT paths throws RepoTreeTruncatedError",
	);
}

// ── 5a. 404 → RepoNotFoundError ───────────────────────────────────────────────

{
	mockFetch(() => jsonResponse({ message: "Not Found" }, 404));

	await assert.rejects(
		() => loadTree({ owner: OWNER, repo: REPO, ref: REF, token: TOKEN }),
		(err: unknown) => {
			assert.ok(
				err instanceof RepoNotFoundError,
				"throws RepoNotFoundError on 404",
			);
			return true;
		},
	);
	console.log("✓ test 5a: 404 → RepoNotFoundError");
}

// ── 5b. 401 → RepoAuthError ───────────────────────────────────────────────────

{
	mockFetch(() => jsonResponse({ message: "Bad credentials" }, 401));

	await assert.rejects(
		() => loadTree({ owner: OWNER, repo: REPO, ref: REF, token: TOKEN }),
		(err: unknown) => {
			assert.ok(err instanceof RepoAuthError, "throws RepoAuthError on 401");
			return true;
		},
	);
	console.log("✓ test 5b: 401 → RepoAuthError");
}

// ── 5c. 403 + x-ratelimit-reset → RepoRateLimitError ─────────────────────────

{
	const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
	mockFetch(() =>
		jsonResponse({ message: "API rate limit exceeded" }, 403, {
			"x-ratelimit-reset": String(resetEpoch),
			"x-ratelimit-remaining": "0",
		}),
	);

	await assert.rejects(
		() => loadTree({ owner: OWNER, repo: REPO, ref: REF, token: TOKEN }),
		(err: unknown) => {
			assert.ok(
				err instanceof RepoRateLimitError,
				"throws RepoRateLimitError on 403+reset header",
			);
			assert.equal(
				(err as RepoRateLimitError).resetAt,
				resetEpoch,
				"resetAt matches header",
			);
			return true;
		},
	);
	console.log(
		"✓ test 5c: 403 + x-ratelimit-reset → RepoRateLimitError with resetAt",
	);
}

// ── 5d. 403 without rate-limit header → RepoAuthError ────────────────────────

{
	mockFetch(() => jsonResponse({ message: "Forbidden" }, 403));

	await assert.rejects(
		() => loadTree({ owner: OWNER, repo: REPO, ref: REF, token: TOKEN }),
		(err: unknown) => {
			assert.ok(
				err instanceof RepoAuthError,
				"throws RepoAuthError on plain 403",
			);
			return true;
		},
	);
	console.log("✓ test 5d: 403 without rate-limit header → RepoAuthError");
}

// ── 6. loadRepoFilesResult: calls tree + blobs with concurrency, returns content ────

{
	const files = [
		{ path: "src/a.ts", sha: "sha-a", size: 10, content: "const a = 1;" },
		{ path: "src/b.ts", sha: "sha-b", size: 10, content: "const b = 2;" },
		{ path: "src/c.ts", sha: "sha-c", size: 10, content: "const c = 3;" },
	];

	let treeCalls = 0;
	let blobCalls = 0;

	mockFetch((url) => {
		if (url.includes("/git/trees/")) {
			treeCalls++;
			return jsonResponse({
				truncated: false,
				tree: files.map((f) => ({
					type: "blob",
					path: f.path,
					sha: f.sha,
					size: f.size,
				})),
			});
		}
		if (url.includes("/git/blobs/")) {
			blobCalls++;
			const file = files.find((f) => url.includes(f.sha));
			if (!file) return jsonResponse({ message: "Not Found" }, 404);
			return jsonResponse({ content: btoa(file.content), encoding: "base64" });
		}
		return jsonResponse({ message: "Not Found" }, 404);
	});

	const { files: result } = await loadRepoFilesResult({
		owner: OWNER,
		repo: REPO,
		ref: REF,
		token: TOKEN,
		paths: ["src/"],
	});

	assert.equal(treeCalls, 1, "exactly 1 tree call");
	assert.equal(blobCalls, 3, "1 blob call per matched file");
	assert.equal(result.length, 3, "3 files returned");
	for (const f of files) {
		const found = result.find((r) => r.path === f.path);
		assert.ok(found, `result includes ${f.path}`);
		assert.equal(found!.content, f.content, `content matches for ${f.path}`);
	}
	console.log("✓ test 6: loadRepoFilesResult concurrency + shape");
}

// ── 7. readRepoBlob: utf-8 encoding passthrough ───────────────────────────────

{
	mockFetch(() =>
		jsonResponse({ content: "plain text content", encoding: "utf-8" }),
	);

	const content = await readRepoBlob({
		owner: OWNER,
		repo: REPO,
		sha: "sha-utf8",
		token: TOKEN,
	});
	assert.equal(content, "plain text content", "utf-8 encoding returned as-is");
	console.log("✓ test 7: readRepoBlob utf-8 encoding passthrough");
}

// ── 8. tree read: paths filter with no-match returns empty ─────────────────

{
	mockFetch(() =>
		jsonResponse({
			truncated: false,
			tree: [{ type: "blob", path: "src/index.ts", sha: "s1", size: 1 }],
		}),
	);

	const none = await loadTree({
		owner: OWNER,
		repo: REPO,
		ref: REF,
		token: TOKEN,
		paths: ["lib/"],
	});
	assert.equal(none.length, 0, "non-matching prefix returns empty array");
	console.log("✓ test 8: path filter with no-match returns empty");
}

// ── 9. tree truncated fallback skips missing paths (404 from contents)

{
	mockFetch((url) => {
		if (url.includes("/git/trees/")) {
			return jsonResponse({ truncated: true, tree: [] });
		}
		// Simulate that only one of two paths exists
		if (url.includes("exists.ts")) {
			return jsonResponse({
				type: "file",
				path: "src/exists.ts",
				sha: "sha-exists",
				size: 10,
			});
		}
		return jsonResponse({ message: "Not Found" }, 404);
	});

	const blobs = await loadTree({
		owner: OWNER,
		repo: REPO,
		ref: REF,
		token: TOKEN,
		paths: ["src/exists.ts", "src/missing.ts"],
	});
	assert.equal(
		blobs.length,
		1,
		"missing path in contents fallback is skipped (not thrown)",
	);
	assert.equal(blobs[0]!.path, "src/exists.ts");
	console.log("✓ test 9: truncated fallback skips 404 paths gracefully");
}

// ── URL safety: traversal ref throws RepoUnsafeRefError, no fetch issued ──────

{
	let fetchCalled = false;
	globalThis.fetch = async () => {
		fetchCalled = true;
		return jsonResponse({}, 200);
	};

	const traversalRef = "../../../../victim/secret/git/trees/main";
	await assert.rejects(
		() =>
			loadTree({
				owner: OWNER,
				repo: REPO,
				ref: traversalRef,
				token: TOKEN,
			}),
		(err: unknown) => {
			assert.ok(
				err instanceof RepoUnsafeRefError,
				`expected RepoUnsafeRefError, got ${err}`,
			);
			return true;
		},
		"traversal ref throws RepoUnsafeRefError",
	);
	assert.equal(fetchCalled, false, "no outbound fetch made for traversal ref");
	console.log("✓ URL safety: traversal ref → RepoUnsafeRefError, no fetch");
}

// ── URL safety: encodeSegment rejects empty/'.'/'..'/slash in owner/repo/sha ──

{
	for (const badOwner of ["", ".", "..", "a/b"]) {
		await assert.rejects(
			() => loadTree({ owner: badOwner, repo: REPO, ref: REF, token: TOKEN }),
			(err: unknown) => {
				assert.ok(
					err instanceof RepoUnsafeRefError,
					`expected RepoUnsafeRefError for owner="${badOwner}"`,
				);
				return true;
			},
		);
	}
	console.log(
		"✓ URL safety: empty/'.'/'..'/slash in owner → RepoUnsafeRefError",
	);
}

// ── URL safety: branch with feature/ prefix is encoded correctly in URL ───────

{
	let capturedUrl = "";
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";
		capturedUrl = url;
		if (method === "GET" && url.includes("/git/ref/heads/")) {
			return jsonResponse({ object: { sha: "a".repeat(40) } });
		}
		if (method === "GET" && url.includes("/git/commits/")) {
			return jsonResponse({ tree: { sha: "b".repeat(40) } });
		}
		if (method === "POST" && url.includes("/git/blobs")) {
			return jsonResponse({ sha: "c".repeat(40) });
		}
		if (method === "POST" && url.includes("/git/trees")) {
			return jsonResponse({ sha: "d".repeat(40) });
		}
		if (method === "POST" && url.includes("/git/commits")) {
			return jsonResponse({ sha: "e".repeat(40) });
		}
		if (method === "POST" && url.includes("/git/refs")) {
			return jsonResponse({ ref: "refs/heads/feat/foo", sha: "e".repeat(40) });
		}
		return jsonResponse({ message: "Not Found" }, 404);
	};

	const result = await commitRepoChanges({
		owner: OWNER,
		repo: REPO,
		baseRef: "feature/base",
		branch: "feat/foo",
		message: "test",
		changes: [{ path: "x.ts", content: "1" }],
		token: TOKEN,
	});
	// branch segments encoded in URL: feat%2Ffoo → but actually feature/foo is
	// correctly a two-segment path; encodePathish encodes each segment separately
	// so feat/foo → feat/foo (each segment is valid). Confirm no raw '..' in URL.
	assert.ok(!capturedUrl.includes(".."), "no raw '..' in constructed URLs");
	assert.equal(result.commitSha, "e".repeat(40));
	console.log(
		"✓ URL safety: feature/ branch encoded correctly, no raw '..' in URLs",
	);
}

// ── URL safety: Contents API fallback encodes path safely ─────────────────────

{
	let contentsUrl = "";
	mockFetch((url) => {
		if (url.includes("/git/trees/")) {
			return jsonResponse({ truncated: true, tree: [] });
		}
		if (url.includes("/contents/")) {
			contentsUrl = url;
			return jsonResponse({
				type: "file",
				path: "src/utils.ts",
				sha: "sha-u",
				size: 10,
			});
		}
		return jsonResponse({ message: "Not Found" }, 404);
	});

	await loadTree({
		owner: OWNER,
		repo: REPO,
		ref: REF,
		token: TOKEN,
		paths: ["src/utils.ts"],
	});

	// Verify the Contents URL has no raw '..' or '?' or '#' in the path segment
	assert.ok(
		contentsUrl.includes("/contents/src"),
		"Contents URL has /contents/src path",
	);
	assert.ok(!contentsUrl.includes(".."), "Contents URL has no '..'");
	console.log("✓ URL safety: Contents API fallback URL has no traversal chars");
}

// ── Truncated tree + directory path → skippedDirectories, no throw ──────

{
	// When the Contents API returns a JSON array (directory listing), the path
	// must be silently skipped and reported in skippedDirectories — not thrown.
	mockFetch((url) => {
		if (url.includes("/git/trees/")) {
			return jsonResponse({ truncated: true, tree: [] });
		}
		// "src" resolves to a directory — GitHub returns a JSON array
		if (url.includes("/contents/src")) {
			return jsonResponse([
				{ type: "file", path: "src/index.ts", sha: "dir-sha-1", size: 10 },
				{ type: "file", path: "src/utils.ts", sha: "dir-sha-2", size: 20 },
			]);
		}
		return jsonResponse({ message: "Not Found" }, 404);
	});

	// the tree read strips skippedDirectories (returns only blobs)
	const blobs = await loadTree({
		owner: OWNER,
		repo: REPO,
		ref: REF,
		token: TOKEN,
		paths: ["src"],
	});
	assert.equal(blobs.length, 0, "directory path skipped — no blobs returned");

	// resolvePathsViaContents returns skippedDirectories directly
	const { resolvePathsViaContents } = await import("./repo-api");
	mockFetch((url) => {
		if (url.includes("/contents/src")) {
			return jsonResponse([
				{ type: "file", path: "src/index.ts", sha: "dir-sha-1", size: 10 },
			]);
		}
		return jsonResponse({ message: "Not Found" }, 404);
	});
	const resolved = await resolvePathsViaContents({
		owner: OWNER,
		repo: REPO,
		ref: REF,
		token: TOKEN,
		paths: ["src/"],
	});
	assert.equal(resolved.blobs.length, 0, "blobs empty for directory response");
	assert.deepEqual(
		resolved.skippedDirectories,
		["src"],
		"skippedDirectories contains 'src' (trailing slash stripped)",
	);
	console.log(
		"✓ P1c: truncated tree + directory path → skippedDirectories, no throw",
	);
}

// ── UTF-8 base64: unicode and multi-chunk payloads ───────────────────────────

{
	const unicode = "€🙂";
	const large = unicode.repeat(10_000); // 70,000 UTF-8 bytes (> 0x8000)
	const encoded = utf8ToBase64(large);
	const decoded = new TextDecoder().decode(
		Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
	);
	assert.equal(decoded, large, "chunked UTF-8 base64 preserves euro and emoji");
	assert.ok(
		new TextEncoder().encode(large).length > 0x8000,
		"regression payload exceeds one 0x8000-byte chunk",
	);
	assert.equal(
		utf8ToBase64(unicode),
		"4oKs8J+Zgg==",
		"UTF-8 base64 encodes euro and emoji rather than UTF-16 code units",
	);
	console.log("✓ UTF-8 base64: euro, emoji, and >0x8000-byte payload");
}

console.log("\n✅ All repo-api Phase 1 tests passed");

// ── Phase 2: commitRepoChanges + openPullRequest ───────────────────────────────

const BASE_COMMIT_SHA = "a".repeat(40);
const BASE_TREE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const NEW_TREE_SHA = "d".repeat(40);
const NEW_COMMIT_SHA = "e".repeat(40);
const BRANCH = "feat/test-branch";

// ── 10. Happy path full flow ───────────────────────────────────────────────────

{
	const calls: Array<{ url: string; method: string; body: any }> = [];

	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		calls.push({ url, method, body });

		// 1. Resolve ref
		if (method === "GET" && url.includes("/git/ref/heads/main")) {
			return jsonResponse({ object: { sha: BASE_COMMIT_SHA } });
		}
		// 2. Get base commit
		if (method === "GET" && url.includes(`/git/commits/${BASE_COMMIT_SHA}`)) {
			return jsonResponse({ tree: { sha: BASE_TREE_SHA } });
		}
		// 3. Create blob
		if (method === "POST" && url.includes("/git/blobs")) {
			return jsonResponse({ sha: BLOB_SHA });
		}
		// 4. Create tree
		if (method === "POST" && url.includes("/git/trees")) {
			return jsonResponse({ sha: NEW_TREE_SHA });
		}
		// 5. Create commit
		if (method === "POST" && url.includes("/git/commits")) {
			return jsonResponse({ sha: NEW_COMMIT_SHA });
		}
		// 6. Create ref (new branch)
		if (method === "POST" && url.includes("/git/refs")) {
			return jsonResponse({ ref: `refs/heads/${BRANCH}`, sha: NEW_COMMIT_SHA });
		}
		return jsonResponse({ message: "Not Found" }, 404);
	};

	const result = await commitRepoChanges({
		owner: OWNER,
		repo: REPO,
		baseRef: "main",
		branch: BRANCH,
		message: "chore: test commit",
		changes: [{ path: "src/hello.ts", content: "export const hi = 1;" }],
		token: TOKEN,
	});

	assert.equal(result.commitSha, NEW_COMMIT_SHA, "returns correct commitSha");
	assert.equal(
		result.branchRef,
		`refs/heads/${BRANCH}`,
		"returns correct branchRef",
	);

	// Verify call sequence
	const getRefCall = calls.find(
		(c) => c.method === "GET" && c.url.includes("/git/ref/heads/main"),
	);
	assert.ok(getRefCall, "resolves baseRef via GET /git/ref/heads/{ref}");

	const getCommitCall = calls.find(
		(c) =>
			c.method === "GET" && c.url.includes(`/git/commits/${BASE_COMMIT_SHA}`),
	);
	assert.ok(getCommitCall, "fetches base commit to get tree SHA");

	const blobCall = calls.find(
		(c) => c.method === "POST" && c.url.includes("/git/blobs"),
	);
	assert.ok(blobCall, "creates blob via POST /git/blobs");
	assert.equal(blobCall!.body.encoding, "base64", "blob uses base64 encoding");
	assert.equal(
		blobCall!.body.content,
		btoa("export const hi = 1;"),
		"blob content is base64-encoded",
	);

	const treeCall = calls.find(
		(c) => c.method === "POST" && c.url.includes("/git/trees"),
	);
	assert.ok(treeCall, "creates tree via POST /git/trees");
	assert.equal(
		treeCall!.body.base_tree,
		BASE_TREE_SHA,
		"tree uses base_tree from base commit",
	);
	assert.equal(treeCall!.body.tree.length, 1, "tree has 1 entry");
	assert.equal(treeCall!.body.tree[0].sha, BLOB_SHA, "tree entry has blob sha");
	assert.equal(
		treeCall!.body.tree[0].path,
		"src/hello.ts",
		"tree entry has correct path",
	);

	const commitCall = calls.find(
		(c) => c.method === "POST" && c.url.includes("/git/commits"),
	);
	assert.ok(commitCall, "creates commit via POST /git/commits");
	assert.deepEqual(
		commitCall!.body.parents,
		[BASE_COMMIT_SHA],
		"commit parent is base commit",
	);
	assert.equal(commitCall!.body.tree, NEW_TREE_SHA, "commit uses new tree SHA");

	const refCall = calls.find(
		(c) => c.method === "POST" && c.url.includes("/git/refs"),
	);
	assert.ok(refCall, "creates ref via POST /git/refs");
	assert.equal(
		refCall!.body.ref,
		`refs/heads/${BRANCH}`,
		"ref name is correct",
	);
	assert.equal(refCall!.body.sha, NEW_COMMIT_SHA, "ref points to new commit");

	console.log("✓ test 10: commitRepoChanges happy path full flow");
}

// ── 11. Deletion: null content → sha: null, no blob creation ──────────────────

{
	const blobCalls: string[] = [];

	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body as string) : undefined;

		if (method === "GET" && url.includes("/git/ref/heads/main")) {
			return jsonResponse({ object: { sha: BASE_COMMIT_SHA } });
		}
		if (method === "GET" && url.includes(`/git/commits/${BASE_COMMIT_SHA}`)) {
			return jsonResponse({ tree: { sha: BASE_TREE_SHA } });
		}
		if (method === "POST" && url.includes("/git/blobs")) {
			blobCalls.push(url);
			return jsonResponse({ sha: BLOB_SHA });
		}
		if (method === "POST" && url.includes("/git/trees")) {
			// Assert tree entry for deleted path has sha: null
			const deletedEntry = body.tree.find(
				(e: { path: string }) => e.path === "src/delete-me.ts",
			);
			assert.ok(deletedEntry, "tree contains entry for deleted path");
			assert.equal(deletedEntry.sha, null, "deleted path entry has sha: null");
			return jsonResponse({ sha: NEW_TREE_SHA });
		}
		if (method === "POST" && url.includes("/git/commits")) {
			return jsonResponse({ sha: NEW_COMMIT_SHA });
		}
		if (method === "POST" && url.includes("/git/refs")) {
			return jsonResponse({ ref: `refs/heads/${BRANCH}`, sha: NEW_COMMIT_SHA });
		}
		return jsonResponse({ message: "Not Found" }, 404);
	};

	await commitRepoChanges({
		owner: OWNER,
		repo: REPO,
		baseRef: "main",
		branch: BRANCH,
		message: "chore: delete a file",
		changes: [{ path: "src/delete-me.ts", content: null }],
		token: TOKEN,
	});

	assert.equal(
		blobCalls.length,
		0,
		"no blob created for null-content (deletion)",
	);
	console.log(
		"✓ test 11: null content deletion → sha: null in tree, no blob creation",
	);
}

// ── 12. Update existing branch: POST /git/refs returns 422 → falls back to PATCH

{
	const patchCalls: Array<{ url: string; body: any }> = [];

	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body as string) : undefined;

		if (method === "GET" && url.includes("/git/ref/heads/main")) {
			return jsonResponse({ object: { sha: BASE_COMMIT_SHA } });
		}
		if (method === "GET" && url.includes(`/git/commits/${BASE_COMMIT_SHA}`)) {
			return jsonResponse({ tree: { sha: BASE_TREE_SHA } });
		}
		if (method === "POST" && url.includes("/git/blobs")) {
			return jsonResponse({ sha: BLOB_SHA });
		}
		if (method === "POST" && url.includes("/git/trees")) {
			return jsonResponse({ sha: NEW_TREE_SHA });
		}
		if (method === "POST" && url.includes("/git/commits")) {
			return jsonResponse({ sha: NEW_COMMIT_SHA });
		}
		// POST /git/refs → 422 (branch already exists)
		if (method === "POST" && url.includes("/git/refs")) {
			return jsonResponse({ message: "Reference already exists" }, 422, {
				"Content-Type": "application/json",
			});
		}
		// PATCH /git/refs/heads/{branch} → success
		if (method === "PATCH" && url.includes(`/git/refs/heads/${BRANCH}`)) {
			patchCalls.push({ url, body });
			return jsonResponse({ ref: `refs/heads/${BRANCH}`, sha: NEW_COMMIT_SHA });
		}
		return jsonResponse({ message: "Not Found" }, 404);
	};

	const result = await commitRepoChanges({
		owner: OWNER,
		repo: REPO,
		baseRef: "main",
		branch: BRANCH,
		message: "chore: update existing branch",
		changes: [{ path: "src/update.ts", content: "export const v = 2;" }],
		token: TOKEN,
	});

	assert.equal(
		result.commitSha,
		NEW_COMMIT_SHA,
		"commit SHA returned correctly after PATCH fallback",
	);
	assert.equal(patchCalls.length, 1, "PATCH was called once");
	assert.equal(
		patchCalls[0]!.body.sha,
		NEW_COMMIT_SHA,
		"PATCH body has correct sha",
	);
	assert.equal(patchCalls[0]!.body.force, false, "PATCH uses force: false");
	console.log(
		"✓ test 12: POST /git/refs 422 → falls back to PATCH /git/refs/heads/{branch}",
	);
}

// ── 13. Secondary rate-limit: 403 + Retry-After → RepoSecondaryRateLimitError ─

{
	mockFetch((url) => {
		if (url.includes("/git/ref/heads/main")) {
			return jsonResponse({}, 403, { "Retry-After": "60" });
		}
		return jsonResponse({ message: "Not Found" }, 404);
	});

	await assert.rejects(
		() =>
			commitRepoChanges({
				owner: OWNER,
				repo: REPO,
				baseRef: "main",
				branch: BRANCH,
				message: "should not reach",
				changes: [],
				token: TOKEN,
			}),
		(err: unknown) => {
			assert.ok(
				err instanceof RepoSecondaryRateLimitError,
				"throws RepoSecondaryRateLimitError",
			);
			assert.equal(
				(err as RepoSecondaryRateLimitError).retryAfter,
				60,
				"retryAfter is 60",
			);
			// Token must not appear in the error message
			assert.ok(
				!(err as Error).message.includes(TOKEN),
				"token not leaked in error message",
			);
			return true;
		},
	);
	console.log(
		"✓ test 13: 403 + Retry-After → RepoSecondaryRateLimitError with retryAfter",
	);
}

// ── 14. openPullRequest happy path ────────────────────────────────────────────

{
	const PR_NUMBER = 42;
	const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`;
	let prCallBody: unknown = null;

	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";

		if (method === "POST" && url.includes("/pulls")) {
			prCallBody = JSON.parse(init!.body as string);
			return jsonResponse({ html_url: PR_URL, number: PR_NUMBER });
		}
		return jsonResponse({ message: "Not Found" }, 404);
	};

	const result = await openPullRequest({
		owner: OWNER,
		repo: REPO,
		head: BRANCH,
		base: "main",
		title: "feat: test PR",
		body: "This is a test pull request.",
		token: TOKEN,
	});

	assert.equal(result.url, PR_URL, "returns html_url as url");
	assert.equal(result.number, PR_NUMBER, "returns PR number");
	assert.ok(prCallBody !== null, "POST /pulls was called");
	const body = prCallBody as Record<string, string>;
	assert.equal(body.head, BRANCH, "body.head is the source branch");
	assert.equal(body.base, "main", "body.base is the target branch");
	assert.equal(body.title, "feat: test PR", "body.title is correct");
	assert.equal(
		body.body,
		"This is a test pull request.",
		"body.body is correct",
	);
	console.log(
		"✓ test 14: openPullRequest happy path — request body + return shape",
	);
}

// ── 15. commitRepoChanges: SHA baseRef skips ref resolution ───────────────────

{
	const directSha = "f".repeat(40);
	let resolveRefCalled = false;

	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";

		if (method === "GET" && url.includes("/git/ref/heads/")) {
			resolveRefCalled = true;
			return jsonResponse({ object: { sha: directSha } });
		}
		if (method === "GET" && url.includes(`/git/commits/${directSha}`)) {
			return jsonResponse({ tree: { sha: BASE_TREE_SHA } });
		}
		if (method === "POST" && url.includes("/git/blobs")) {
			return jsonResponse({ sha: BLOB_SHA });
		}
		if (method === "POST" && url.includes("/git/trees")) {
			return jsonResponse({ sha: NEW_TREE_SHA });
		}
		if (method === "POST" && url.includes("/git/commits")) {
			return jsonResponse({ sha: NEW_COMMIT_SHA });
		}
		if (method === "POST" && url.includes("/git/refs")) {
			return jsonResponse({ ref: `refs/heads/${BRANCH}`, sha: NEW_COMMIT_SHA });
		}
		return jsonResponse({ message: "Not Found" }, 404);
	};

	await commitRepoChanges({
		owner: OWNER,
		repo: REPO,
		baseRef: directSha, // 40-char hex SHA
		branch: BRANCH,
		message: "chore: from direct sha",
		changes: [{ path: "x.ts", content: "1" }],
		token: TOKEN,
	});

	assert.equal(
		resolveRefCalled,
		false,
		"does not call GET /git/ref/heads when baseRef is a SHA",
	);
	console.log("✓ test 15: 40-char hex baseRef skips ref resolution step");
}

// ── 16. commitRepoChanges: path traversal rejected before any fetch ────────────

{
	for (const badPath of [
		"../../SOUL.md",
		"/etc/passwd",
		"repo/../x",
		"",
		"a//b",
		"./evil",
	]) {
		let fetchCalled = false;
		globalThis.fetch = async () => {
			fetchCalled = true;
			return jsonResponse({}, 200);
		};

		await assert.rejects(
			() =>
				commitRepoChanges({
					owner: OWNER,
					repo: REPO,
					baseRef: "main",
					branch: "feat/test",
					message: "should not reach",
					changes: [{ path: badPath, content: "x" }],
					token: TOKEN,
				}),
			(err: unknown) => {
				assert.ok(
					err instanceof RepoUnsafeRefError,
					`expected RepoUnsafeRefError for path="${badPath}", got ${err}`,
				);
				return true;
			},
			`commitRepoChanges rejects traversal path "${badPath}"`,
		);
		assert.equal(
			fetchCalled,
			false,
			`no fetch issued for traversal path "${badPath}"`,
		);
	}
	console.log(
		"✓ test 16: commitRepoChanges rejects traversal paths → RepoUnsafeRefError, no fetch",
	);
}

console.log("\n✅ All repo-api tests passed");
