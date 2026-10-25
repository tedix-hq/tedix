import type {
	AggregateAppEntry,
	AggregatedMcpSurface,
	InternalAppTool,
} from "./aggregate-types";
import { readAggregateActivationEpoch } from "./aggregate-activation-epoch";
import { withAggregateConnectionProvider } from "./aggregate-host-defaults";
import {
	isAggregateSourceVisited,
	resolveUpstreamToolsInternally,
} from "./aggregate-internal-tools";
import { prefetchAggregateEntries } from "./aggregate-prefetch";
import {
	aggregateSurfaceCache,
	aggregateSurfaceInFlight,
	aggregateRevalidateInFlight,
	aggregateSurfaceCacheKey,
	rememberAggregateSurface,
	readAggregateL2,
	writeAggregateL2,
	readAggregateR2,
	writeAggregateR2,
	emitAggregateCacheMetric,
	joinAggregateLoad,
} from "./aggregate-surface-cache";
import { pruneExpiredCacheEntries } from "./lib/bounded-cache";
import { StepBudgetExceededError, trackInFlightLoad } from "./lib/step-budget";
import { contentFreeMcpException, createMcpLogger } from "./log";
import {
	mountedAppToolScopes,
	organizationAppNamespace,
	organizationMountToolScopes,
} from "./mcp/aggregate-namespaces";
import { ensurePlatformOperatorAggregateApps } from "./mcp/platform-operator-aggregation";

const log = createMcpLogger("mcp.router");

// Degrade-on-flap: cap how long a single aggregate app's upstream resolution may
// hold the whole surface. A healthy cold init resolves every app in a few
// seconds (slowest ~4.5s, see `_cm:"aggregate"` logs); under the documented
// remote-binding flap a stuck app quantizes at n×~48s and would otherwise block
// the entire `Promise.all`. When an entry exceeds this, it is dropped as a
// degraded partial (surface returns with the healthy apps + `degraded:true`)
// instead of stalling discovery to the ~100s edge 524.
const AGGREGATE_ENTRY_TIMEOUT_MS = 12_000;
const AGGREGATE_LOAD_WEDGE_EVICT_MS = 45_000;

// Background rebuild after a stale L2/L3 serve; refreshes L1 + L2 + L3. Single-
// flight per key; failures are swallowed (the stale entry remains until hard TTL).
async function revalidateAggregate(
	cacheKey: string,
	entries: AggregateAppEntry[],
	env: CloudflareEnv,
	activationEpoch: string,
	rootSlug?: string,
	visited: Set<string> = new Set(),
	ctx?: ExecutionContext,
): Promise<void> {
	if (aggregateRevalidateInFlight.has(cacheKey)) return;
	aggregateRevalidateInFlight.add(cacheKey);
	try {
		const fresh = await aggregateAndPrefixToolsUncached(
			entries,
			env,
			visited,
			"revalidate",
			rootSlug,
			activationEpoch,
			true,
			ctx,
		);
		if (!fresh.degraded) {
			rememberAggregateSurface(cacheKey, fresh, visited);
			await writeAggregateL2(cacheKey, fresh);
			await writeAggregateR2(env, cacheKey, fresh, rootSlug);
			console.log(JSON.stringify({ _cm: "aggregate", event: "revalidated" }));
			emitAggregateCacheMetric(env, {
				cacheEvent: "revalidated",
				appSlug: rootSlug,
				toolCount: fresh.tools.length,
			});
		}
	} catch (error) {
		log.warn("Aggregate background revalidation failed", {
			event: "aggregate.revalidation_failed",
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});
	} finally {
		aggregateRevalidateInFlight.delete(cacheKey);
	}
}

