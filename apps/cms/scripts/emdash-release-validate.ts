#!/usr/bin/env bun

import { parseArgs } from "node:util";

type Check = {
	detail: string;
	name: string;
	ok: boolean;
};

const TEMPLATE_PACKAGE = "apps/cms/templates/tedix/package.json";
const MARKETING_TEMPLATE_PACKAGE = "apps/cms/templates/marketing/package.json";
const MARKETING_TEMPLATE_SEED = "apps/cms/templates/marketing/seed/seed.json";
const CMS_RUNTIME_PACKAGE = "apps/cms-runtime/package.json";
const CMS_RUNTIME_ENTRY = "apps/cms-runtime/src/index.ts";
const TEMPLATE_CONTENT_URL = "apps/cms/templates/tedix/src/lib/content-url.ts";
const TEMPLATE_ASTRO_CONFIG = "apps/cms/templates/tedix/astro.config.mjs";
const MARKETING_ASTRO_CONFIG = "apps/cms/templates/marketing/astro.config.mjs";
const TEMPLATE_DIR = "apps/cms/templates/tedix";
const MARKETING_DIR = "apps/cms/templates/marketing";
const TEMPLATE_DO_SQL_DESCRIPTOR =
	"apps/cms/templates/tedix/src/lib/worker-loader-durable-objects.mjs";
const MARKETING_DO_SQL_DESCRIPTOR =
	"apps/cms/templates/marketing/src/lib/worker-loader-durable-objects.mjs";
const TEMPLATE_DO_SQL_ADAPTER =
	"apps/cms/templates/tedix/src/lib/worker-loader-do-sql-runtime.ts";
const MARKETING_DO_SQL_ADAPTER =
	"apps/cms/templates/marketing/src/lib/worker-loader-do-sql-runtime.ts";
const NETWORK_PLUGIN_RUNTIMES = [
	"apps/cms/templates/tedix/src/plugins/emdash-newsletter/index.ts",
	"apps/cms/templates/tedix/src/plugins/tedix-tedi-bridge/index.ts",
] as const;
const { values } = parseArgs({
	options: {
		help: { default: false, type: "boolean" },
		json: { default: false, type: "boolean" },
	},
	strict: false,
});

if (values.help) {
	console.log(`Usage: bun run cms:emdash-release:validate [--json]

Validates the Tedix CMS Emdash release line:
  - both tenant starters and cms-runtime resolve the cms-runtime release line.
  - bun.lock resolves one current package set instead of older release lines.
`);
	process.exit(0);
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await Bun.file(path).text()) as T;
}

async function read(path: string): Promise<string> {
	return Bun.file(path).text();
}

function dependencyRange(
	manifest: {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	},
	name: string,
): string | undefined {
	return (
		manifest.dependencies?.[name] ??
		manifest.peerDependencies?.[name] ??
		manifest.devDependencies?.[name]
	);
}

function resolvedDependencyRange(
	manifest: Parameters<typeof dependencyRange>[0],
	name: string,
	catalog: Record<string, string>,
): string | undefined {
	const declared = dependencyRange(manifest, name);
	return declared === "catalog:" ? catalog[name] : declared;
}

function patchSections(patch: string): Map<string, string> {
	return new Map(
		patch
			.split(/^diff --git /m)
			.slice(1)
			.map((section) => {
				const header = section.slice(0, section.indexOf("\n"));
				return [header, `diff --git ${section}`];
			}),
	);
}

const rootPackage = await readJson<{
	catalog?: Record<string, string>;
	patchedDependencies?: Record<string, string>;
}>("package.json");
const catalog = rootPackage.catalog ?? {};
const cmsRuntimePackage = await readJson<{
	dependencies?: Record<string, string>;
}>(CMS_RUNTIME_PACKAGE);
const EXPECTED_EMDASH_RANGE = resolvedDependencyRange(
	cmsRuntimePackage,
	"emdash",
	catalog,
);
if (!EXPECTED_EMDASH_RANGE) {
	throw new Error(`${CMS_RUNTIME_PACKAGE} must declare emdash`);
}
const EXPECTED_EMDASH_VERSION = EXPECTED_EMDASH_RANGE.replace(/^\^/, "");
// Bun keys patchedDependencies by exact version and every install (root and
// both standalone starters) names its patch file the same way.
const CLOUDFLARE_PATCH_KEY = `@emdash-cms/cloudflare@${EXPECTED_EMDASH_VERSION}`;
const EMDASH_PATCH_KEY = `emdash@${EXPECTED_EMDASH_VERSION}`;
const CLOUDFLARE_PATCH_FILE = `patches/${CLOUDFLARE_PATCH_KEY}.patch`;
const EMDASH_PATCH_FILE = `patches/${EMDASH_PATCH_KEY}.patch`;
// The one hunk marketing carries beyond the root emdash patch: it drops the
// deferred prefetchLayoutData() after anonymous HTML responses.
const MARKETING_ONLY_EMDASH_SECTIONS = ["a/dist/astro/middleware.mjs"];

