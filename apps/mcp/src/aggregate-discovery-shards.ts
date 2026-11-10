/**
 * Compact discovery shards for Connect's multi-organization catalog.
 *
 * Each selected organization's graph serializes to megabytes of snapshot, and
 * the whole selection to ~25 MB. Parsing those graphs in a request isolate so
 * that `discover.search` can rank names and descriptions crossed the 128 MB
 * isolate limit (Cloudflare 1102 on 26-27 Oct and 5 Nov 2026).
 *
 * Whenever a request builds an organization mount from a fresh (activation-
 * epoch fenced) graph, it also writes that mount's rows to R2 without input
 * or output schemas, templates or icons: everything discovery ranks and
 * authorizes, nothing it only needs to describe or execute a tool. A program
 * always reads these shards instead of the organization graphs. Describe,
 * execution and schema-bearing search fetch individual source rows after
 * pagination. Shard rows carry `_discoveryShard`; dispatch replaces them with
 * current definitions before authorization and execution.
 *
 * A schema sync rolls the activation epoch, which changes every shard key.
 * Missing shards are rebuilt one organization at a time in waitUntil. Connect
 * returns a retryable error until its prebuilt index is available.
 *
 * Shards of one selection are written together, so they age together. A shard
 * past its refresh age is still served (its epoch key fences tool contracts)
 * and the request names one organization to hydrate in the background, which
 * rewrites that shard. Hydrating every organization at once when all shards
 * expired crossed the memory limit on 6-7 Nov 2026.
 */
import type {
	AggregateAppEntry,
	AggregatedMcpSurface,
	InternalAppTool,
} from "./aggregate-types";
import {
	DISCOVERY_SHARD_PREFIX,
	aggregateSurfaceCacheKey,
} from "./aggregate-surface-cache";
import { pruneExpiredCacheEntries } from "./lib/bounded-cache";
import { hashAggregateCacheKey } from "./lib/cache-key-hash";
import {
	CACHE_TIER_BUDGET_MS,
	StepBudgetExceededError,
	withStepBudget,
} from "./lib/step-budget";
import { contentFreeMcpException, createMcpLogger } from "./log";
import type { getApiClient } from "./lib/api-client";
import { filterAggregateAppsForCodeNamespaces } from "./codemode-targeting";

const log = createMcpLogger("mcp.router");

const DISCOVERY_SHARD_FORMAT = "discovery-shard-v2";
/** Past this age a shard is served and one organization is refreshed. */
export const DISCOVERY_SHARD_STALE_AFTER_MS = 3_600_000;
const DISCOVERY_SHARD_L1_TTL_MS = 120_000;
/** An unchanged graph seen by another isolate does not rewrite its shard. */
const DISCOVERY_SHARD_REFRESH_MS = 600_000;
const MAX_DISCOVERY_SHARD_L1_ENTRIES = 64;
const EMPTY_INPUT_SCHEMA = { type: "object" } as const;

type DiscoveryShard = {
	tools: InternalAppTool[];
	toolScopes: Record<string, string[]>;
};

/** Parsed shards per R2 key; rows are shared so catalog projections are reused. */
export const discoveryShardCache = new Map<
	string,
	DiscoveryShard & { builtAt: number; expiresAt: number }
>();
/** Shard keys whose organization this isolate is already refreshing. */
export const discoveryShardRefreshInFlight = new Set<string>();
/** Organization graphs this isolate already compiled, per shard key. */
const compiledShardSources = new WeakMap<object, string>();

export function discoveryShardR2Key(
	entry: AggregateAppEntry,
	activationEpoch: string,
): string {
	const { projection: _projection, ...mount } = entry;
	return `${DISCOVERY_SHARD_PREFIX}${hashAggregateCacheKey(
		aggregateSurfaceCacheKey([mount], DISCOVERY_SHARD_FORMAT, activationEpoch),
	)}`;
}

export function isDiscoveryShardTool(config: object | null | undefined) {
	return (
		(config as { _discoveryShard?: unknown } | null)?._discoveryShard === true
	);
}

