#!/usr/bin/env bun

/**
 * The Tedix OS Kumo design contract, in three parts (`bun run lint:kumo`).
 * There is no debt baseline: any finding exits 1.
 *
 * 1. COLORS — OS source uses Kumo semantic tokens or `--tedix-hue-*`
 *    categorical tokens, never a raw Tailwind palette step (`bg-emerald-500`).
 * 2. ADAPTERS — OS declares `@cloudflare/kumo`, product call sites import Kumo
 *    only through the app-local adapters (`apps/os/src/components/kumo/`) or
 *    the theme bridge, never the aggregate barrel, and the bridge loads both
 *    Kumo's Tailwind styles and the Tedix semantic projection.
 * 3. TOKENS — see below.
 */
/**
 * TOKENS: fail when the Tedix Kumo bridge (`packages/design-tokens/src/kumo.css`)
 * and Kumo's own theme-generator token set disagree. The projection is matched by
 * name only, so a token Kumo renames would silently fall back to Kumo's default.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "oxc-parser";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// ── 1. Colors ───────────────────────────────────────────────────────────────

export type ScanRoot = {
	readonly key: string;
	readonly dir: string;
	readonly extensions: readonly string[];
	readonly excludes: readonly RegExp[];
};

const COMMON_EXCLUDES = [
	/\/node_modules\//,
	/\/dist\//,
	/\.d\.ts$/,
	/\.stories\.[jt]sx?$/,
	/\.test\.(?:browser\.)?[jt]sx?$/,
] as const;

export const SCAN_ROOTS: readonly ScanRoot[] = [
	{
		key: "os",
		dir: join(REPO_ROOT, "apps/os/src"),
		extensions: [".ts", ".tsx"],
		excludes: COMMON_EXCLUDES,
	},
];

/*
 * The Tailwind v4 palette family names. `black`, `white`, and `transparent` are
 * deliberately absent — they carry no palette step and `bg-white`, `text-black`,
 * and `ring-transparent` stay legal under Kumo's rule 1.
 */
export const TAILWIND_COLOR_FAMILIES = new Set([
	"amber",
	"blue",
	"cyan",
	"emerald",
	"fuchsia",
	"gray",
	"green",
	"indigo",
	"lime",
	"neutral",
	"orange",
	"pink",
	"purple",
	"red",
	"rose",
	"sky",
	"slate",
	"stone",
	"teal",
	"violet",
	"yellow",
	"zinc",
]);

const COLOR_UTILITY_PREFIXES = [
	"accent",
	"bg",
	"border",
	"caret",
	"decoration",
	"divide",
	"fill",
	"from",
	"outline",
	"placeholder",
	"ring",
	"ring-offset",
	"stroke",
	"text",
	"to",
	"via",
];

const COLOR_UTILITY_RE = new RegExp(
	`(?:^|[^a-zA-Z0-9-])((?:[a-z-]+:)*)(${COLOR_UTILITY_PREFIXES.join(
		"|",
	)})-([a-z][a-z0-9]*)(?:-(\\d{2,3}))?(?:/\\d{1,3})?(?![a-zA-Z0-9-])`,
	"g",
);

export type Finding = { kind: "palette"; line: number; text: string };
function listSourceFiles(dir: string, root: ScanRoot): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const child = join(dir, entry.name);
		if (root.excludes.some((pattern) => pattern.test(`${child}/`))) return [];
		if (entry.isDirectory()) return listSourceFiles(child, root);
		if (!root.extensions.some((ext) => entry.name.endsWith(ext))) return [];
		return root.excludes.some((pattern) => pattern.test(child)) ? [] : [child];
	});
}

function lineNumberAt(source: string, index: number): number {
	return source.slice(0, index).split("\n").length;
}

export function scanFile(source: string): Finding[] {
	const findings: Finding[] = [];

	COLOR_UTILITY_RE.lastIndex = 0;
	for (
		let m = COLOR_UTILITY_RE.exec(source);
		m;
		m = COLOR_UTILITY_RE.exec(source)
	) {
		const [, variants = "", prefix, family, step] = m;
		if (!family || !TAILWIND_COLOR_FAMILIES.has(family)) continue;
		// A palette family with no numeric step is a Tailwind v4 named color only
		// when the family is a real palette name; `bg-red` alone is not emitted by
		// Tailwind, so require the step to avoid matching `text-green` in prose.
		if (!step) continue;
		findings.push({
			kind: "palette",
			line: lineNumberAt(source, m.index),
			text: `${variants}${prefix}-${family}-${step}`,
		});
	}

	return findings;
}

// ── 2. Adapters ─────────────────────────────────────────────────────────────

export type KumoAppSnapshot = {
	readonly app: "os";
	readonly bridge: string;
	readonly kumoVersion: string | undefined;
};