const [
	templatePackage,
	marketingTemplatePackage,
	marketingTemplateSeed,
	templateContentUrl,
	templateAstroConfig,
	marketingAstroConfig,
	cloudflareDoSqlPatch,
	emdashRegistryPatch,
	templateCloudflarePatch,
	marketingCloudflarePatch,
	templateEmdashPatch,
	marketingEmdashPatch,
	templateDoSqlDescriptor,
	marketingDoSqlDescriptor,
	templateDoSqlAdapter,
	marketingDoSqlAdapter,
	cmsRuntimeEntry,
	networkPluginRuntimes,
	lockfile,
] = await Promise.all([
	readJson<{
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		patchedDependencies?: Record<string, string>;
	}>(TEMPLATE_PACKAGE),
	readJson<{
		dependencies?: Record<string, string>;
		patchedDependencies?: Record<string, string>;
	}>(MARKETING_TEMPLATE_PACKAGE),
	readJson<{
		collections?: Array<{ slug?: string; sortOrder?: number }>;
	}>(MARKETING_TEMPLATE_SEED),
	read(TEMPLATE_CONTENT_URL),
	read(TEMPLATE_ASTRO_CONFIG),
	read(MARKETING_ASTRO_CONFIG),
	read(CLOUDFLARE_PATCH_FILE),
	read(EMDASH_PATCH_FILE),
	read(`${TEMPLATE_DIR}/${CLOUDFLARE_PATCH_FILE}`),
	read(`${MARKETING_DIR}/${CLOUDFLARE_PATCH_FILE}`),
	read(`${TEMPLATE_DIR}/${EMDASH_PATCH_FILE}`),
	read(`${MARKETING_DIR}/${EMDASH_PATCH_FILE}`),
	read(TEMPLATE_DO_SQL_DESCRIPTOR),
	read(MARKETING_DO_SQL_DESCRIPTOR),
	read(TEMPLATE_DO_SQL_ADAPTER),
	read(MARKETING_DO_SQL_ADAPTER),
	read(CMS_RUNTIME_ENTRY),
	Promise.all(NETWORK_PLUGIN_RUNTIMES.map(read)),
	read("bun.lock"),
]);
const corePatchSections = patchSections(emdashRegistryPatch);
const marketingPatchSections = patchSections(marketingEmdashPatch);
const LOCK_EXPECTATIONS = [
	"@emdash-cms/admin",
	"@emdash-cms/auth",
	"@emdash-cms/blocks",
	"@emdash-cms/cloudflare",
	"@emdash-cms/gutenberg-to-portable-text",
	"emdash",
].map((name) => `${name}@${EXPECTED_EMDASH_VERSION}`);

const missingLockEntries = LOCK_EXPECTATIONS.filter(
	(pkg) => !lockfile.includes(pkg),
);
const marketingCollectionOrder = new Map(
	(marketingTemplateSeed.collections ?? []).map((collection) => [
		collection.slug,
		collection.sortOrder,
	]),
);
const staleLockEntries = [
	...(
		lockfile.match(
			/(?:@emdash-cms\/(?:admin|auth|blocks|cloudflare|gutenberg-to-portable-text)|emdash)@\d+\.\d+\.\d+(?:-rc\.\d+)?/g,
		) ?? []
	).filter((entry) => !entry.endsWith(`@${EXPECTED_EMDASH_VERSION}`)),
	...(lockfile.match(/@emdash-cms\/plugin-types@0\.(?:0|1|2)\.\d+/g) ?? []),
	...(lockfile.match(/@emdash-cms\/registry-client@0\.3\.[0-3]/g) ?? []),
].filter((entry, index, all) => all.indexOf(entry) === index);