/** Fetch one definition under its verified organization, never its graph. */
export async function loadDiscoveryToolDefinition(
	tool: InternalAppTool,
	entries: AggregateAppEntry[],
	client: Pick<ReturnType<typeof getApiClient>, "apps">,
): Promise<InternalAppTool> {
	const organizationId = tool.config?._multiOrgOrganizationId;
	const mounts = entries.filter(
		(entry) =>
			entry.organizationMount && entry.organizationId === organizationId,
	);
	if (typeof organizationId !== "string" || mounts.length !== 1) {
		throw new Error("Discovery schema has no unique organization mount");
	}
	const sourceAppId = tool.config?._sourceAppId;
	const sourceAppSlug = tool.config?._sourceAppSlug;
	const sourceToolId = tool.config?._discoverySourceToolId;
	if (
		typeof sourceAppId !== "string" ||
		typeof sourceAppSlug !== "string" ||
		typeof sourceToolId !== "string"
	) {
		throw new Error("Discovery schema has no source identity; search again");
	}
	const { results } = await client.apps.getBySlugsWithTools({
		apps: [
			{
				slug: sourceAppSlug,
				appId: sourceAppId,
				hostOrganizationId: organizationId,
				toolIds: [sourceToolId],
			},
		],
	});
	const full = results[0]?.tools.find(
		(row) => row.id === tool.id && row.toolId === sourceToolId,
	);
	if (!full || full.enabled === false || results[0]?.app?.id !== sourceAppId) {
		throw new Error("Discovery schema is unavailable; search again");
	}
	const { _discoveryShard, _discoverySourceToolId, ...mountConfig } =
		tool.config ?? {};
	// Only mount-owned routing survives the index. Execution uses the fresh
	// source configuration; indexed endpoint/payment hints never override it.
	const overrides = Object.fromEntries(
		Object.entries(mountConfig).filter(
			([key]) =>
				key.startsWith("_aggregate") ||
				key.startsWith("_source") ||
				key === "_multiOrgOrganizationId" ||
				key === "_forwardedQueryParams" ||
				key === "auth",
		),
	);
	return {
		...full,
		toolId: tool.toolId,
		title: tool.title,
		config: { ...full.config, ...overrides },
	} as InternalAppTool;
}

function compactTool(tool: InternalAppTool): InternalAppTool {
	const config = Object.fromEntries(
		Object.entries(tool.config ?? {}).filter(
			([key]) =>
				key.startsWith("_aggregate") ||
				key.startsWith("_source") ||
				[
					"_multiOrgOrganizationId",
					"_forwardedQueryParams",
					"auth",
					"transport",
					"endpoint",
					"method",
					"mcpToolName",
					"nativeDirect",
					"payment",
					"x-tedix/payment",
				].includes(key),
		),
	);
	const prefix = tool.config?._aggregateNamespace;
	const sourceToolId =
		typeof prefix === "string" && tool.toolId.startsWith(`${prefix}__`)
			? tool.toolId.slice(prefix.length + 2)
			: tool.toolId;
	return {
		...tool,
		inputSchema: EMPTY_INPUT_SCHEMA as InternalAppTool["inputSchema"],
		outputSchema: null,
		outputTemplate: null,
		icons: null,
		meta: Object.fromEntries(
			Object.entries(tool.meta ?? {}).filter(([key]) =>
				["source", "com.tedix/policy", "x-tedix/payment"].includes(key),
			),
		),
		toolCspDomains: undefined,
		config: {
			...config,
			_discoveryShard: true,
			_discoverySourceToolId: sourceToolId,
		},
	};
}

/** One shard serialization at a time per isolate, after the response. */
let shardWrites: Promise<void> = Promise.resolve();

/**
 * Queues one organization mount's shard unless this isolate already queued it
 * from the same graph object (L1 keeps that object while it is unchanged).
 * The write runs after the response, one mount at a time, and is skipped when
 * another isolate wrote this shard recently: a cold isolate already holds
 * every organization graph, and serializing all of them at once beside those
 * graphs crossed the memory limit on the first deploy (5 Nov 2026).
 */