export async function aggregateAndPrefixTools(
	entries: AggregateAppEntry[],
	env: CloudflareEnv,
	visited: Set<string> = new Set(),
	ctx?: ExecutionContext,
	// Root app slug (e.g. "tedix-unified") for cache-effectiveness telemetry, so
	// ae rows attribute hits/misses to a specific surface instead of inferring
	// from appCount.
	rootSlug?: string,
	activation?: { value: string; cacheable: boolean },
	cacheSnapshot = true,
): Promise<AggregatedMcpSurface> {
	// A deploy must never reuse a durable aggregate snapshot built from an older
	// tool contract. The original intent was "GIT_SHA is injected by the release
	// workflow" — it never was: the deployed var is the literal wrangler value
	// ("production"), so L2/R2 keys never rolled and a redeploy kept serving
	// snapshots with pre-deploy tool schemas (see `docs/engineering/mcp/runtime.md`).
	// `version_metadata` cannot drift the same way — the runtime stamps a fresh
	// id on every deploy, no CI cooperation required. GIT_SHA stays as the
	// fallback for local dev/tests.
	const activationState =
		activation ?? (await readAggregateActivationEpoch(env));
	const activationEpoch = activationState.value;
	const cacheKey = aggregateSurfaceCacheKey(
		entries,
		env.WORKER_VERSION?.id ?? env.GIT_SHA,
		activationEpoch,
		visited,
	);
	if (!activationState.cacheable) {
		return aggregateAndPrefixToolsUncached(
			entries,
			env,
			visited,
			"cold",
			rootSlug,
			activationEpoch,
			false,
			ctx,
		);
	}
	pruneExpiredCacheEntries(aggregateSurfaceCache);
	// Consent-composed roots duplicate shared schemas across organizations when
	// serialized. Keep source-app caches and in-flight sharing, but do not retain
	// or deserialize the combined catalog in any snapshot tier.
	const cached =
		cacheSnapshot && visited.size === 0
			? aggregateSurfaceCache.get(cacheKey)
			: undefined;
	if (cached && cached.expiresAt > Date.now()) return cached.result;

	const inFlight = aggregateSurfaceInFlight.get(cacheKey);
	if (inFlight) {
		return joinAggregateLoad(
			inFlight,
			cacheKey,
			env,
			rootSlug,
			"joined",
			undefined,
			cacheSnapshot,
		);
	}

	const loadPromise = (async () => {
		// L2 (durable, cross-isolate) before the expensive live rebuild.
		const l2 = cacheSnapshot ? await readAggregateL2(cacheKey) : null;
		if (l2) {
			rememberAggregateSurface(cacheKey, l2.surface, visited);
			if (l2.stale) {
				// Stale-while-revalidate: serve now, refresh in the background.
				console.log(
					JSON.stringify({ _cm: "aggregate", event: "l2_stale_revalidate" }),
				);
				emitAggregateCacheMetric(env, {
					cacheEvent: "l2_stale_revalidate",
					appSlug: rootSlug,
				});
				const job = revalidateAggregate(
					cacheKey,
					entries,
					env,
					activationEpoch,
					rootSlug,
					visited,
					ctx,
				);
				if (ctx) ctx.waitUntil(job);
				else void job.catch(() => {});
			} else {
				console.log(JSON.stringify({ _cm: "aggregate", event: "l2_hit" }));
				emitAggregateCacheMetric(env, {
					cacheEvent: "l2_hit",
					appSlug: rootSlug,
				});
			}
			return l2.surface;
		}
		// L3 (durable, global across colos) before the expensive live rebuild.
		const l3 = cacheSnapshot ? await readAggregateR2(env, cacheKey) : null;
		if (l3) {
			rememberAggregateSurface(cacheKey, l3.surface, visited);
			// Promote R2 → this colo's L2 so subsequent local reads stay warm.
			await writeAggregateL2(cacheKey, l3.surface);
			if (l3.stale) {
				console.log(
					JSON.stringify({ _cm: "aggregate", event: "r2_stale_revalidate" }),
				);
				emitAggregateCacheMetric(env, {
					cacheEvent: "r2_stale_revalidate",
					appSlug: rootSlug,
				});
				const job = revalidateAggregate(
					cacheKey,
					entries,
					env,
					activationEpoch,
					rootSlug,
					visited,
					ctx,
				);
				if (ctx) ctx.waitUntil(job);
				else void job.catch(() => {});
			} else {
				console.log(JSON.stringify({ _cm: "aggregate", event: "r2_hit" }));
				emitAggregateCacheMetric(env, {
					cacheEvent: "r2_hit",
					appSlug: rootSlug,
				});
			}
			return l3.surface;
		}
		const result = await aggregateAndPrefixToolsUncached(
			entries,
			env,
			visited,
			"cold",
			rootSlug,
			activationEpoch,
			true,
			ctx,
		);
		if (!cacheSnapshot) return result;
		if (!result.degraded) {
			rememberAggregateSurface(cacheKey, result, visited);
			await writeAggregateL2(cacheKey, result);
			await writeAggregateR2(env, cacheKey, result, rootSlug);
			return result;
		}
		// Stale-beats-degraded: a degraded cold rebuild (upstream entries dropped —
		// typically the API service binding mid-deploy) silently served a toy
		// surface, so Code Mode namespaces "disappeared" ("skills is not defined").
		// Prefer any previously-known full surface from R2, however old, and let a
		// background revalidate replace it once upstreams recover. The degraded
		// build is served only when no full surface has ever been cached.
		const expired = await readAggregateR2(env, cacheKey, {
			allowExpired: true,
		});
		if (expired) {
			console.warn(
				JSON.stringify({
					_cm: "aggregate",
					event: "degraded_stale_fallback",
					degradedToolCount: result.tools.length,
					staleToolCount: expired.surface.tools.length,
				}),
			);
			emitAggregateCacheMetric(env, {
				cacheEvent: "degraded_stale_fallback",
				appSlug: rootSlug,
				toolCount: expired.surface.tools.length,
			});
			rememberAggregateSurface(cacheKey, expired.surface, visited);
			const job = revalidateAggregate(
				cacheKey,
				entries,
				env,
				activationEpoch,
				rootSlug,
				visited,
				ctx,
			);
			if (ctx) ctx.waitUntil(job);
			else void job.catch(() => {});
			return expired.surface;
		}
		return result;
	})();

	// Wedge eviction: if the load somehow never settles despite every await
	// inside it being budgeted, drop it from the dedupe map so the next request
	// rebuilds fresh instead of joining a poisoned promise.
	trackInFlightLoad(aggregateSurfaceInFlight, cacheKey, loadPromise, {
		step: "aggregate_surface_in_flight",
		wedgeEvictMs: AGGREGATE_LOAD_WEDGE_EVICT_MS,
		resource: rootSlug,
	});
	return joinAggregateLoad(
		loadPromise,
		cacheKey,
		env,
		rootSlug,
		"cold",
		undefined,
		cacheSnapshot,
	);
}

