import type { CmsSandbox as CmsSandbox } from "../sandbox";
import { describe, expect, it } from "vite-plus/test";
import {
	TEMPLATE_SNAPSHOTS,
	TEMPLATE_SNAPSHOT_PATHS_BY_TEMPLATE,
} from "../template-snapshot";

import {
	diffTemplate,
	resyncTemplate,
	snapshotForTemplate,
} from "./template-sync";

function createSandbox(initial: Record<string, string> = {}): {
	sandbox: CmsSandbox;
	writes: Map<string, string>;
} {
	const files = new Map(Object.entries(initial));
	const writes = new Map<string, string>();
	return {
		sandbox: {
			async mkdir() {},
			async deleteFile(path: string) {
				files.delete(path);
			},
			async readFile(path: string) {
				const content = files.get(path);
				if (content === undefined) throw new Error(`Missing file: ${path}`);
				return { content, size: new TextEncoder().encode(content).byteLength };
			},
			async writeFile(path: string, content: string) {
				files.set(path, content);
				writes.set(path, content);
			},
		} as unknown as CmsSandbox,
		writes,
	};
}

describe("template-aware snapshot sync", () => {
	it.each([
		[undefined, "tedix"],
		[" tedix ", "tedix"],
		[" marketing ", "marketing"],
		["marketing", "marketing"],
	])("selects generated maps for %s", (input, slug) => {
		const selected = snapshotForTemplate(input);
		expect(selected.snapshot).toBe(TEMPLATE_SNAPSHOTS[slug!]);
		expect(selected.paths).toBe(TEMPLATE_SNAPSHOT_PATHS_BY_TEMPLATE[slug!]);
	});
	it.each(["locked", "all", "files"] as const)(
		"preserves unrelated tenant files during %s resync",
		async (scope) => {
			const path = "/workspace/src/components/TenantCustom.astro";
			const content = "<section>Tenant-authored component</section>";
			const { sandbox, writes } = createSandbox({ [path]: content });
			await resyncTemplate(sandbox, {
				scope,
				confirm: true,
				paths: ["astro.config.mjs"],
			});
			expect(await sandbox.readFile(path)).toMatchObject({ content });
			expect(writes.get("/workspace/astro.config.mjs")).toBe(
				TEMPLATE_SNAPSHOTS.tedix!["astro.config.mjs"],
			);
		},
	);
	it("resyncs the complete marketing lock set without adding it to Tedix", async () => {
		const marketing = createSandbox();
		const marketingResult = await resyncTemplate(marketing.sandbox, {
			scope: "locked",
			templateSlug: "marketing",
		});
		expect(marketingResult.copied).not.toContain(
			"src/layouts/BaseMarketing.astro",
		);
		expect(marketingResult.copied).toContain("bun.lock");
		expect(marketingResult.copied).toContain("patches/emdash@1.1.0.patch");
		expect(
			await marketing.sandbox.readFile("/workspace/bun.lock"),
		).toMatchObject({
			content: TEMPLATE_SNAPSHOTS.marketing!["bun.lock"],
		});
		expect(
			await marketing.sandbox.readFile("/workspace/patches/emdash@1.1.0.patch"),
		).toMatchObject({
			content: TEMPLATE_SNAPSHOTS.marketing!["patches/emdash@1.1.0.patch"],
		});
		expect(marketingResult.copied).toContain("src/lib/platform-branding.ts");
		expect(marketingResult.copied).toContain("src/lib/platform-rpc.ts");
		expect(
			await marketing.sandbox.readFile("/workspace/src/lib/platform-rpc.ts"),
		).toMatchObject({
			content: TEMPLATE_SNAPSHOTS.marketing!["src/lib/platform-rpc.ts"],
		});
		expect(marketingResult.copied).not.toContain(
			"src/components/blocks/Hero.astro",
		);

		const tedix = createSandbox();
		const tedixResult = await resyncTemplate(tedix.sandbox, {
			scope: "locked",
			templateSlug: "tedix",
		});
		expect(tedixResult.copied).not.toContain("src/layouts/BaseMarketing.astro");
		expect(tedixResult.copied).not.toContain(
			"src/components/blocks/Hero.astro",
		);
	});

	it("cleans pristine old starter files but preserves authored files during explicit initialization", async () => {
		const path = "src/components/blocks/Hero.astro";
		const pristine = createSandbox({
			[`/workspace/${path}`]: TEMPLATE_SNAPSHOTS.marketing![path]!,
		});
		const result = await resyncTemplate(pristine.sandbox, {
			scope: "all",
			confirm: true,
			templateSlug: "tedix",
		});
		expect(result.removed).toContain(path);
		await expect(
			pristine.sandbox.readFile(`/workspace/${path}`),
		).rejects.toThrow("Missing file");
		const authored = createSandbox({
			[`/workspace/${path}`]: "<CustomerEditedHero />",
		});
		await resyncTemplate(authored.sandbox, {
			scope: "all",
			confirm: true,
			templateSlug: "tedix",
		});
		expect(await authored.sandbox.readFile(`/workspace/${path}`)).toMatchObject(
			{ content: "<CustomerEditedHero />" },
		);
	});

	it("resyncs locked files into a private deploy root", async () => {
		const workspace =
			"/tmp/tedix-cms-deploy-11111111-1111-4111-8111-111111111111";
		const { sandbox, writes } = createSandbox({
			"/workspace/src/pages/index.astro": "<OtherBuild />",
		});
		await resyncTemplate(sandbox, {
			scope: "locked",
			templateSlug: "marketing",
			workspace,
		});
		expect(writes.get(`${workspace}/astro.config.mjs`)).toBe(
			TEMPLATE_SNAPSHOTS.marketing!["astro.config.mjs"],
		);
		expect(writes.has("/workspace/astro.config.mjs")).toBe(false);
		expect(
			await sandbox.readFile("/workspace/src/pages/index.astro"),
		).toMatchObject({ content: "<OtherBuild />" });
	});

	it("creates nested starter directories in a fresh deploy root before writing", async () => {
		const workspace = "/tmp/tedix-cms-deploy-fresh";
		const directories = new Set<string>();
		const writes: string[] = [];
		const sandbox = {
			async mkdir(path: string, options: { recursive?: boolean }) {
				expect(options.recursive).toBe(true);
				directories.add(path);
			},
			async writeFile(path: string) {
				const parent = path.slice(0, path.lastIndexOf("/"));
				if (parent !== workspace && !directories.has(parent))
					throw new Error(`Missing directory: ${parent}`);
				writes.push(path);
			},
		} as unknown as CmsSandbox;

		await resyncTemplate(sandbox, {
			scope: "locked",
			templateSlug: "tedix",
			workspace,
		});
		expect(writes).toContain(`${workspace}/src/auth/descope-jwt-boundary.ts`);
		expect(directories).toContain(`${workspace}/src/auth`);
	});

	it("does not mistake absent site-owned presentation for locked drift", async () => {
		const { sandbox } = createSandbox();
		const result = await diffTemplate(sandbox, "locked", "marketing");
		const shell = result.drifted.find(
			(entry) => entry.path === "src/layouts/BaseMarketing.astro",
		);
		const block = result.drifted.find(
			(entry) => entry.path === "src/components/blocks/Hero.astro",
		);
		expect(shell).toBeUndefined();
		expect(block).toBeUndefined();
	});
});