export function compileDiscoveryShard(
	env: CloudflareEnv,
	entry: AggregateAppEntry,
	activationEpoch: string,
	source: object,
	shard: DiscoveryShard,
	ctx?: Pick<ExecutionContext, "waitUntil">,
): void {
	if (!("AGGREGATE_CACHE" in env) || !env.AGGREGATE_CACHE) return;
	const bucket = env.AGGREGATE_CACHE;
	const key = discoveryShardR2Key(entry, activationEpoch);
	if (compiledShardSources.get(source) === key) return;
	compiledShardSources.set(source, key);
	const write = async () => {
		const existing = await bucket.head(key);
		const writtenAt = Number(existing?.customMetadata?.builtAt);
		if (Date.now() - writtenAt < DISCOVERY_SHARD_REFRESH_MS) return;
		const builtAt = Date.now();
		const body = JSON.stringify({
			tools: shard.tools.map(compactTool),
			toolScopes: shard.toolScopes,
		});
		await bucket.put(key, body, {
			httpMetadata: { contentType: "application/json" },
			customMetadata: { builtAt: String(builtAt) },
		});
		console.log(
			JSON.stringify({
				_cm: "aggregate",
				event: "discovery_shard_compiled",
				toolCount: shard.tools.length,
				bytes: body.length,
			}),
		);
	};
	const run = shardWrites.then(write).catch((error: unknown) => {
		compiledShardSources.delete(source);
		log.warn("Discovery shard write failed", {
			event: "aggregate.discovery_shard_write_failed",
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});
	});
	shardWrites = run;
	ctx?.waitUntil(run);
}

async function readDiscoveryShard(env: CloudflareEnv, key: string) {
	const now = Date.now();
	const cached = discoveryShardCache.get(key);
	if (cached && cached.expiresAt > now) return cached;
	if (!("AGGREGATE_CACHE" in env) || !env.AGGREGATE_CACHE) return null;
	const bucket = env.AGGREGATE_CACHE;
	const object = await bucket.get(key);
	if (!object) return null;
	const builtAt = Number(object.customMetadata?.builtAt);
	if (cached?.builtAt === builtAt) {
		await object.body?.cancel();
		cached.expiresAt = now + DISCOVERY_SHARD_L1_TTL_MS;
		return cached;
	}
	const shard = (await object.json()) as DiscoveryShard;
	if (!Array.isArray(shard?.tools)) return null;
	// Expired entries stay reusable for one more L1 window (same builtAt skips
	// the parse above); beyond that they only hold heap.
	pruneExpiredCacheEntries(
		discoveryShardCache,
		now - DISCOVERY_SHARD_L1_TTL_MS,
	);
	for (const key of discoveryShardCache.keys()) {
		if (discoveryShardCache.size < MAX_DISCOVERY_SHARD_L1_ENTRIES) break;
		discoveryShardCache.delete(key);
	}
	discoveryShardCache.set(key, {
		tools: shard.tools,
		toolScopes: shard.toolScopes ?? {},
		builtAt,
		expiresAt: now + DISCOVERY_SHARD_L1_TTL_MS,
	});
	return discoveryShardCache.get(key)!;
}

/**
 * Splits a Connect selection for a namespace-free discovery program: the
 * organization mounts serving `namespaces` are hydrated in full; every other
 * mount contributes its shard rows. When supplied, hydrateShard builds missing
 * shards sequentially, compacting each graph before loading the next. The
 * oldest shard past its refresh age is still served and
 * returned as `refresh`, for the caller to hydrate after the response (one
 * organization per request, one per isolate at a time). Unreadable shards
 * return null. Connect treats this as a retryable index miss, never permission
 * to load the full catalog. Small catalogs use the same index path.
 */
