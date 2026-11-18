import type { Plugin } from "vite";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

interface ManifestEntry {
	file: string;
	src?: string | null;
	bytes?: number;
	isEntry?: boolean;
	imports?: string[];
	dynamicImports?: string[];
}

export const PUBLIC_JS_BUDGET_BYTES = 1024 * 1024;

export function publicJsFiles(
	manifest: Record<string, ManifestEntry>,
): string[] {
	const visited = new Set<string>();
	const files = new Set<string>();
	function visit(key: string) {
		if (visited.has(key)) return;
		visited.add(key);
		const entry = manifest[key];
		if (!entry) throw new Error(`Missing JS manifest dependency: ${key}`);
		if (/\.m?js$/.test(entry.file)) files.add(entry.file);
		for (const dependency of [
			...(entry.imports ?? []),
			...(entry.dynamicImports ?? []),
		]) {
			visit(dependency);
		}
	}
	for (const [key, entry] of Object.entries(manifest)) {
		// Admin/editor entries are separate pages; shared dependencies still count
		// whenever a public entry imports them.
		if (
			entry.isEntry &&
			!/(?:^|\/)(?:admin|editor)(?:[-/.]|$)/.test(entry.src ?? key) &&
			!/\/emdash\/(?:dist\/astro\/routes\/PluginRegistry\.mjs|src\/components\/InlinePortableTextEditor\.tsx)$/.test(
				entry.src ?? key,
			)
		)
			visit(key);
	}
	if (files.size === 0)
		throw new Error("No public JS entries in client manifest");
	return [...files].sort();
}

export async function checkPublicJsBudget(clientDirectory: string) {
	const manifest = JSON.parse(
		await readFile(resolve(clientDirectory, "public-js-manifest.json"), "utf8"),
	) as Record<string, ManifestEntry>;
	const files = publicJsFiles(manifest);
	// Count compiler output before Astro inlines small scripts into HTML.
	const entriesByFile = new Map(
		Object.values(manifest).map((entry) => [entry.file, entry]),
	);
	const sizes = await Promise.all(
		files.map(
			async (file) =>
				entriesByFile.get(file)?.bytes ??
				(await stat(resolve(clientDirectory, file))).size,
		),
	);
	const bytes = sizes.reduce((sum, size) => sum + size, 0);
	if (files.some((file) => /(?:^|\/)index\.es[.-]/.test(file))) {
		throw new Error("Public JS includes the Phosphor index.es barrel chunk");
	}
	if (bytes > PUBLIC_JS_BUDGET_BYTES) {
		throw new Error(
			`Public JS budget exceeded: ${bytes} > ${PUBLIC_JS_BUDGET_BYTES} bytes`,
		);
	}
	return { bytes, files: files.length, budget: PUBLIC_JS_BUDGET_BYTES };
}

export function publicJsManifest(): Plugin {
	return {
		name: "tedix-public-js-manifest",
		generateBundle(_options, bundle) {
			if (this.environment.name !== "client") return;
			// Astro disables Vite's manifest. Record the emitted client graph
			// directly, retaining source IDs to distinguish admin entries.
			const manifest = Object.fromEntries(
				Object.values(bundle)
					.filter((output) => output.type === "chunk")
					.map((chunk) => [
						chunk.fileName,
						{
							file: chunk.fileName,
							src: chunk.facadeModuleId,
							bytes: new TextEncoder().encode(chunk.code).byteLength,
							isEntry: chunk.isEntry,
							imports: chunk.imports,
							dynamicImports: chunk.dynamicImports,
						},
					]),
			);
			this.emitFile({
				type: "asset",
				fileName: "public-js-manifest.json",
				source: JSON.stringify(manifest),
			});
		},
	};
}
