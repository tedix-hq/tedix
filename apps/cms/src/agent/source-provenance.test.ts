import { describe, expect, it } from "vite-plus/test";
import {
	digestEditableThemeSource,
	migrateThemePresentationSource,
	materializeEditableThemeSource,
	requirePinnedEditableThemeSource,
} from "./source-provenance";

function sandboxFixture(files: Record<string, string>, root = "/workspace") {
	return {
		async listFiles() {
			return Object.entries(files).map(([relativePath, content]) => ({
				type: "file" as const,
				relativePath,
				size: content.length,
			}));
		},
		async readFile(path: string) {
			const relativePath = path.replace(`${root}/src/`, "");
			const content = files[relativePath];
			if (content === undefined) throw new Error(`Missing file: ${path}`);
			return { content, size: new TextEncoder().encode(content).byteLength };
		},
	};
}

describe("editable CMS source provenance", () => {
	it("is stable across listing order and excludes locked source", async () => {
		const first = await digestEditableThemeSource(
			sandboxFixture({
				"pages/index.astro": "<h1>Hello</h1>",
				"middleware.ts": "locked-v1",
				"styles/theme.css": ":root { color: blue; }",
			}),
			"tedix",
		);
		const second = await digestEditableThemeSource(
			sandboxFixture({
				"styles/theme.css": ":root { color: blue; }",
				"middleware.ts": "locked-v2",
				"pages/index.astro": "<h1>Hello</h1>",
			}),
			"tedix",
		);

		expect(first).toEqual(second);
		expect(first.fileCount).toBe(2);
		expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("changes when editable content changes", async () => {
		const before = await digestEditableThemeSource(
			sandboxFixture({ "pages/index.astro": "before" }),
			"tedix",
		);
		const after = await digestEditableThemeSource(
			sandboxFixture({ "pages/index.astro": "after" }),
			"tedix",
		);

		expect(after.digest).not.toBe(before.digest);
	});

	it("verifies a private build copy against the preflight source", async () => {
		const files = {
			"pages/index.astro": "<Landing />",
			"components/LeadCaptureForm.astro": "<form />",
		};
		const pinned = await digestEditableThemeSource(
			sandboxFixture(files),
			"marketing",
		);
		const copyRoot =
			"/tmp/tedix-cms-deploy-11111111-1111-4111-8111-111111111111";
		await expect(
			requirePinnedEditableThemeSource(
				sandboxFixture(files, copyRoot),
				"marketing",
				pinned,
				undefined,
				copyRoot,
			),
		).resolves.toEqual(pinned);
		await expect(
			requirePinnedEditableThemeSource(
				sandboxFixture(
					{ "pages/index.astro": files["pages/index.astro"] },
					copyRoot,
				),
				"marketing",
				pinned,
				undefined,
				copyRoot,
			),
		).rejects.toThrow(/changed since deploy preflight/);
	});

	it("refuses to create an identity for an empty editable tree", async () => {
		await expect(
			digestEditableThemeSource(
				sandboxFixture({ "middleware.ts": "locked" }),
				"tedix",
			),
		).rejects.toThrow("no editable source files");
	});

	it("fails a build retry whose container was reset to the stock starter", async () => {
		const theme: Record<string, string> = {
			"pages/index.astro": "<Landing />",
			"layouts/Landing.astro": "<slot />",
			"styles/theme.css": ":root { color: blue; }",
		};
		const firstAttempt = sandboxFixture(theme);
		const pinned = await digestEditableThemeSource(firstAttempt, "tedix");

		// Same container: the retry sees the same theme and may build.
		await expect(
			requirePinnedEditableThemeSource(firstAttempt, "tedix", pinned),
		).resolves.toEqual(pinned);

		// Replaced container: /workspace is the stock blog starter again.
		const resetContainer = sandboxFixture({
			"pages/index.astro": "<BlogIndex />",
			"styles/theme.css": ":root {}",
		});
		class Permanent extends Error {}
		const retry = requirePinnedEditableThemeSource(
			resetContainer,
			"tedix",
			pinned,
			(message) => new Permanent(message),
		);
		await expect(retry).rejects.toBeInstanceOf(Permanent);
		await expect(retry).rejects.toThrow(
			/changed since deploy preflight \(3 files .* -> 2 files .*Refusing to publish/,
		);
	});
});

/**
 * In-memory builder container. `exec` emulates the two materialization
 * scripts' contracts: the fetch checks the commit out of `repo`, the apply
 * step deletes then copies the listed paths.
 */
function containerFixture(
	workspaceSrc: Record<string, string>,
	repo: { commit: string; src: Record<string, string> },
	workspace = "/workspace",
) {
	const fs = new Map<string, string>();
	for (const [path, content] of Object.entries(workspaceSrc)) {
		fs.set(`${workspace}/src/${path}`, content);
	}
	let checkout = "";
	const output = (stdout: string) => ({
		output: async () => ({ exitCode: 0, stdout, stderr: "" }),
	});
	const lines = (path: string) =>
		(fs.get(path) ?? "").split("\n").filter(Boolean);
	return {
		fs,
		async listFiles(root: string) {
			const prefix = `${root}/`;
			return [...fs.keys()]
				.filter((path) => path.startsWith(prefix))
				.map((path) => ({
					type: "file",
					relativePath: path.slice(prefix.length),
				}));
		},
		async readFile(path: string) {
			const content = fs.get(path);
			if (content === undefined) throw new Error(`Missing file: ${path}`);
			return { content, size: new TextEncoder().encode(content).byteLength };
		},
		async writeFile(path: string, content: string) {
			fs.set(path, content);
			if (path.endsWith(".token")) checkout = path.slice(0, -".token".length);
		},
		async exec(argv: [string, ...string[]]) {
			const script = argv[2] ?? "";
			if (script.includes("git fetch")) {
				expect(script).toContain(repo.commit);
				for (const [path, content] of Object.entries(repo.src)) {
					fs.set(`${checkout}/src/${path}`, content);
				}
				return output(`${repo.commit}\n`);
			}
			for (const path of lines(`${checkout}.delete`)) {
				fs.delete(`${workspace}/${path}`);
			}
			for (const path of lines(`${checkout}.copy`)) {
				fs.set(`${workspace}/${path}`, fs.get(`${checkout}/${path}`) ?? "");
			}
			return output("");
		},
	};
}

describe("editable CMS source from an Artifacts commit", () => {
	const commit = "257f82713b617509376d870421284dc9be06aefa";
	const theme = {
		"theme-source.json": JSON.stringify({ version: 2 }),
		"pages/index.astro": "<Landing />",
		"pages/pricing.astro": "<Pricing />",
		"layouts/Landing.astro": "<slot />",
		"styles/theme.css": ":root { color: blue; }",
		"middleware.ts": "locked-from-repo",
	};

	it("restores the tenant theme when the container reset before the deploy started", async () => {
		// The container already holds the stock blog starter at preflight.
		const reset = containerFixture(
			{
				"pages/index.astro": "<BlogIndex />",
				"components/PostCard.astro": "<article />",
				"styles/theme.css": ":root {}",
				"middleware.ts": "locked-from-platform",
			},
			{ commit, src: theme },
		);

		await materializeEditableThemeSource(reset, {
			remote: "https://example.invalid/git/ns/cms-theme-t.git",
			token: "read-token",
			commit,
			templateSlug: "tedix",
		});

		const expected = await digestEditableThemeSource(
			sandboxFixture(theme),
			"tedix",
		);
		await expect(digestEditableThemeSource(reset, "tedix")).resolves.toEqual(
			expected,
		);
		// Stock-only editable files are gone; locked files stay platform-owned.
		expect(reset.fs.has("/workspace/src/components/PostCard.astro")).toBe(
			false,
		);
		expect(reset.fs.get("/workspace/src/middleware.ts")).toBe(
			"locked-from-platform",
		);
	});

	it.each([undefined, "not json", '{"version":1}'])(
		"refuses unmigrated source %s without deleting destination presentation",
		async (manifest) => {
			const source: Record<string, string> = {
				"pages/index.astro": "<OldSite />",
			};
			if (manifest !== undefined) source["theme-source.json"] = manifest;
			const sandbox = containerFixture(
				{ "layouts/Base.astro": "<ExactExistingLayout />" },
				{ commit, src: source },
			);
			await expect(
				materializeEditableThemeSource(sandbox, {
					remote: "https://example.invalid/repo.git",
					token: "read-token",
					commit,
					templateSlug: "tedix",
				}),
			).rejects.toThrow("requires the site-owned presentation migration");
			expect(sandbox.fs.get("/workspace/src/layouts/Base.astro")).toBe(
				"<ExactExistingLayout />",
			);
		},
	);

	it("preserves an intentional presentation deletion after migration", async () => {
		const sandbox = containerFixture(
			{ "layouts/Base.astro": "<Scaffold />", "styles/globals.css": "old css" },
			{ commit, src: theme },
		);
		await materializeEditableThemeSource(sandbox, {
			remote: "https://example.invalid/repo.git",
			token: "read-token",
			commit,
			templateSlug: "tedix",
		});
		expect(sandbox.fs.has("/workspace/src/layouts/Base.astro")).toBe(false);
		expect(sandbox.fs.has("/workspace/src/styles/globals.css")).toBe(false);
	});

	it("refuses a commit that is not a full SHA", async () => {
		await expect(
			materializeEditableThemeSource(
				containerFixture({}, { commit, src: theme }),
				{
					remote: "https://example.invalid/git/ns/cms-theme-t.git",
					token: "read-token",
					commit: commit.slice(0, 12),
					templateSlug: "tedix",
				},
			),
		).rejects.toThrow("Invalid theme source commit");
	});

	it("restores an Artifacts commit into a private attempt without replacing shared source", async () => {
		const workspace =
			"/tmp/tedix-cms-deploy-11111111-1111-4111-8111-111111111111";
		const sandbox = containerFixture(
			{ "pages/index.astro": "<Starter />" },
			{ commit, src: theme },
			workspace,
		);
		sandbox.fs.set("/workspace/src/pages/index.astro", "<OtherBuild />");
		await materializeEditableThemeSource(sandbox, {
			remote: "https://example.invalid/git/ns/cms-theme-t.git",
			token: "read-token",
			commit,
			templateSlug: "tedix",
			workspace,
		});
		expect(sandbox.fs.get(`${workspace}/src/pages/index.astro`)).toBe(
			"<Landing />",
		);
		expect(sandbox.fs.get("/workspace/src/pages/index.astro")).toBe(
			"<OtherBuild />",
		);
	});
});

describe("explicit presentation ownership migration", () => {
	const platformSource = {
		"src/layouts/Base.astro": "<ExactPreviousPlatform />",
	};
	const previousLockedPaths = ["src/layouts/Base.astro", "src/middleware.ts"];
	it("adopts exact old platform bytes while preserving independent draft and active files", () => {
		for (const content of ["<Published />", "<UnpublishedChanges />"]) {
			const source = {
				"src/pages/index.astro": content,
				"src/layouts/Base.astro": "<StaleCopy />",
			};
			const result = migrateThemePresentationSource({
				templateSlug: "tedix",
				source,
				platformSource,
				previousLockedPaths,
			});
			expect(result.files["src/pages/index.astro"]).toBe(content);
			expect(result.files["src/layouts/Base.astro"]).toBe(
				"<ExactPreviousPlatform />",
			);
			expect(result.adoptedPaths).toEqual(["src/layouts/Base.astro"]);
			expect(source["src/layouts/Base.astro"]).toBe("<StaleCopy />");
		}
	});
	it("refuses missing exact bytes rather than using current starter defaults", () => {
		expect(() =>
			migrateThemePresentationSource({
				templateSlug: "tedix",
				source: {},
				platformSource: {},
				previousLockedPaths,
			}),
		).toThrow("Exact previous platform source missing");
	});
	it("refuses to rerun adoption over intentional deletions", () => {
		expect(() =>
			migrateThemePresentationSource({
				templateSlug: "tedix",
				source: { "src/theme-source.json": '{"version":2}' },
				platformSource,
				previousLockedPaths,
			}),
		).toThrow("do not fill missing files");
	});
});