export async function loadDiscoveryShards(
	env: CloudflareEnv,
	entries: AggregateAppEntry[],
	namespaces: Set<string>,
	activationEpoch: string,
	hydrateShard?: (entry: AggregateAppEntry) => Promise<AggregatedMcpSurface>,
): Promise<{
	hydrate: AggregateAppEntry[];
	refresh?: AggregateAppEntry;
	tools: InternalAppTool[];
	toolScopes: Record<string, string[]>;
	degraded?: boolean;
} | null> {
	const hydrate =
		namespaces.size > 0
			? filterAggregateAppsForCodeNamespaces(entries, namespaces)
			: [];
	const sharded = entries.filter((entry) => !hydrate.includes(entry));
	if (sharded.length === 0 || sharded.some((entry) => !entry.organizationMount))
		return null;
	let shards: Array<(DiscoveryShard & { builtAt: number }) | null>;
	try {
		shards = await withStepBudget(
			"aggregate_discovery_shard_read",
			CACHE_TIER_BUDGET_MS,
			Promise.all(
				sharded.map((entry) =>
					readDiscoveryShard(env, discoveryShardR2Key(entry, activationEpoch)),
				),
			),
		);
	} catch (error) {
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("Discovery shard read failed", {
				event: "aggregate.discovery_shard_read_failed",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
		if (!hydrateShard) return null;
		shards = sharded.map(() => null);
	}
	// A cold epoch can miss every shard. Release each full graph before
	// loading the next instead of retaining all missing graphs in the root.
	let degraded = false;
	const missingCount = shards.filter((shard) => shard === null).length;
	if (hydrateShard) {
		for (let index = 0; index < shards.length; index++) {
			if (shards[index]) continue;
			const surface = await hydrateShard(sharded[index]!);
			shards[index] = {
				tools: surface.tools.map(compactTool),
				toolScopes: surface.toolScopes ?? {},
				builtAt: Date.now(),
			};
			degraded ||= surface.degraded === true;
			// Shard compilation queued by hydration also holds the full graph.
			await shardWrites;
		}
	}
	const present = shards.filter((shard) => shard !== null);
	const tools = present.flatMap((shard) => shard.tools);
	const staleBefore = Date.now() - DISCOVERY_SHARD_STALE_AFTER_MS;
	let refresh: { entry: AggregateAppEntry; builtAt: number } | undefined;
	shards.forEach((shard, index) => {
		if (!shard || shard.builtAt > staleBefore) return;
		if (refresh && refresh.builtAt <= shard.builtAt) return;
		const entry = sharded[index]!;
		if (
			discoveryShardRefreshInFlight.has(
				discoveryShardR2Key(entry, activationEpoch),
			)
		)
			return;
		refresh = { entry, builtAt: shard.builtAt };
	});
	console.log(
		JSON.stringify({
			_cm: "aggregate",
			event: missingCount ? "discovery_shard_partial" : "discovery_shard_hit",
			shardCount: shards.length - missingCount,
			missingCount,
			rebuiltCount: hydrateShard ? missingCount : 0,
			hydratedCount: hydrate.length,
			toolCount: tools.length,
			...(refresh ? { refreshSlug: refresh.entry.slug } : {}),
		}),
	);
	return {
		hydrate: [
			...hydrate,
			...sharded.filter((_, index) => shards[index] === null),
		],
		...(refresh ? { refresh: refresh.entry } : {}),
		tools,
		degraded,
		toolScopes: Object.assign({}, ...present.map((shard) => shard.toolScopes)),
	};
}

/**
 * Hydrates one organization after the response so its stale shard is rewritten
 * (`compileDiscoveryShard` runs inside the uncached build). One refresh per
 * shard key per isolate; a failure only leaves the stale shard in place.
 */
let shardRefreshes: Promise<unknown> = Promise.resolve();

export function refreshDiscoveryShard(
	entry: AggregateAppEntry,
	activationEpoch: string,
	hydrate: () => Promise<unknown>,
	ctx?: Pick<ExecutionContext, "waitUntil">,
): void {
	const key = discoveryShardR2Key(entry, activationEpoch);
	if (discoveryShardRefreshInFlight.has(key)) return;
	discoveryShardRefreshInFlight.add(key);
	const run = shardRefreshes
		.then(hydrate)
		.catch((error: unknown) => {
			log.warn("Discovery shard refresh failed", {
				event: "aggregate.discovery_shard_refresh_failed",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		})
		.finally(() => {
			discoveryShardRefreshInFlight.delete(key);
		});
	shardRefreshes = run;
	if (ctx) ctx.waitUntil(run);
}