async function aggregateAndPrefixToolsUncached(
	entries: AggregateAppEntry[],
	env: CloudflareEnv,
	visited: Set<string> = new Set(),
	// "cold" = a real cold miss (L1+L2+L3 all missed); "revalidate" = a background
	// SWR refresh (which emits its own `revalidated` metric). Only "cold" emits the
	// `cold_rebuild` metric, so the cold-miss rate isn't inflated by revalidations.
	reason: "cold" | "revalidate" = "cold",
	rootSlug?: string,
	activationEpoch = "direct",
	cacheable = true,
	ctx?: ExecutionContext,
): Promise<AggregatedMcpSurface> {
	// Per-stage timing: aggregate hydration is the dominant Code Mode cold-start
	// cost (live D1/service-binding fan-out across the aggregate apps). Time each
	// upstream resolution and emit a `_cm:"aggregate"` summary at the top level so
	// slow cold inits are diagnosable from logs without guesswork (pairs with the
	// existing `_cm:"rpc"`/`_cm:"exec"` lines). Only the top frame (visited.size
	// === 0) logs; nested recursion contributes timings but stays quiet.
	const aggregateStart = Date.now();
	// one upstream call per 20 apps instead of one per app. Everything below is
	// unchanged and still correct if this seeds nothing.
	if (cacheable) {
		await prefetchAggregateEntries(
			entries,
			env,
			visited,
			activationEpoch,
			cacheable,
		);
	}
	const entryTimings: Array<{ slug: string; resolveMs: number }> = [];
	const results = await Promise.all(
		entries.map(async (entry) => {
			// Cycle guard: skip if this source is already on the resolution stack.
			if (isAggregateSourceVisited(visited, entry)) {
				console.warn(
					`[aggregate] Cycle detected: ${entry.appId ?? entry.slug} already in [${[...visited].join(", ")}], skipping`,
				);
				return { tools: [], resources: [], resourceTemplates: [], prompts: [] };
			}
			const resolveStart = Date.now();
			// Soft per-entry timeout: race the upstream resolve against a deadline
			// that yields `null`. A timed-out (flapping) app is dropped as a degraded
			// partial via the existing resolutionFailed path below, so it cannot hold
			// the whole `Promise.all` open.
			let entryTimer: ReturnType<typeof setTimeout> | undefined;
			const resolved = await Promise.race([
				resolveUpstreamToolsInternally(
					entry,
					env,
					{
						endpointPrefixes: entry.endpointPrefixes,
						toolIds: entry.toolIds,
					},
					activationEpoch,
					cacheable,
				).catch((error: unknown) => {
					// Joiners time out before the owner's resolve budget. Degrade this
					// entry just like the soft deadline instead of aborting discovery.
					if (error instanceof StepBudgetExceededError) return null;
					throw error;
				}),
				new Promise<null>((resolveTimeout) => {
					entryTimer = setTimeout(() => {
						console.warn(
							JSON.stringify({
								_cm: "aggregate",
								event: "entry_timeout",
								slug: entry.slug,
								timeoutMs: AGGREGATE_ENTRY_TIMEOUT_MS,
							}),
						);
						emitAggregateCacheMetric(env, {
							cacheEvent: "entry_timeout",
							appSlug: rootSlug,
							slug: entry.slug,
							totalMs: AGGREGATE_ENTRY_TIMEOUT_MS,
						});
						resolveTimeout(null);
					}, AGGREGATE_ENTRY_TIMEOUT_MS);
				}),
			]);
			if (entryTimer) clearTimeout(entryTimer);
			entryTimings.push({
				slug: entry.slug,
				resolveMs: Date.now() - resolveStart,
			});
			if (!resolved) {
				return {
					tools: [],
					resources: [],
					resourceTemplates: [],
					prompts: [],
					degraded: true,
				};
			}
			const {
				tools,
				appId: sourceAppId,
				appSlug: resolvedAppSlug,
				organizationId: sourceOrganizationId,
				upstreamMcpUrl,
				aggregateApps: nestedAggregateApps,
				connectionLabel: appConnectionLabel,
				connectionInstanceId: appConnectionInstanceId,
				connectionProviderId: appConnectionProviderId,
				connectionScope: appConnectionScope,
				connectionScopes: appConnectionScopes,
				catalogResources: appCatalogResources,
				catalogResourceTemplates: appCatalogResourceTemplates,
				catalogPrompts: appCatalogPrompts,
				forwardedQueryParams: appForwardedQueryParams,
				resolutionFailed,
				toolScopes: appToolScopes,
			} = resolved;
			if (resolutionFailed) {
				return {
					tools: [],
					resources: [],
					resourceTemplates: [],
					prompts: [],
					degraded: true,
				};
			}
			const prefix = entry.prefix ?? entry.slug;
			const forwardedQueryParams =
				entry.forwardedQueryParams ?? appForwardedQueryParams ?? undefined;

			// A tool with no recorded write capability is withheld, not exposed:
			// the rule only ever admits what is positively known to be a read.
			const mountable = entry.readOnly
				? tools.filter((tool) => tool.writeCapability === "read")
				: tools;
			// The source app's current slug. An id-linked entry may still store the
			// slug the app had when it was linked.
			const sourceSlug = resolvedAppSlug ?? entry.slug;
			// Nested entries live in this source app's `aggregateApps`, so its
			// organization is their host for the id ownership rule. Without a
			// resolved organization an id-linked nested entry resolves to nothing.
			const nestedHostOrganizationId = sourceOrganizationId ?? undefined;
			const nestedEntries = ensurePlatformOperatorAggregateApps(
				sourceSlug,
				nestedAggregateApps ?? [],
			).map((sub) => {
				const providerId =
					entry.connectionProviderId ??
					sub.connectionProviderId ??
					appConnectionProviderId;
				const subAccount =
					(!sub.connectionProviderId ||
						sub.connectionProviderId === providerId) &&
					"connectionInstanceId" in sub
						? sub.connectionInstanceId
						: undefined;
				const appProviderMatches =
					!!appConnectionProviderId && appConnectionProviderId === providerId;
				const appAccount = appProviderMatches
					? appConnectionInstanceId
					: undefined;
				return {
					slug: sub.slug,
					...(typeof sub.appId === "string" && sub.appId
						? {
								appId: sub.appId,
								...(nestedHostOrganizationId
									? { hostOrganizationId: nestedHostOrganizationId }
									: {}),
							}
						: {}),
					organizationId: entry.organizationId,
					toolIds: sub.toolIds,
					endpointPrefixes: sub.endpointPrefixes,
					readOnly: entry.readOnly === true || sub.readOnly === true,
					// Apps inside a Connect organization mount keep their own
					// namespace; deeper nesting still groups under its parent.
					prefix: entry.organizationMount
						? organizationAppNamespace(prefix, sub)
						: prefix,
					legacyNamespace: entry.organizationMount
						? prefix
						: entry.legacyNamespace,
					connectionLabel:
						entry.connectionLabel ??
						sub.connectionLabel ??
						(appProviderMatches ? appConnectionLabel : undefined) ??
						undefined,
					connectionProviderId:
						entry.connectionProviderId ??
						sub.connectionProviderId ??
						appConnectionProviderId ??
						undefined,
					connectionInstanceId:
						entry.connectionInstanceId ?? subAccount ?? appAccount,
					connectionScope: entry.connectionInstanceId
						? entry.connectionScope
						: subAccount
							? sub.connectionScope
							: appAccount
								? (appConnectionScope ?? undefined)
								: (entry.connectionScope ??
									sub.connectionScope ??
									(appProviderMatches && !appConnectionInstanceId
										? appConnectionScope
										: undefined) ??
									undefined),
					connectionScopes:
						entry.connectionScopes ??
						sub.connectionScopes ??
						(appProviderMatches ? appConnectionScopes : undefined) ??
						undefined,
					forwardedQueryParams:
						entry.forwardedQueryParams ??
						sub.forwardedQueryParams ??
						appForwardedQueryParams ??
						undefined,
				};
			});
			// Connect evaluates scopes against its own config. Carry the selected
			// organization's reviewed scopes to the namespaces Connect serves: the
			// gateway's per-app keys, and each mounted app's own per-tool keys.
			const entryToolScopes: Record<string, string[]> = {
				...(entry.legacyNamespace
					? mountedAppToolScopes(
							prefix,
							mountable.map((tool) => tool.toolId),
							appToolScopes,
						)
					: {}),
				...(entry.organizationMount
					? organizationMountToolScopes(
							prefix,
							ensurePlatformOperatorAggregateApps(
								sourceSlug,
								nestedAggregateApps ?? [],
							),
							appToolScopes,
						)
					: {}),
			};
			const loadNestedSurface = () => {
				const nestedVisited = new Set(visited);
				// Record the source by current slug and by id so a cycle is caught
				// whichever way a descendant links back to it.
				if (!entry.appId) nestedVisited.add(entry.slug);
				nestedVisited.add(sourceSlug);
				if (sourceAppId) nestedVisited.add(sourceAppId);
				return aggregateAndPrefixTools(
					nestedEntries,
					env,
					nestedVisited,
					ctx,
					undefined,
					{ value: activationEpoch, cacheable },
				);
			};

			// D1 path: app has native tools stored in D1. A zero-tool proxy may
			// still expose the catalog resources/prompts inherited from its base app;
			// those surfaces must not prevent the nested aggregate below from loading
			// the base app's tools. The nested result carries the same catalog surface.
			if (
				mountable.length > 0 ||
				((!nestedAggregateApps || nestedAggregateApps.length === 0) &&
					(appCatalogResources.length > 0 ||
						appCatalogResourceTemplates.length > 0 ||
						appCatalogPrompts.length > 0))
			) {
				const effectiveLabel =
					entry.connectionLabel ?? appConnectionLabel ?? undefined;
				const effectiveConnectionProviderId =
					entry.connectionProviderId ?? appConnectionProviderId ?? undefined;
				const inheritedAccount =
					effectiveConnectionProviderId === appConnectionProviderId
						? appConnectionInstanceId
						: undefined;
				const effectiveConnectionInstanceId =
					entry.connectionInstanceId ?? inheritedAccount;
				const effectiveConnectionScope = entry.connectionInstanceId
					? (entry.connectionScope ?? appConnectionScope ?? undefined)
					: inheritedAccount
						? (appConnectionScope ?? undefined)
						: (entry.connectionScope ??
							(appConnectionInstanceId ? undefined : appConnectionScope) ??
							undefined);
				const effectiveConnectionScopes =
					entry.connectionScopes ?? appConnectionScopes ?? undefined;
				const d1Tools = mountable.map((tool): InternalAppTool => {
					const existingConfig =
						typeof tool.config === "object" && tool.config !== null
							? (tool.config as Record<string, unknown>)
							: {};
					const aggregateConfig = withAggregateConnectionProvider(
						existingConfig,
						{
							connectionProviderId: effectiveConnectionProviderId,
							connectionScope: effectiveConnectionScope,
							connectionScopes: effectiveConnectionScopes,
						},
					);
					return {
						...tool,
						toolId: `${prefix}__${tool.toolId}`,
						title: `${prefix}__${tool.title}`,
						config: {
							...aggregateConfig,
							...(sourceAppId ? { _sourceAppId: sourceAppId } : {}),
							_sourceAppSlug: sourceSlug,
							...(entry.organizationId
								? { _multiOrgOrganizationId: entry.organizationId }
								: {}),
							_sourceAuthRequired: tool.authRequired ?? false,
							_sourceVisibility: tool.visibility ?? "public",
							// _aggregateNamespace: when the aggregating entry sets `prefix`,
							// force resolveNamespace() to use it instead of deriving from
							// `endpoint`. Resolves namespace collisions when multiple
							// per-tenant proxies share the same endpoint domain (e.g.
							// several tenant content proxies all use `content/*`
							// endpoints).
							...(entry.prefix ? { _aggregateNamespace: entry.prefix } : {}),
							...(entry.legacyNamespace
								? { _aggregateLegacyNamespace: entry.legacyNamespace }
								: {}),
							...(effectiveLabel !== undefined
								? { _aggregateConnectionLabel: effectiveLabel }
								: {}),
							...(effectiveConnectionInstanceId
								? {
										_aggregateConnectionInstanceId:
											effectiveConnectionInstanceId,
									}
								: {}),
							...(forwardedQueryParams
								? { _forwardedQueryParams: forwardedQueryParams }
								: {}),
						},
					};
				});
				// A selected organization's unified gateway can own tools and also
				// aggregate source apps. Include both under its verified namespace.
				const nestedSurface =
					entry.organizationId && nestedEntries.length > 0
						? await loadNestedSurface()
						: null;

				return {
					tools: [...d1Tools, ...(nestedSurface?.tools ?? [])],
					resources: [
						...appCatalogResources.map((resource) => ({
							...resource,
							connectionProviderId:
								effectiveConnectionProviderId ??
								resource.connectionProviderId ??
								null,
							connectionScope:
								effectiveConnectionScope ?? resource.connectionScope ?? null,
							connectionScopes:
								effectiveConnectionScopes ?? resource.connectionScopes ?? null,
						})),
						...(nestedSurface?.resources ?? []),
					],
					resourceTemplates: [
						...appCatalogResourceTemplates.map((template) => ({
							...template,
							connectionProviderId:
								effectiveConnectionProviderId ??
								template.connectionProviderId ??
								null,
							connectionScope:
								effectiveConnectionScope ?? template.connectionScope ?? null,
							connectionScopes:
								effectiveConnectionScopes ?? template.connectionScopes ?? null,
						})),
						...(nestedSurface?.resourceTemplates ?? []),
					],
					prompts: [
						...appCatalogPrompts.map((prompt) => ({
							...prompt,
							promptName: `${prefix}__${prompt.promptName}`,
							upstreamPromptName: prompt.promptName,
							connectionProviderId:
								effectiveConnectionProviderId ??
								prompt.connectionProviderId ??
								null,
							connectionScope:
								effectiveConnectionScope ?? prompt.connectionScope ?? null,
							connectionScopes:
								effectiveConnectionScopes ?? prompt.connectionScopes ?? null,
						})),
						...(nestedSurface?.prompts ?? []),
					],
					degraded: nestedSurface?.degraded,
					toolScopes: {
						...entryToolScopes,
						...nestedSurface?.toolScopes,
					},
				};
			}

			if (upstreamMcpUrl) {
				console.warn(
					`[aggregate] App ${entry.slug} has upstreamMcpUrl but no D1 app_tools; app-level upstream URL execution is disabled. Run catalog.sync_catalog_tools_to_app to sync tools.`,
				);
				return { tools: [], resources: [], resourceTemplates: [], prompts: [] };
			}

			// Nested-aggregate fallback: upstream has no tools and no upstreamMcpUrl,
			// but uses its own aggregateApps. Recurse, preserving this entry's prefix
			// (so all chained tools group under the top-level app's namespace) and
			// passing through the entry's connectionLabel (defaults to upstream's own
			// label if the entry didn't override). E.g. tedix-unified → cloudflare-tedix
			// (aggregateApps:[cloudflare]) → cloudflare D1 tools, prefixed cloudflare-tedix__*.
			if (nestedEntries.length > 0) {
				const nested = await loadNestedSurface();
				return {
					...nested,
					toolScopes: { ...entryToolScopes, ...nested.toolScopes },
				};
			}

			return { tools: [], resources: [], resourceTemplates: [], prompts: [] };
		}),
	);
	const surface = {
		tools: results.flatMap((result) => result.tools),
		resources: results.flatMap((result) => result.resources),
		resourceTemplates: results.flatMap((result) => result.resourceTemplates),
		prompts: results.flatMap((result) => result.prompts),
		degraded: results.some((result) => result.degraded),
		toolScopes: Object.assign(
			{},
			...results.map(
				(result) =>
					(result as { toolScopes?: Record<string, string[]> }).toolScopes ??
					{},
			),
		) as Record<string, string[]>,
	};
	if (visited.size === 0) {
		const slowest = [...entryTimings]
			.sort((a, b) => b.resolveMs - a.resolveMs)
			.slice(0, 5);
		const totalMs = Date.now() - aggregateStart;
		console.log(
			JSON.stringify({
				_cm: "aggregate",
				totalMs,
				appCount: entries.length,
				toolCount: surface.tools.length,
				resourceCount: surface.resources.length,
				degraded: surface.degraded,
				slowestResolves: slowest,
			}),
		);
		// cold_rebuild = a full live fan-out from a true cold miss (L1+L2+L3 all
		// missed). Background revalidations (reason "revalidate") also run this
		// summary but emit `revalidated` instead, so they must not count as cold
		// misses — otherwise the cold-miss rate is inflated by SWR refreshes.
		if (reason === "cold") {
			emitAggregateCacheMetric(env, {
				cacheEvent: "cold_rebuild",
				appSlug: rootSlug,
				totalMs,
				appCount: entries.length,
				toolCount: surface.tools.length,
				degraded: surface.degraded,
			});
		}
	}
	return surface;
}
