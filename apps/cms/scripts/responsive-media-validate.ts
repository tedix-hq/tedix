#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { TEMPLATE_SNAPSHOTS } from "../src/template-snapshot";
import {
	inspectCloudflareConfigImagesBinding,
	inspectImagesBinding,
} from "./wrangler-images-binding";

type Check = {
	detail: string;
	name: string;
	ok: boolean;
};

type ImageServiceMode =
	| "cloudflare-binding"
	| "default"
	| "passthrough"
	| "unknown";

const { values } = parseArgs({
	options: {
		help: { default: false, type: "boolean" },
		json: { default: false, type: "boolean" },
	},
	strict: false,
});

if (values.help) {
	console.log(`Usage: bun run cms:responsive-media:validate [--json]

Validates the Tedix CMS responsive-media contract:
  - both locked tenant starters use an Emdash line with responsive media support.
  - both starters and embedded template snapshots enable Emdash images and
    Astro cloudflare-binding, with a scoped media pattern for mounted sites.
  - cloudflare-binding is only considered ready when cms-runtime declares the
    native Cloudflare Images binding on itself (parent-only — it cannot be
    forwarded into a Worker Loader-dispatched tenant isolate) and intercepts
    /_image transform requests directly, before Worker Loader dispatch.
  - neither tenant starter declares an images binding — it would be dead
    config, since the isolate never receives one under this design.
`);
	process.exit(0);
}

async function read(path: string): Promise<string> {
	return Bun.file(path).text();
}

function detectImageService(source: string): ImageServiceMode {
	if (source.includes('imageService: "cloudflare-binding"')) {
		return "cloudflare-binding";
	}
	if (source.includes("imageService: 'cloudflare-binding'")) {
		return "cloudflare-binding";
	}
	if (source.includes('imageService: "passthrough"')) {
		return "passthrough";
	}
	if (source.includes("imageService: 'passthrough'")) {
		return "passthrough";
	}
	if (!source.includes("imageService:")) return "default";
	return "unknown";
}

function hasMountedMediaPattern(source: string): boolean {
	return (
		source.includes("PUBLIC_PATH_PREFIX") &&
		source.includes("const publicHostname = new URL(publicSiteUrl).hostname") &&
		source.includes("image: publicPathPrefix") &&
		source.includes("remotePatterns:") &&
		source.includes('protocol: "https"') &&
		source.includes("hostname: publicHostname") &&
		source.includes("pathname: `${publicPathPrefix}/_emdash/api/media/file/**`")
	);
}

function describeBindingScopes(
	path: string,
	report: ReturnType<typeof inspectImagesBinding>,
): string {
	if (report.parseErrors.length > 0) {
		return ` ${path} did not parse as JSONC: ${report.parseErrors.join("; ")}.`;
	}
	const declared = report.scopes
		.filter((scope) => scope.declared)
		.map((scope) => scope.scope);
	return ` ${path} scopes declaring IMAGES: ${declared.length > 0 ? declared.join(", ") : "none"}; scopes without it: ${report.missingScopes.length > 0 ? report.missingScopes.join(", ") : "none"}.`;
}

function hasCompatibleEmdashRange(range: string | undefined): boolean {
	if (!range) return false;
	const match = range.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 0 || minor >= 19;
}

const starterSlugs = ["tedix", "marketing"] as const;
const RUNTIME_CONFIG = "apps/cms-runtime/cloudflare.config.ts";
const [starters, runtimeImages, runtimeSource, cmsDoc] = await Promise.all([
	Promise.all(
		starterSlugs.map(async (slug) => {
			const base = `apps/cms/templates/${slug}`;
			const [packageSource, astroConfig, wrangler] = await Promise.all([
				read(`${base}/package.json`),
				read(`${base}/astro.config.mjs`),
				read(`${base}/wrangler.jsonc`),
			]);
			const manifest = JSON.parse(packageSource) as {
				dependencies?: Record<string, string>;
			};
			const snapshotConfig = TEMPLATE_SNAPSHOTS[slug]?.["astro.config.mjs"];
			return {
				slug,
				base,
				astroConfig,
				snapshotConfig,
				wrangler,
				emdashRange: manifest.dependencies?.emdash,
				mode: detectImageService(astroConfig),
				snapshotMode: detectImageService(snapshotConfig ?? ""),
				imagesEnabled: /\bimages:\s*true\b/.test(astroConfig),
			};
		}),
	),
	inspectCloudflareConfigImagesBinding(RUNTIME_CONFIG),
	read("apps/cms-runtime/src/index.ts"),
	read("docs/emdash/cms.md"),
]);
// Both questions below are answered per scope: every cf mode of the runtime,
// every parsed Wrangler environment of a starter (named envs do not inherit).
const starterImages = starters.map((starter) => ({
	slug: starter.slug,
	report: inspectImagesBinding(starter.wrangler),
}));
// The runtime must declare IMAGES in EVERY mode it can be deployed or run in.
const runtimeDeclaresImagesBinding =
	runtimeImages.parseErrors.length === 0 && runtimeImages.declaredEverywhere;
