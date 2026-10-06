#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { loadCloudflareConfigWorker } from "./wrangler-images-binding";

type Check = {
	name: string;
	ok: boolean;
	detail: string;
};

const { values } = parseArgs({
	options: {
		help: { default: false, type: "boolean" },
		json: { default: false, type: "boolean" },
	},
	strict: false,
});

if (values.help) {
	console.log(`Usage: bun run cms:scheduler:validate [--json]

Validates the Emdash scheduled publishing contract:
  - cms-runtime owns the deployed parent cron.
  - retired staging Workers cannot be recreated from package scripts or config.
  - cms-runtime fans scheduled events out to active tenant bundles.
  - the locked tenant starter and embedded template snapshot still export the
    native @emdash-cms/cloudflare worker entry, EmDashDB class, and cron trigger.
`);
	process.exit(0);
}

async function read(path: string): Promise<string> {
	return Bun.file(path).text();
}

function normalizeEmbeddedSource(source: string): string {
	return source.replaceAll('\\"', '"').replaceAll("\\n", "\n");
}

function countCronTriggers(source: string): number {
	const normalized = normalizeEmbeddedSource(source);
	const matches = normalized.match(
		/"crons"\s*:\s*\[\s*"\*\s+\*\s+\*\s+\*\s+\*"\s*\]/g,
	);
	return matches?.length ?? 0;
}

const RUNTIME_CONFIG = "apps/cms-runtime/cloudflare.config.ts";
const SITE_BUILDER_CONFIG = "apps/cms/cloudflare.config.ts";
const [
	runtimeSource,
	runtimeProduction,
	runtimeDevelopment,
	runtimePackage,
	siteBuilderProduction,
	siteBuilderDevelopment,
	siteBuilderPackage,
	starterWorker,
	starterWrangler,
	templateSnapshot,
] = await Promise.all([
	read("apps/cms-runtime/src/index.ts"),
	loadCloudflareConfigWorker(RUNTIME_CONFIG, "production"),
	loadCloudflareConfigWorker(RUNTIME_CONFIG, "development"),
	read("apps/cms-runtime/package.json"),
	loadCloudflareConfigWorker(SITE_BUILDER_CONFIG, "production"),
	loadCloudflareConfigWorker(SITE_BUILDER_CONFIG, "development"),
	read("apps/cms/package.json"),
	read("apps/cms/templates/tedix/src/worker.ts"),
	read("apps/cms/templates/tedix/wrangler.jsonc"),
	read("apps/cms/src/template-snapshot.ts"),
]);

const cronSchedules = (worker: typeof runtimeProduction): unknown[] =>
	(worker.triggers ?? [])
		.filter((trigger) => trigger.type === "scheduled")
		.map((trigger) => trigger.schedule);

const checks: Check[] = [
	{
		name: "runtime scheduled handler",
		ok:
			runtimeSource.includes("async scheduled(") &&
			runtimeSource.includes("listActiveBundles(env)") &&
			runtimeSource.includes(
				"TenantRuntimeEntrypoint extends WorkerEntrypoint",
			) &&
			runtimeSource.includes("tenantEntrypoint.scheduled("),
		detail:
			"apps/cms-runtime/src/index.ts should wrap tenant bundles and fan out scheduled events.",
	},
	{
		name: "runtime cron triggers",
		ok:
			JSON.stringify(cronSchedules(runtimeProduction)) === '["* * * * *"]' &&
			cronSchedules(runtimeDevelopment).length === 0,
		detail:
			"apps/cms-runtime/cloudflare.config.ts should define exactly one one-minute cron in production mode and none in development to avoid duplicate scheduled jobs.",
	},
	{
		name: "retired staging workers",
		ok:
			![
				runtimeProduction,
				runtimeDevelopment,
				siteBuilderProduction,
				siteBuilderDevelopment,
			].some(
				(worker) =>
					worker.name?.includes("staging") ||
					Object.values(worker.env ?? {}).some(
						(binding) =>
							typeof binding.worker === "string" &&
							binding.worker.includes("staging"),
					),
			) &&
			!runtimePackage.includes('"deploy:staging"') &&
			!siteBuilderPackage.includes('"deploy:staging"'),
		detail:
			"CMS runtime and Site Builder must not expose a staging deploy script or environment. Retired staging Workers shared production state and could duplicate scheduled work.",
	},
	{
		name: "starter worker export",
		ok:
			starterWorker.includes(
				'export { default, PluginBridge } from "@emdash-cms/cloudflare/worker";',
			) &&
			starterWorker.includes(
				'export { EmDashDB } from "@emdash-cms/cloudflare/db/do-sql";',
			),
		detail:
			"apps/cms/templates/tedix/src/worker.ts should use the native Emdash Cloudflare worker entry and export EmDashDB.",
	},
	{
		name: "starter cron trigger",
		ok: countCronTriggers(starterWrangler) >= 1,
		detail:
			"apps/cms/templates/tedix/wrangler.jsonc should keep the preview/local tenant cron.",
	},
	{
		name: "template snapshot scheduler",
		ok:
			normalizeEmbeddedSource(templateSnapshot).includes(
				'export { default, PluginBridge } from "@emdash-cms/cloudflare/worker";',
			) &&
			normalizeEmbeddedSource(templateSnapshot).includes(
				'export { EmDashDB } from "@emdash-cms/cloudflare/db/do-sql";',
			) &&
			countCronTriggers(templateSnapshot) >= 1,
		detail:
			"apps/cms/src/template-snapshot.ts should embed the worker export and cron trigger.",
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