export type KumoImportSite = {
	readonly file: string;
	readonly source: string;
};

export type KumoAdapterContractInput = {
	readonly imports: readonly KumoImportSite[];
	readonly os: KumoAppSnapshot;
};

export const REQUIRED_BRIDGE_IMPORTS = [
	'@import "@cloudflare/kumo/styles/tailwind";',
	'@import "@tedix/design-tokens/kumo.css";',
] as const;

function isAuthorizedKumoImport(file: string): boolean {
	return (
		file.startsWith("apps/os/src/components/kumo/") ||
		// Landing owns its app-local UI adapters.
		file.startsWith("apps/landing/src/components/ui/") ||
		file === "apps/landing/src/styles/globals.css" ||
		file === "apps/os/src/kumo-tedix.css"
	);
}

export function analyzeKumoAdapterContract(
	input: KumoAdapterContractInput,
): string[] {
	const findings: string[] = [];

	if (!input.os.kumoVersion) {
		findings.push("OS must declare @cloudflare/kumo.");
	}

	for (const requiredImport of REQUIRED_BRIDGE_IMPORTS) {
		if (!input.os.bridge.includes(requiredImport)) {
			findings.push(`os Kumo bridge must import ${requiredImport}`);
		}
	}

	for (const site of input.imports) {
		if (!isAuthorizedKumoImport(site.file)) {
			findings.push(
				`${site.file} imports @cloudflare/kumo outside an authorized UI adapter or theme bridge.`,
			);
		}
		if (/from\s+["']@cloudflare\/kumo["']/.test(site.source)) {
			findings.push(
				`${site.file} imports Kumo's aggregate barrel; use a granular component or primitive module.`,
			);
		}
	}

	return findings;
}

/** The shape of an oxc top-level statement this gate reads. */
type ModuleStatement = {
	type: string;
	start: number;
	end: number;
	source?: { value: string };
};

const SKIP_DIRECTORIES = new Set([
	".git",
	".output",
	".tanstack",
	".wrangler",
	"dist",
	"node_modules",
]);
const SOURCE_EXTENSIONS = new Set([".css", ".ts", ".tsx"]);

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function collectFiles(
	directory: string,
	root = directory,
): Record<string, string> {
	const files: Record<string, string> = {};
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRECTORIES.has(entry.name)) {
				Object.assign(files, collectFiles(join(directory, entry.name), root));
			}
			continue;
		}
		if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name)))
			continue;
		const absolute = join(directory, entry.name);
		files[relative(root, absolute)] = readFileSync(absolute, "utf8");
	}
	return files;
}

/**
 * Top-level statements of one module, as oxc's ESTree nodes.
 *
 * `start`/`end` are offsets into the same string we pass in, so slicing it
 * reproduces a statement's source text exactly the way TypeScript's
 * `node.getText()` used to. A parse failure is a hard error rather than an
 * empty body: every one of the 4003 files this gate walks parses cleanly, so
 * a failure means malformed source, and silently returning no statements
 * would drop that file out of the contract without any signal.
 */
function parseModuleBody(
	path: string,
	source: string,
): ReadonlyArray<ModuleStatement> {
	const parsed = parseSync(path, source, {
		lang: path.endsWith(".tsx") ? "tsx" : "ts",
	});
	const failure = parsed.errors[0];
	if (failure) {
		throw new Error(`${path}: ${failure.message}`);
	}
	return parsed.program.body as ReadonlyArray<ModuleStatement>;
}

function snapshot(app: "os", bridgePath: string): KumoAppSnapshot {
	const packageJson = readJson(join(REPO_ROOT, `apps/${app}/package.json`));
	const dependencies = packageJson.dependencies as
		| Record<string, string>
		| undefined;
	return {
		app,
		bridge: readFileSync(join(REPO_ROOT, bridgePath), "utf8"),
		kumoVersion: dependencies?.["@cloudflare/kumo"],
	};
}

function collectKumoImports(): KumoImportSite[] {
	const imports: KumoImportSite[] = [];
	for (const root of ["apps", "packages"] as const) {
		const files = collectFiles(join(REPO_ROOT, root));
		for (const [file, source] of Object.entries(files)) {
			const repositoryPath = `${root}/${file}`;
			if (file.endsWith(".css")) {
				const matches = source.matchAll(
					/@import\s+["'](@cloudflare\/kumo(?:\/[^"']*)?)["']/g,
				);
				for (const match of matches) {
					imports.push({ file: repositoryPath, source: match[0] });
				}
				continue;
			}
			for (const statement of parseModuleBody(repositoryPath, source)) {
				if (
					statement.type !== "ImportDeclaration" &&
					statement.type !== "ExportNamedDeclaration" &&
					statement.type !== "ExportAllDeclaration"
				) {
					continue;
				}
				// `export { x }` with no `from` clause carries no specifier.
				const specifier = statement.source?.value;
				if (specifier?.startsWith("@cloudflare/kumo")) {
					imports.push({
						file: repositoryPath,
						source: source.slice(statement.start, statement.end),
					});
				}
			}
		}
	}
	return imports;
}