// The starter must declare it in NO scope. A parse failure cannot prove
// absence, so it counts as "declared" and fails the check closed.
const starterDeclaresImagesBinding = starterImages.some(
	({ report }) => report.parseErrors.length > 0 || report.declaredAnywhere,
);
const runtimeTypesImagesBinding =
	runtimeSource.includes("IMAGES") && runtimeSource.includes("ImagesBinding");
// Native bindings (R2/KV, and now Images) can't be forwarded into a Worker
// Loader-dispatched tenant isolate — see TenantR2 in
// apps/cms-runtime/src/index.ts. Images transforms are instead intercepted
// and served directly by the parent Worker, before Worker Loader dispatch.
const runtimeInterceptsImageRoute =
	runtimeSource.includes("imageTransformResponse") &&
	runtimeSource.includes('IMAGE_ENDPOINT_ROUTE = "/_image"') &&
	runtimeSource.includes("await imageTransformResponse(");
const responsiveMediaEnabled = starters.every(
	(starter) => starter.mode === "cloudflare-binding" && starter.imagesEnabled,
);

const checks: Check[] = [
	...starters.flatMap((starter): Check[] => [
		{
			name: `${starter.slug} responsive-media package line`,
			ok: hasCompatibleEmdashRange(starter.emdashRange),
			detail: `${starter.base}/package.json must use Emdash 0.19+ for native responsive images.`,
		},
		{
			name: `${starter.slug} image configuration and snapshot`,
			ok:
				starter.mode === "cloudflare-binding" &&
				starter.snapshotMode === "cloudflare-binding" &&
				starter.imagesEnabled &&
				starter.snapshotConfig === starter.astroConfig &&
				hasMountedMediaPattern(starter.astroConfig),
			detail: `${starter.base}/astro.config.mjs and its embedded snapshot must enable cloudflare-binding, Emdash images, and only the site's HTTPS media path when PUBLIC_PATH_PREFIX is set.`,
		},
	]),
	{
		name: "docs mention responsive media validator",
		ok:
			cmsDoc.includes("cms:responsive-media:validate") &&
			cmsDoc.includes("responsive-media"),
		detail:
			"docs/emdash/cms.md should tell operators which validator gates responsive media changes.",
	},
	{
		name: "cloudflare-binding runtime path",
		ok:
			!responsiveMediaEnabled ||
			(runtimeDeclaresImagesBinding &&
				runtimeTypesImagesBinding &&
				runtimeInterceptsImageRoute),
		detail: `cloudflare-binding requires cms-runtime to declare a native IMAGES binding on itself in every deployable scope and intercept /_image transform requests before Worker Loader dispatch (see imageTransformResponse() in apps/cms-runtime/src/index.ts) — the binding cannot be forwarded into the dispatched tenant isolate.${describeBindingScopes(RUNTIME_CONFIG, runtimeImages)}`,
	},
	{
		name: "tenant starters do not declare an images binding",
		ok: !starterDeclaresImagesBinding,
		detail: `Tenant starters must not declare an images binding — transforms are served by the parent runtime.${starterImages.map(({ slug, report }) => describeBindingScopes(`apps/cms/templates/${slug}/wrangler.jsonc`, report)).join("")}`,
	},
];

const ok = checks.every((check) => check.ok);
const result = {
	checks,
	imageService: {
		responsiveMediaEnabled,
		starters: starters.map((starter) => ({
			slug: starter.slug,
			mode: starter.mode,
			snapshotMode: starter.snapshotMode,
			imagesEnabled: starter.imagesEnabled,
			snapshotMatches: starter.snapshotConfig === starter.astroConfig,
			mountedMediaPattern: hasMountedMediaPattern(starter.astroConfig),
		})),
		starterDeclaresImagesBinding,
		starterImagesScopes: starterImages,
		runtimeDeclaresImagesBinding,
		runtimeImagesScopes: runtimeImages,
		runtimeTypesImagesBinding,
		runtimeInterceptsImageRoute,
	},
	ok,
};

if (values.json) {
	console.log(JSON.stringify(result, null, 2));
} else {
	for (const check of checks) {
		console.log(`${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}`);
	}
	console.log(
		`imageService=${starters.map(({ slug, mode }) => `${slug}:${mode}`).join(",")} responsiveMediaEnabled=${responsiveMediaEnabled}`,
	);
}

if (!ok) process.exit(1);
