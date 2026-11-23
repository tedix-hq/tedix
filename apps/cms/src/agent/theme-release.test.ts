import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	identifyThemeRelease,
	requireSupportedBlocks,
	type ThemeRelease,
} from "./theme-release";
import {
	platformThemeManifest,
	themePackageVersions,
} from "./theme-dependencies";
import { snapshotForTemplate } from "./template-sync";
import { CMS_TEMPLATE_SLUGS } from "../template-policy";

const lock = `{ "packages": {
// ignored request range
"emdash": ["emdash@1.6.0"], "forms": ["@emdash-cms/plugin-forms@0.2.14"],
}, }`;

const declaration = {
	upstreamStarterRevision: "a".repeat(40),
	supportedBlocks: { hero: [1, 2] },
};
const release: ThemeRelease = {
	...declaration,
	version: 1,
	templateSlug: "marketing",
	lockedTemplateSnapshotHash: "b".repeat(64),
	dependencyLockHash: "c".repeat(64),
};

describe("theme release identity", () => {
	it.each(CMS_TEMPLATE_SLUGS)(
		"pins every EmDash dependency and bundled plugin for %s",
		(slug) => {
			const manifest = JSON.parse(platformThemeManifest(slug));
			const pins = themePackageVersions(
				snapshotForTemplate(slug).snapshot["bun.lock"]!,
			);
			for (const [name, versions] of Object.entries(pins)) {
				expect(manifest.overrides[name]).toBe(versions[0]);
				if (manifest.dependencies[name])
					expect(manifest.dependencies[name]).toBe(versions[0]);
			}
			expect(manifest.patchedDependencies["emdash@1.6.0"]).toBe(
				"patches/emdash@1.6.0.patch",
			);
		},
	);
	it("rejects missing resolved packages rather than recording guessed versions", () => {
		expect(() => themePackageVersions('{"packages":')).toThrow();
		expect(() => themePackageVersions('{"packages": {}}')).toThrow();
	});

	it("records locked snapshot, exact dependency lock, starter revision and renderer versions", async () => {
		const sandbox = {
			readFile: async (path: string) => ({
				content: path.endsWith("bun.lock") ? lock : JSON.stringify(declaration),
			}),
		};
		const first = await identifyThemeRelease(sandbox, "marketing", "/build");
		expect(first).toMatchObject({
			...declaration,
			dependencyLockHash: await sha256Hex(lock),
			packages: { emdash: ["1.6.0"], "@emdash-cms/plugin-forms": ["0.2.14"] },
		});
		expect(first.lockedTemplateSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
		expect(await identifyThemeRelease(sandbox, "marketing", "/build")).toEqual(
			first,
		);
		const other = await identifyThemeRelease(sandbox, "starter", "/build");
		expect(other.lockedTemplateSnapshotHash).not.toBe(
			first.lockedTemplateSnapshotHash,
		);
	});
	it.each(["marketing", "native-marketing", "tedix"])(
		"declares only mapped renderer types for %s",
		async (slug) => {
			const base = new URL(`../../templates/${slug}/`, import.meta.url);
			const declaration = JSON.parse(
				await readFile(new URL("src/theme-release.json", base), "utf8"),
			);
			const renderer = await readFile(
				new URL(
					`src/components/${slug === "tedix" ? "NativePage" : "MarketingBlocks"}.astro`,
					base,
				),
				"utf8",
			);
			const mapped = [
				...renderer.matchAll(/^\s+(marketing_[a-z_]+): [A-Za-z]+,/gm),
			].map((match) => match[1]);
			expect(Object.keys(declaration.supportedBlocks).toSorted()).toEqual(
				mapped.toSorted(),
			);
			if (slug !== "tedix") {
				const seed = JSON.parse(
					await readFile(new URL("seed/seed.json", base), "utf8"),
				) as {
					blockTypes: Array<{
						slug: string;
						versions: Array<{ version: number }>;
					}>;
				};
				expect(declaration.supportedBlocks).toEqual(
					Object.fromEntries(
						seed.blockTypes.map((block) => [
							block.slug,
							block.versions.map((v) => v.version),
						]),
					),
				);
			}
		},
	);

	it.each([
		"{}",
		"not json",
		JSON.stringify({ ...declaration, supportedBlocks: { hero: [0] } }),
	])("refuses an invalid declaration %s", async (content) => {
		await expect(
			identifyThemeRelease(
				{ readFile: async () => ({ content }) },
				"marketing",
				"/build",
			),
		).rejects.toMatchObject({ code: "THEME_RELEASE_INVALID" });
	});
	it.each(CMS_TEMPLATE_SLUGS)(
		"refuses %s without an explicit renderer declaration",
		async (slug) => {
			await expect(
				identifyThemeRelease(
					{
						readFile: async (path) => {
							if (path.endsWith("/bun.lock")) return { content: "lock" };
							throw new Error("missing");
						},
					},
					slug,
					"/build",
				),
			).rejects.toMatchObject({ code: "THEME_RELEASE_INVALID" });
		},
	);
	it.each(CMS_TEMPLATE_SLUGS)(
		"ships a valid declaration for %s",
		async (slug) => {
			const base = new URL(`../../templates/${slug}/`, import.meta.url);
			const result = await identifyThemeRelease(
				{
					readFile: async (path) => ({
						content: await readFile(
							new URL(path.replace("/build/", ""), base),
							"utf8",
						),
					}),
				},
				slug,
				"/build",
			);
			expect(result.upstreamStarterRevision).toMatch(/^[a-f0-9]{40}$/);
		},
	);
});

describe("renderer compatibility", () => {
	it("accepts each declared version, nested blocks and unversioned Portable Text", () => {
		expect(() =>
			requireSupportedBlocks(
				[
					{
						_type: "hero",
						_version: 1,
						children: [
							{ _type: "hero", _version: 2 },
							{ _type: "block", children: [] },
						],
					},
				],
				release,
			),
		).not.toThrow();
	});
	it.each([
		{ _type: "unknown", _version: 1 },
		{ _type: "hero", _version: 3 },
		{ _type: "hero", _version: "1" },
	])("refuses %j", (block) => {
		expect(() => requireSupportedBlocks({ nested: [block] }, release)).toThrow(
			expect.objectContaining({
				code: "THEME_BLOCK_UNSUPPORTED",
				retryable: false,
			}),
		);
	});
});