export function runKumoAdapterLint(): string[] {
	return analyzeKumoAdapterContract({
		imports: collectKumoImports(),
		os: snapshot("os", "apps/os/src/kumo-tedix.css"),
	});
}

// ── 3. Tokens ───────────────────────────────────────────────────────────────

const bridgePath = join(REPO_ROOT, "packages/design-tokens/src/kumo.css");

/**
 * Tokens we deliberately do not project, with the reason. Keep this empty
 * unless a token genuinely has no Tedix meaning — an entry here is a decision
 * to inherit Cloudflare's value, so it needs to be an argued one.
 */
const UNPROJECTED_BY_DESIGN = new Map<string, string>();

/**
 * Kumo resolves from `apps/os`, which is the app that consumes the bridge.
 * Resolving from the repo root would need the package hoisted to the root
 * manifest, which it is not.
 *
 * The theme-generator subpath publishes only an `import` condition, so
 * `require.resolve` on it fails. Resolve the manifest — which does publish a
 * default condition — and walk to the built config from there.
 */
function loadKumoThemeConfig(): Promise<{
	THEME_CONFIG: { color: object; text: object };
}> {
	const require = createRequire(
		pathToFileURL(join(REPO_ROOT, "apps/os/package.json")),
	);
	const packageRoot = dirname(require.resolve("@cloudflare/kumo/package.json"));
	const configPath = join(
		packageRoot,
		"dist/scripts/theme-generator/config.js",
	);
	return import(pathToFileURL(configPath).href);
}

export function authoritativeTokens(themeConfig: {
	color: object;
	text: object;
}): Set<string> {
	const tokens = new Set<string>();
	for (const name of Object.keys(themeConfig.color)) {
		tokens.add(`--color-${name}`);
	}
	for (const name of Object.keys(themeConfig.text)) {
		tokens.add(`--text-color-${name}`);
	}
	return tokens;
}

/**
 * Declarations only — a `var()` read is a consumer, not a projection, and the
 * bridge reads its own tokens constantly while deriving the surface ladder.
 */
export function projectedTokens(css: string): Set<string> {
	const declared = new Set<string>();
	for (const match of css.matchAll(
		/^\s*(--(?:color|text-color)-kumo-[a-z0-9-]+)\s*:/gm,
	)) {
		declared.add(match[1] as string);
	}
	return declared;
}

async function tokenFindings(): Promise<string[]> {
	const { THEME_CONFIG } = await loadKumoThemeConfig();
	const authoritative = authoritativeTokens(THEME_CONFIG);
	const projected = projectedTokens(readFileSync(bridgePath, "utf8"));
	const missing = [...authoritative]
		.filter((token) => !projected.has(token))
		.filter((token) => !UNPROJECTED_BY_DESIGN.has(token))
		.sort();
	const dead = [...projected]
		.filter((token) => !authoritative.has(token))
		.sort();
	const bridge = relative(REPO_ROOT, bridgePath);
	return [
		...missing.map(
			(token) =>
				`${bridge}: ${token} is themed by Kumo but never projected — the component silently keeps Cloudflare's default on every Tedix theme.`,
		),
		...dead.map(
			(token) =>
				`${bridge}: ${token} is projected but Kumo no longer defines it — most likely renamed upstream (\`bunx @cloudflare/kumo migrate\` reports declared renames).`,
		),
	];
}

// ── Runner ──────────────────────────────────────────────────────────────────

function colorFindings(): string[] {
	const findings: string[] = [];
	for (const root of SCAN_ROOTS) {
		if (!existsSync(root.dir)) continue;
		for (const file of listSourceFiles(root.dir, root)) {
			for (const finding of scanFile(readFileSync(file, "utf8"))) {
				findings.push(
					`${relative(REPO_ROOT, file)}:${finding.line}: ${finding.text} bypasses the OS theme. Use a Kumo semantic token or --tedix-hue-* categorical token.`,
				);
			}
		}
	}
	return findings;
}

if (import.meta.main) {
	const findings = [
		...colorFindings(),
		...runKumoAdapterLint(),
		...(await tokenFindings()),
	];
	if (findings.length > 0) {
		console.error("Kumo design contract failed:");
		for (const finding of findings) console.error(`  - ${finding}`);
		process.exit(1);
	}
	console.log(
		"Kumo design contract OK: semantic palette, adapter boundaries and token bridge are aligned.",
	);
}
