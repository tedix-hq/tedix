#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { loadCloudflareConfigWorker } from "./wrangler-images-binding";

type Check = {
	detail: string;
	name: string;
	ok: boolean;
};

type DatabaseAdapter = "d1" | "durableObjects" | "unknown";

type LiveMetrics = {
	dbCount: number | null;
	rpcCount: number | null;
};

type LiveProbeSample = {
	finalUrl: string;
	metrics: LiveMetrics;
	ok: boolean;
	sample: number;
	status: number | null;
};

type DatabaseRuntimeProbeResult = {
	activeBundleDatabaseAdapter: DatabaseAdapter | null;
	activeBundleDatabaseAdapterEvidence: string[];
	activeBundleMainModule: string | null;
	activeBundleModuleCount: number | null;
	activeBundleVersion: number | null;
	endpoint: string;
	error?: string;
	ok: boolean;
	status: number | null;
};

type LiveProbeResult = {
	databaseRuntime?: DatabaseRuntimeProbeResult;
	finalUrl: string;
	metrics: LiveMetrics;
	ok: boolean;
	samples: LiveProbeSample[];
	status: number | null;
	tenant: string;
	url: string;
};

const { values } = parseArgs({
	options: {
		help: { default: false, type: "boolean" },
		json: { default: false, type: "boolean" },
		live: { default: false, type: "boolean" },
		"live-samples": { default: "2", type: "string" },
		"live-timeout-ms": { default: "45000", type: "string" },
		"assert-runtime": { default: false, type: "boolean" },
		"internal-token-env": {
			default: "CMS_INTERNAL_AUTH_TOKEN",
			type: "string",
		},
	},
	strict: true,
});

if (values.help) {
	console.log(`Usage: bun run cms:database-architecture:validate [--json] [--live] [--assert-runtime]

Validates the Tedix CMS tenant database architecture contract:
  - production tenant bundles use Emdash durableObjects() SQLite.
  - the embedded template snapshot matches the locked tenant starter.
  - cms-runtime declares EmDashDB and injects a serializable DB_DO RPC stub
    through Worker Loader.
  - docs and get_site_overview expose the same database-runtime contract.

With --live, fetches the configured public CMS routes twice by default and
captures Emdash db.count/rpc.count. Use --live-samples=N to change the sample
count.

Use --assert-runtime to call the protected runtime diagnostic endpoint and
require each tenant's active R2 bundle to report databaseAdapter =
durableObjects. It requires the internal token in CMS_INTERNAL_AUTH_TOKEN by
default; override with --internal-token-env=NAME.
`);
	process.exit(0);
}

async function read(path: string): Promise<string> {
	return Bun.file(path).text();
}

function normalizeEmbeddedSource(source: string): string {
	return source.replaceAll('\\"', '"').replaceAll("\\n", "\n");
}

function detectAdapter(source: string): DatabaseAdapter {
	if (source.includes("durableObjects(")) return "durableObjects";
	if (source.includes("d1({") || source.includes("database: d1(")) {
		return "d1";
	}
	return "unknown";
}

function hasDurableObjectsContract(source: string): boolean {
	return (
		source.includes('binding: "DB_DO"') &&
		source.includes("name: cmsDatabaseName") &&
		source.includes('session: "auto"') &&
		source.includes("durableObjects(")
	);
}

const liveTimeoutMs = Math.max(
	1000,
	Math.min(120_000, Number(values["live-timeout-ms"]) || 45_000),
);
const liveSamples = Math.max(
	1,
	Math.min(5, Math.trunc(Number(values["live-samples"]) || 2)),
);
const internalTokenEnv = String(values["internal-token-env"]);
const internalToken =
	process.env[internalTokenEnv] ?? process.env.TEDIX_CMS_INTERNAL_AUTH_TOKEN;
const needsInternalToken = Boolean(values["assert-runtime"]);

const LIVE_TENANT_PROBES = [
	{ tenant: "tedix", url: "https://tedix.cms.tedix.dev/" },
] as const;

