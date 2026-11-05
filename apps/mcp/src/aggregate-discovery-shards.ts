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
 * that searches without naming a namespace then reads these shards instead of
 * the organization graphs, and fully hydrates only the namespaces it calls or
 * describes by literal name. Shard rows carry `_discoveryShard` and are never
 * executed (`ToolHandler.execute` refuses them).
 *
 * A schema sync rolls the activation epoch, which changes every shard key, so
 * the first full load after a sync compiles the new shards and discovery falls
 * back to the full catalog until then.
 */
import type { AggregateAppEntry, InternalAppTool } from "./aggregate-types";
import {
	DISCOVERY_SHARD_PREFIX,
	aggregateSurfaceCacheKey,
} from "./aggregate-surface-cache";
import { hashAggregateCacheKey } from "./lib/cache-key-hash";
import {
	CACHE_TIER_BUDGET_MS,
	StepBudgetExceededError,
	withStepBudget,
} from "./lib/step-budget";
import { contentFreeMcpException, createMcpLogger } from "./log";
import { CATALOG_SCHEMA_SEARCH_MAX_ROWS } from "./mcp/codemode-discovery";
import { filterAggregateAppsForCodeNamespaces } from "./codemode-targeting";

const log = createMcpLogger("mcp.router");

const DISCOVERY_SHARD_FORMAT = "discovery-shard-v1";
/** Same serve-stale ceiling as the R2 aggregate snapshot. */
const DISCOVERY_SHARD_HARD_TTL_MS = 3_600_000;
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
/** Organization graphs this isolate already compiled, per shard key. */
const compiledShardSources = new WeakMap<object, string>();

export function discoveryShardR2Key(
	entry: AggregateAppEntry,
	activationEpoch: string,
): string {
	return `${DISCOVERY_SHARD_PREFIX}${hashAggregateCacheKey(
		aggregateSurfaceCacheKey([entry], DISCOVERY_SHARD_FORMAT, activationEpoch),
	)}`;
}

export function isDiscoveryShardTool(config: object | null | undefined) {
	return (
		(config as { _discoveryShard?: unknown } | null)?._discoveryShard === true
	);
}

function compactTool(tool: InternalAppTool): InternalAppTool {
	return {
		...tool,
		inputSchema: EMPTY_INPUT_SCHEMA as InternalAppTool["inputSchema"],
		outputSchema: null,
		outputTemplate: null,
		icons: null,
		toolCspDomains: undefined,
		config: { ...tool.config, _discoveryShard: true },
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

async function readDiscoveryShard(
	env: CloudflareEnv,
	key: string,
): Promise<DiscoveryShard | null> {
	const now = Date.now();
	const cached = discoveryShardCache.get(key);
	if (cached && cached.expiresAt > now) return cached;
	if (!("AGGREGATE_CACHE" in env) || !env.AGGREGATE_CACHE) return null;
	const bucket = env.AGGREGATE_CACHE;
	const object = await bucket.get(key);
	if (!object) return null;
	const builtAt = Number(object.customMetadata?.builtAt);
	if (
		!Number.isFinite(builtAt) ||
		now - builtAt > DISCOVERY_SHARD_HARD_TTL_MS
	) {
		await object.body?.cancel();
		return null;
	}
	if (cached?.builtAt === builtAt) {
		await object.body?.cancel();
		cached.expiresAt = now + DISCOVERY_SHARD_L1_TTL_MS;
		return cached;
	}
	const shard = (await object.json()) as DiscoveryShard;
	if (!Array.isArray(shard?.tools)) return null;
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
 * mount contributes its shard rows, and a mount whose shard is missing or
 * expired is hydrated too. Returns null (load the full catalog) when shards
 * are unreadable, or when the shard rows are few enough that discovery would
 * still match parameter names (`CATALOG_SCHEMA_SEARCH_MAX_ROWS`), so ranking
 * is unchanged either way.
 */
export async function loadDiscoveryShards(
	env: CloudflareEnv,
	entries: AggregateAppEntry[],
	namespaces: Set<string>,
	activationEpoch: string,
): Promise<{
	hydrate: AggregateAppEntry[];
	tools: InternalAppTool[];
	toolScopes: Record<string, string[]>;
} | null> {
	const hydrate =
		namespaces.size > 0
			? filterAggregateAppsForCodeNamespaces(entries, namespaces)
			: [];
	const sharded = entries.filter((entry) => !hydrate.includes(entry));
	if (sharded.length === 0 || sharded.some((entry) => !entry.organizationMount))
		return null;
	try {
		const shards = await withStepBudget(
			"aggregate_discovery_shard_read",
			CACHE_TIER_BUDGET_MS,
			Promise.all(
				sharded.map((entry) =>
					readDiscoveryShard(env, discoveryShardR2Key(entry, activationEpoch)),
				),
			),
		);
		// A mount without a shard is hydrated in full, which compiles its shard,
		// so coverage fills in one organization at a time.
		const present = shards.filter((shard) => shard !== null);
		const tools = present.flatMap((shard) => shard.tools);
		console.log(
			JSON.stringify({
				_cm: "aggregate",
				event:
					present.length === shards.length
						? "discovery_shard_hit"
						: "discovery_shard_partial",
				shardCount: present.length,
				missingCount: shards.length - present.length,
				hydratedCount: hydrate.length,
				toolCount: tools.length,
			}),
		);
		if (tools.length <= CATALOG_SCHEMA_SEARCH_MAX_ROWS) return null;
		return {
			hydrate: [
				...hydrate,
				...sharded.filter((_, index) => shards[index] === null),
			],
			tools,
			toolScopes: Object.assign(
				{},
				...present.map((shard) => shard.toolScopes),
			),
		};
	} catch (error) {
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("Discovery shard read failed", {
				event: "aggregate.discovery_shard_read_failed",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
		return null;
	}
}
