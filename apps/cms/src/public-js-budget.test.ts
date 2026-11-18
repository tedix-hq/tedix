import { build } from "vite";
import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkPublicJsBudget,
	PUBLIC_JS_BUDGET_BYTES,
	publicJsFiles,
	publicJsManifest,
} from "../scripts/public-js-budget";

describe("public JS dependency budget", () => {
	it("validates a real emitted client graph without counting an admin entry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "cms-js-build-"));
		try {
			await mkdir(join(directory, "admin"));
			await writeFile(
				join(directory, "public.js"),
				'console.log("public"); import("./lazy.js");',
			);
			await writeFile(join(directory, "lazy.js"), 'console.log("lazy");');
			await writeFile(
				join(directory, "admin/index.js"),
				`console.log("${"x".repeat(PUBLIC_JS_BUDGET_BYTES)}");`,
			);
			await build({
				configFile: false,
				root: directory,
				logLevel: "silent",
				plugins: [publicJsManifest()],
				build: {
					outDir: "dist",
					rolldownOptions: {
						input: [
							join(directory, "public.js"),
							join(directory, "admin/index.js"),
						],
					},
				},
			});
			await expect(
				checkPublicJsBudget(join(directory, "dist")),
			).resolves.toMatchObject({ files: 2 });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("counts shared and dynamic dependencies once, excluding admin-only code", () => {
		expect(
			publicJsFiles({
				"src/public.ts": {
					file: "public.js",
					isEntry: true,
					imports: ["shared"],
					dynamicImports: ["lazy"],
				},
				"node_modules/emdash/admin/index.ts": {
					file: "admin.js",
					isEntry: true,
					imports: ["shared", "editor"],
				},
				registry: {
					file: "registry.js",
					isEntry: true,
					src: "/node_modules/emdash/dist/astro/routes/PluginRegistry.mjs",
				},
				"inline-editor": {
					file: "inline-editor.js",
					isEntry: true,
					src: "/node_modules/emdash/src/components/InlinePortableTextEditor.tsx",
				},
				"virtual-admin": {
					file: "virtual-admin.js",
					isEntry: true,
					src: "\0virtual:emdash/admin-entry",
				},
				shared: { file: "shared.js" },
				lazy: { file: "lazy.js", imports: ["shared", "src/public.ts"] },
				editor: { file: "editor.js" },
			}),
		).toEqual(["lazy.js", "public.js", "shared.js"]);
	});
	it("rejects oversized output and a reachable icon barrel", async () => {
		const directory = await mkdtemp(join(tmpdir(), "cms-js-budget-"));
		try {
			const manifestPath = join(directory, "public-js-manifest.json");
			await writeFile(
				manifestPath,
				JSON.stringify({ main: { file: "main.js", isEntry: true } }),
			);
			await writeFile(
				join(directory, "main.js"),
				"a".repeat(PUBLIC_JS_BUDGET_BYTES + 1),
			);
			await expect(checkPublicJsBudget(directory)).rejects.toThrow(
				"Public JS budget exceeded",
			);
			await writeFile(join(directory, "main.js"), "ok");
			await expect(checkPublicJsBudget(directory)).resolves.toMatchObject({
				bytes: 2,
				files: 1,
			});
			await writeFile(
				manifestPath,
				JSON.stringify({ main: { file: "index.es.hash.js", isEntry: true } }),
			);
			await writeFile(join(directory, "index.es.hash.js"), "icons");
			await expect(checkPublicJsBudget(directory)).rejects.toThrow(
				"Phosphor index.es",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("counts script bytes even when Astro later inlines the file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "cms-js-inline-"));
		try {
			await writeFile(
				join(directory, "public-js-manifest.json"),
				JSON.stringify({
					"inline.js": { file: "inline.js", isEntry: true, bytes: 42 },
				}),
			);
			await expect(checkPublicJsBudget(directory)).resolves.toMatchObject({
				bytes: 42,
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("fails closed on missing dependencies or missing public entries", () => {
		expect(() => publicJsFiles({})).toThrow("No public JS entries");
		expect(() =>
			publicJsFiles({
				main: { file: "main.js", isEntry: true, imports: ["absent"] },
			}),
		).toThrow("Missing JS manifest dependency");
	});
});