function splitServerTiming(header: string | null): string[] {
	if (!header) return [];
	const parts: string[] = [];
	let current = "";
	let quoted = false;
	for (let i = 0; i < header.length; i++) {
		const char = header[i];
		if (char === '"') quoted = !quoted;
		if (char === "," && !quoted) {
			parts.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

function parseServerTiming(header: string | null): Record<string, number> {
	const metrics: Record<string, number> = {};
	for (const entry of splitServerTiming(header)) {
		const [rawName, ...params] = entry.split(";").map((part) => part.trim());
		if (!rawName) continue;
		const dur = params
			.map((param) => param.match(/^dur=(.+)$/)?.[1])
			.find((value): value is string => value !== undefined);
		if (!dur) continue;
		const value = Number(dur.replace(/^"|"$/g, ""));
		if (Number.isFinite(value)) metrics[rawName] = value;
	}
	return metrics;
}

async function fetchWithTimeout(
	url: string,
	timeoutMs: number,
	init: RequestInit = {},
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const headers = new Headers(init.headers);
	headers.set("User-Agent", "tedix-cms-database-architecture-validator/1.0");
	try {
		return await fetch(url, {
			...init,
			headers,
			redirect: "follow",
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}

async function probeLiveTenantSample(
	probe: (typeof LIVE_TENANT_PROBES)[number],
	sample: number,
): Promise<LiveProbeSample> {
	try {
		const response = await fetchWithTimeout(probe.url, liveTimeoutMs);
		const timings = parseServerTiming(response.headers.get("server-timing"));
		const metrics: LiveMetrics = {
			dbCount: timings["db.count"] ?? null,
			rpcCount: timings["rpc.count"] ?? null,
		};
		return {
			finalUrl: response.url,
			metrics,
			ok: response.ok && metrics.dbCount !== null,
			sample,
			status: response.status,
		};
	} catch {
		return {
			finalUrl: probe.url,
			metrics: { dbCount: null, rpcCount: null },
			ok: false,
			sample,
			status: null,
		};
	}
}

function databaseRuntimeResultFromPayload(
	endpoint: string,
	status: number,
	payload: unknown,
): DatabaseRuntimeProbeResult {
	const root =
		payload && typeof payload === "object"
			? (payload as Record<string, unknown>)
			: {};
	const activeBundle =
		root.activeBundle && typeof root.activeBundle === "object"
			? (root.activeBundle as Record<string, unknown>)
			: {};
	const activeBundleDatabaseAdapter =
		activeBundle.databaseAdapter === "d1" ||
		activeBundle.databaseAdapter === "durableObjects" ||
		activeBundle.databaseAdapter === "unknown"
			? activeBundle.databaseAdapter
			: null;
	return {
		activeBundleDatabaseAdapter,
		activeBundleDatabaseAdapterEvidence: Array.isArray(
			activeBundle.databaseAdapterEvidence,
		)
			? activeBundle.databaseAdapterEvidence.filter(
					(item): item is string => typeof item === "string",
				)
			: [],
		activeBundleMainModule:
			typeof activeBundle.mainModule === "string"
				? activeBundle.mainModule
				: null,
		activeBundleModuleCount:
			typeof activeBundle.moduleCount === "number"
				? activeBundle.moduleCount
				: null,
		activeBundleVersion:
			typeof activeBundle.version === "number" ? activeBundle.version : null,
		endpoint,
		ok: root.ok === true && activeBundleDatabaseAdapter === "durableObjects",
		status,
	};
}

function failedDatabaseRuntime(
	endpoint: string,
	error: string,
): DatabaseRuntimeProbeResult {
	return {
		activeBundleDatabaseAdapter: null,
		activeBundleDatabaseAdapterEvidence: [],
		activeBundleMainModule: null,
		activeBundleModuleCount: null,
		activeBundleVersion: null,
		endpoint,
		error,
		ok: false,
		status: null,
	};
}

async function probeDatabaseRuntime(
	probe: (typeof LIVE_TENANT_PROBES)[number],
): Promise<DatabaseRuntimeProbeResult | undefined> {
	if (!needsInternalToken) return undefined;

	const endpoint = new URL(
		"/_tedix/internal/database-runtime",
		probe.url,
	).toString();
	if (!internalToken) {
		return failedDatabaseRuntime(endpoint, `missing ${internalTokenEnv}`);
	}

	try {
		const response = await fetchWithTimeout(endpoint, liveTimeoutMs, {
			headers: { "X-Tedix-CMS-Internal-Auth": internalToken },
		});
		const payload = (await response.json().catch(() => null)) as unknown;
		const result = databaseRuntimeResultFromPayload(
			endpoint,
			response.status,
			payload,
		);
		return response.ok
			? result
			: { ...result, error: `status ${response.status}`, ok: false };
	} catch (error) {
		return failedDatabaseRuntime(
			endpoint,
			error instanceof Error ? error.message : String(error),
		);
	}
}

async function probeLiveTenant(
	probe: (typeof LIVE_TENANT_PROBES)[number],
): Promise<LiveProbeResult> {
	const databaseRuntime = await probeDatabaseRuntime(probe);
	const samples: LiveProbeSample[] = [];
	for (let i = 1; i <= liveSamples; i++) {
		samples.push(await probeLiveTenantSample(probe, i));
	}
	const last = samples.at(-1)!;
	return {
		databaseRuntime,
		finalUrl: last.finalUrl,
		metrics: last.metrics,
		ok: samples.every((sample) => sample.ok),
		samples,
		status: last.status,
		tenant: probe.tenant,
		url: probe.url,
	};
}

const [
	starterAstroConfig,
	templateSnapshot,
	starterWrangler,
	runtimeWorker,
	runtimeSource,
	cmsProxySource,
	cmsDoc,
] = await Promise.all([
	read("apps/cms/templates/tedix/astro.config.mjs"),
	read("apps/cms/src/template-snapshot.ts"),
	read("apps/cms/templates/tedix/wrangler.jsonc"),
	loadCloudflareConfigWorker(
		"apps/cms-runtime/cloudflare.config.ts",
		"production",
	),
	read("apps/cms-runtime/src/index.ts"),
	read("apps/cms/src/agent/cms-proxy-inspection.ts"),
	read("docs/emdash/cms.md"),
]);

const normalizedSnapshot = normalizeEmbeddedSource(templateSnapshot);
const starterAdapter = detectAdapter(starterAstroConfig);
const snapshotAdapter = detectAdapter(normalizedSnapshot);
const starterUsesDurableObjects = hasDurableObjectsContract(starterAstroConfig);
const snapshotUsesDurableObjects =
	hasDurableObjectsContract(normalizedSnapshot);
const durableObjectsEnabled =
	starterAdapter === "durableObjects" || snapshotAdapter === "durableObjects";

// The production Worker hosts EmDashDB as a SQLite export and binds DB_DO to it.
const runtimeDeclaresDurableObject =
	runtimeWorker.exports?.EmDashDB?.type === "durable-object" &&
	runtimeWorker.exports.EmDashDB.storage === "sqlite" &&
	runtimeWorker.env?.DB_DO?.type === "durable-object" &&
	runtimeWorker.env.DB_DO.exportName === "EmDashDB";
const runtimeFlags = runtimeWorker.compatibilityFlags ?? [];
const runtimeUsesDeployableCompatibilityFlags =
	!runtimeFlags.includes("experimental") &&
	!runtimeFlags.includes("replica_routing") &&
	runtimeFlags.includes("nodejs_compat");
const starterDeclaresDurableObject =
	/"durable_objects"\s*:/.test(starterWrangler) &&
	/"new_sqlite_classes"\s*:/.test(starterWrangler);
const runtimeExposesDiagnostic =
	runtimeSource.includes("/_tedix/internal/database-runtime") &&
	runtimeSource.includes("databaseRuntimeAdminResponse") &&
	runtimeSource.includes("detectBundleDatabaseAdapter");
const runtimeSupportsDurableObjects =
	runtimeSource.includes("EmDashDB") &&
	runtimeSource.includes("TenantEmDashDB") &&
	runtimeSource.includes("DB_DO: tenantEmDashDB") &&
	runtimeDeclaresDurableObject &&
	starterDeclaresDurableObject &&
	runtimeUsesDeployableCompatibilityFlags;

const checks: Check[] = [
	{
		name: "starter database adapter",
		ok:
			starterAdapter === "durableObjects" &&
			snapshotAdapter === "durableObjects" &&
			starterUsesDurableObjects &&
			snapshotUsesDurableObjects,
		detail:
			'apps/cms/templates/tedix/astro.config.mjs and apps/cms/src/template-snapshot.ts should use durableObjects({ binding: "DB_DO", name: cmsDatabaseName, session: "auto" }) through the Worker-Loader-safe descriptor.',
	},
	{
		name: "durableObjects activation gate",
		ok: durableObjectsEnabled && runtimeSupportsDurableObjects,
		detail:
			"Emdash durableObjects() must be enabled with cms-runtime and the starter declaring/injecting the serializable EmDashDB RPC stub plus Durable Object bindings and SQLite migrations without production-blocked experimental flags.",
	},
	{
		name: "cms-runtime database diagnostic",
		ok: runtimeExposesDiagnostic,
		detail:
			"apps/cms-runtime/src/index.ts should expose the protected database-runtime diagnostic that reports the active bundle's database adapter.",
	},
	{
		name: "operator overview exposes database runtime",
		ok:
			cmsProxySource.includes("databaseRuntime") &&
			cmsProxySource.includes("cms:database-architecture:validate") &&
			cmsProxySource.includes('currentBackend: "durableObjects"'),
		detail:
			"get_site_overview should tell tedis that Durable Object SQLite is the live CMS database backend and name the validator.",
	},
	{
		name: "docs capture database architecture gate",
		ok:
			cmsDoc.includes("cms:database-architecture:validate") &&
			cmsDoc.includes("cms:database-architecture:validate -- --live --json") &&
			cmsDoc.includes("durableObjects(") &&
			/Durable Object SQLite is the (production )?tenant database/.test(
				cmsDoc,
			) &&
			cmsDoc.includes("/_tedix/internal/database-runtime"),
		detail:
			"docs/emdash/cms.md should record the Durable Object SQLite production backend, the protected database-runtime diagnostic, and source/live validation commands.",
	},
];

const liveResults = values.live
	? await Promise.all(LIVE_TENANT_PROBES.map(probeLiveTenant))
	: [];
const liveRuntimeOk =
	!values.live ||
	!needsInternalToken ||
	liveResults.every((result) => result.databaseRuntime?.ok === true);
const liveOk =
	!values.live || (liveResults.every((result) => result.ok) && liveRuntimeOk);
const ok = checks.every((check) => check.ok) && liveOk;
const result = {
	checks,
	databaseRuntime: {
		durableObjectsEnabled,
		runtimeDeclaresDurableObject,
		runtimeUsesDeployableCompatibilityFlags,
		runtimeSupportsDurableObjects,
		snapshotAdapter,
		snapshotUsesDurableObjects,
		starterAdapter,
		starterDeclaresDurableObject,
		starterUsesDurableObjects,
	},
	live: values.live
		? {
				ok: liveOk,
				runtime: liveRuntimeOk,
				requireRuntime: needsInternalToken,
				samples: liveSamples,
				results: liveResults,
			}
		: undefined,
	ok,
};

if (values.json) {
	console.log(JSON.stringify(result, null, 2));
} else {
	for (const check of checks) {
		console.log(`${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}`);
	}
	console.log(
		`database=${starterAdapter} durableObjectsEnabled=${durableObjectsEnabled} runtimeSupportsDurableObjects=${runtimeSupportsDurableObjects}`,
	);
	for (const probe of liveResults) {
		const samples = probe.samples
			.map(
				(sample) =>
					`#${sample.sample}:${sample.status ?? "ERR"}:${sample.metrics.dbCount ?? "missing"}`,
			)
			.join(" -> ");
		console.log(
			`${probe.ok ? "ok" : "fail"} live ${probe.tenant}: status=${probe.status ?? "ERR"} db.count=${probe.metrics.dbCount ?? "missing"} rpc.count=${probe.metrics.rpcCount ?? "missing"} samples=${samples} final=${probe.finalUrl}`,
		);
		const runtime = probe.databaseRuntime;
		if (runtime) {
			console.log(
				`${runtime.ok ? "ok" : "fail"} database-runtime ${probe.tenant}: activeBundleVersion=${runtime.activeBundleVersion ?? "missing"} activeBundleDatabaseAdapter=${runtime.activeBundleDatabaseAdapter ?? "missing"} mainModule=${runtime.activeBundleMainModule ?? "missing"} moduleCount=${runtime.activeBundleModuleCount ?? "missing"} status=${runtime.status ?? "ERR"} endpoint=${runtime.endpoint}${runtime.error ? ` error=${runtime.error}` : ""}`,
			);
		}
	}
}

if (!ok) process.exit(1);