const checks: Check[] = [
	{
		name: "runtime and starter emdash package line",
		ok:
			dependencyRange(templatePackage, "emdash") === EXPECTED_EMDASH_RANGE &&
			dependencyRange(templatePackage, "@emdash-cms/cloudflare") ===
				EXPECTED_EMDASH_RANGE &&
			dependencyRange(marketingTemplatePackage, "emdash") ===
				EXPECTED_EMDASH_RANGE &&
			dependencyRange(marketingTemplatePackage, "@emdash-cms/cloudflare") ===
				EXPECTED_EMDASH_RANGE &&
			resolvedDependencyRange(
				cmsRuntimePackage,
				"@emdash-cms/cloudflare",
				catalog,
			) === EXPECTED_EMDASH_RANGE,
		detail: `cms-runtime and both tenant templates should use the canonical Emdash package line ${EXPECTED_EMDASH_RANGE}.`,
	},
	{
		name: "tenant DO collection deletion uses the parent guard",
		ok:
			[rootPackage, templatePackage, marketingTemplatePackage].every(
				(pkg) =>
					pkg.patchedDependencies?.[CLOUDFLARE_PATCH_KEY] ===
						CLOUDFLARE_PATCH_FILE &&
					pkg.patchedDependencies?.[EMDASH_PATCH_KEY] === EMDASH_PATCH_FILE,
			) &&
			templateCloudflarePatch === cloudflareDoSqlPatch &&
			marketingCloudflarePatch === cloudflareDoSqlPatch &&
			templateEmdashPatch === emdashRegistryPatch &&
			[...corePatchSections].every(
				([header, section]) => marketingPatchSections.get(header) === section,
			) &&
			[...marketingPatchSections.keys()]
				.filter((header) => !corePatchSections.has(header))
				.every((header) =>
					MARKETING_ONLY_EMDASH_SECTIONS.some((file) =>
						header.startsWith(`${file} `),
					),
				) &&
			cloudflareDoSqlPatch.includes("registry_deleted") &&
			cloudflareDoSqlPatch.includes("checkpoint.toArray().length !== 1") &&
			emdashRegistryPatch.includes('action: "registry"') &&
			emdashRegistryPatch.includes('outcome: "registry_deleted"') &&
			[templateDoSqlDescriptor, marketingDoSqlDescriptor].every((descriptor) =>
				descriptor.includes("supportsCollectionDeletionGuard: true"),
			) &&
			[templateDoSqlAdapter, marketingDoSqlAdapter].every(
				(adapter) =>
					adapter.includes("export function executeCollectionDeletionGuard(") &&
					adapter.includes(
						"getBinding(config).executeCollectionDeletionGuard(input)",
					),
			) &&
			cmsRuntimeEntry.includes(
				"this.stub().executeCollectionDeletionGuard(input)",
			),
		detail:
			"root and both starters should install the same versioned Emdash patches (marketing may add only its layout-prefetch hunk), export the registry guard through the parent WorkerEntrypoint, and checkpoint inside the owning DO transaction.",
	},
	{
		name: "marketing collection order",
		ok:
			marketingCollectionOrder.get("pages") === 10 &&
			marketingCollectionOrder.get("posts") === 20,
		detail:
			"new marketing tenants should list Pages before Posts using Emdash collection sortOrder.",
	},
	{
		name: "lockfile resolves one current Emdash package line",
		ok: missingLockEntries.length === 0 && staleLockEntries.length === 0,
		detail:
			missingLockEntries.length === 0 && staleLockEntries.length === 0
				? `bun.lock resolves only the Emdash ${EXPECTED_EMDASH_VERSION} package set.`
				: `Missing: ${missingLockEntries.join(", ") || "none"}; stale: ${
						staleLockEntries.join(", ") || "none"
					}`,
	},
	{
		name: "tenant template avoids global promise caches",
		ok:
			!templateContentUrl.includes("Map<string, Promise") &&
			templateContentUrl.includes("collectionPatternValueCache"),
		detail:
			"apps/cms/templates/tedix/src/lib/content-url.ts should cache resolved URL pattern values, not in-flight promises.",
	},
	{
		name: "tenant templates use the session-neutral toolbar mode",
		ok:
			templateAstroConfig.includes('toolbar: "client"') &&
			marketingAstroConfig.includes('toolbar: "client"'),
		detail:
			'both tenant templates should use toolbar: "client" so public HTML remains session-neutral; shared parent response caching is currently disabled.',
	},
	{
		name: "custom DO SQL adapter supports cold-start coalescing",
		ok: [templateDoSqlAdapter, marketingDoSqlAdapter].every(
			(adapter) =>
				adapter.includes("export function createCoalescingDialect") &&
				adapter.includes("getSingletonBookmarkSink(config)") &&
				adapter.includes("FLUSH_RECLAIM_MS") &&
				adapter.includes("reclaimStrandedFlush"),
		),
		detail:
			"both tenant templates' Worker Loader DO SQL adapters should export the coalescing dialect, share its singleton bookmark sink, and reclaim cancelled-request flush timers.",
	},
	{
		name: "image transforms inherit upstream quality defaults",
		ok:
			cmsRuntimeEntry.includes("resolveTransformQuality") &&
			cmsRuntimeEntry.includes("effectiveQuality !== undefined"),
		detail:
			"the parent /_image endpoint should use Emdash's format-aware transform quality resolver.",
	},
	{
		name: "plugin network calls remain capability gated",
		ok: networkPluginRuntimes.every(
			(runtime) =>
				runtime.includes("ctx.http.fetch") && !runtime.includes("ctx.fetch("),
		),
		detail:
			"Tedix template plugins should use PluginContext.http.fetch instead of ambient or legacy fetch surfaces.",
	},
];

const ok = checks.every((check) => check.ok);
const result = { checks, ok };

if (values.json) {
	console.log(JSON.stringify(result, null, 2));
} else {
	for (const check of checks) {
		console.log(`${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}`);
	}
}

if (!ok) process.exit(1);
