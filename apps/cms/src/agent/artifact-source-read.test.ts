import { describe, expect, it, vi } from "vite-plus/test";
import type { ArtifactsBinding } from "../types";
import { readThemeArtifactFile } from "./artifact-source-read";
const COMMIT = "a".repeat(40);
function fixture(
	options: {
		mode?: string;
		bytes?: Uint8Array<ArrayBuffer>;
		missing?: string;
		mismatch?: boolean;
		fail?: boolean;
	} = {},
) {
	const dispose = vi.fn();
	const repo = {
		[Symbol.dispose]: dispose,
		readCommit: vi.fn(async () => {
			if (options.fail) throw new Error("secret-token");
			return options.missing === "commit"
				? null
				: {
						hash: options.mismatch ? "f".repeat(40) : COMMIT,
						treeHash: "b".repeat(40),
					};
		}),
		readTree: vi.fn(async (hash: string) =>
			options.missing === "tree"
				? null
				: hash === "b".repeat(40)
					? [{ name: "src", type: "tree", mode: "40000", hash: "c".repeat(40) }]
					: hash === "c".repeat(40)
						? [
								{
									name: "components",
									type: "tree",
									mode: "40000",
									hash: "d".repeat(40),
								},
							]
						: [
								{
									name: "Hero.astro",
									type: options.mode === "120000" ? "symlink" : "blob",
									mode: options.mode ?? "100644",
									hash: "e".repeat(40),
								},
							],
		),
		readBlob: vi.fn(async () =>
			options.missing === "blob"
				? null
				: new Blob([
						options.bytes ?? new TextEncoder().encode("<h1>Active</h1>"),
					]),
		),
		createToken: vi.fn(() => {
			throw new Error("must not mint tokens");
		}),
	};
	const get = vi.fn(async () => repo);
	const read = (overrides = {}) =>
		readThemeArtifactFile({
			orgSlug: "acme",
			templateSlug: "tedix",
			sourceCommit: COMMIT,
			path: "src/components/Hero.astro",
			artifacts: { get } as unknown as ArtifactsBinding,
			...overrides,
		});
	return { read, repo, get, dispose };
}
describe("native Artifacts source file read", () => {
	it("reads exact tenant commit and regular blob, disposing the RPC handle without tokens", async () => {
		const f = fixture();
		expect(await f.read()).toEqual({
			sourceCommit: COMMIT,
			path: "src/components/Hero.astro",
			content: "<h1>Active</h1>",
			sizeBytes: 15,
		});
		expect(f.get).toHaveBeenCalledWith("cms-theme-acme");
		expect(f.repo.readCommit).toHaveBeenCalledWith(COMMIT);
		expect(f.repo.readBlob).toHaveBeenCalledWith("e".repeat(40));
		expect(f.dispose).toHaveBeenCalledOnce();
		expect(f.repo.createToken).not.toHaveBeenCalled();
	});
	it("accepts executable regular files and retains UTF-8 BOM bytes", async () => {
		expect(
			(
				await fixture({
					mode: "100755",
					bytes: new Uint8Array([239, 187, 191, 65]),
				}).read()
			).content,
		).toBe("\uFEFFA");
	});
	it.each([
		"../src/components/Hero.astro",
		"src/components/../Hero.astro",
		"src//components/Hero.astro",
		"src/middleware.ts",
		"src/components\\Hero.astro",
	])(
		"rejects invalid or locked path %s before provider access",
		async (path) => {
			const f = fixture();
			await expect(f.read({ path })).rejects.toThrow("not editable");
			expect(f.get).not.toHaveBeenCalled();
		},
	);
	it("rejects malformed commits before provider access", async () => {
		const f = fixture();
		await expect(f.read({ sourceCommit: "main" })).rejects.toThrow("Invalid");
		expect(f.get).not.toHaveBeenCalled();
	});
	it.each([
		{ mode: "120000" },
		{ missing: "commit" },
		{ missing: "tree" },
		{ missing: "blob" },
		{ mismatch: true },
		{ bytes: new Uint8Array([255]) },
		{ bytes: new Uint8Array(256001) },
		{ fail: true },
	])(
		"fails closed for unavailable, unsafe or invalid objects %j",
		async (options) => {
			const f = fixture(options);
			await expect(f.read()).rejects.toThrow(
				"Unable to read the requested Artifacts source file",
			);
			expect(f.dispose).toHaveBeenCalledOnce();
			expect(f.repo.createToken).not.toHaveBeenCalled();
		},
	);
});
