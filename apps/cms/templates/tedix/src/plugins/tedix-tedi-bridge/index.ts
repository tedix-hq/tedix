/**
 * tedix-tedi-bridge — bridges Emdash publish events into the org's
 * Tedix platform brain via memory_learn.
 *
 * Hook:
 *   content:afterPublish queues memory sync; the native scheduler delivers it.
 *
 * Configuration is read from Emdash settings (set via the agent's
 * cms_*.settings_update path:
 *
 *   tedi.platformApiUrl   — default https://api.tedix.dev
 *   tedi.platformApiKey   — REQUIRED; Bearer token for /rpc/memory/learn
 *   tedi.id               — UUID; scopes the learned fact to a tedi
 *   tedi.bridgeDisabled   — kill switch
 *   tedi.domain           — knowledge domain (default content-published)
 *   tedi.collections      — array of bridged collections (default ["posts"])
 *
 * Failure mode: log warn + return. Publishes never block on this hook.
 */

import type {
	ContentPublishStateChangeEvent,
	PluginContext,
	SandboxedPlugin,
} from "emdash/plugin";
import { callPlatformRpc } from "../../lib/platform-rpc";
import {
	DELIVERY_TASK,
	deliveryRoutes,
	ensureDeliverySchedule,
	enqueueDelivery,
	publication,
	processDeliveries,
} from "../../lib/publish-delivery";

const DEFAULT_API_URL = "https://api.tedix.dev";
const DEFAULT_DOMAIN = "content-published";
const DEFAULT_COLLECTIONS = ["posts"];

/** The published content item Emdash passes as `event.content`. */
type PublishedEntry = {
	id: string;
	locale?: string | null;
	slug?: string | null;
	data?: Record<string, unknown>;
};
type TaxonomyFactContext = Record<string, { label: string; slug: string }[]>;

function publishedEntry(event: ContentPublishStateChangeEvent): PublishedEntry {
	return event.content as unknown as PublishedEntry;
}

function pickString(
	obj: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	if (!obj) return undefined;
	const v = obj[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function buildFactText(
	entry: PublishedEntry,
	taxonomies: TaxonomyFactContext,
): string {
	const data = entry.data ?? {};
	const title = pickString(data, "title") ?? entry.slug ?? entry.id;
	const excerpt =
		pickString(data, "excerpt") ??
		pickString(data, "description") ??
		pickString(data, "summary") ??
		"";
	const slug = entry.slug ?? entry.id;
	const base = `Published article: "${title}" (slug: ${slug}).`;
	const taxonomySummary = Object.entries(taxonomies)
		.map(
			([taxonomy, terms]) =>
				`${taxonomy}: ${terms.map((term) => term.label).join(", ")}`,
		)
		.join("; ");
	return [
		base,
		excerpt,
		taxonomySummary ? `Taxonomies: ${taxonomySummary}.` : "",
	]
		.filter(Boolean)
		.join(" ");
}

async function readTaxonomyContext(
	event: ContentPublishStateChangeEvent,
	ctx: PluginContext,
): Promise<TaxonomyFactContext> {
	if (!ctx.taxonomies) return {};
	const entry = publishedEntry(event);
	try {
		const terms = await ctx.taxonomies.getEntryTerms(
			event.collection,
			entry.id,
			{ locale: entry.locale ?? undefined },
		);
		const grouped: TaxonomyFactContext = {};
		for (const term of terms.slice(0, 50)) {
			const taxonomyTerms = grouped[term.taxonomy] ?? [];
			taxonomyTerms.push({
				label: term.label,
				slug: term.slug,
			});
			grouped[term.taxonomy] = taxonomyTerms;
		}
		return grouped;
	} catch (error) {
		ctx.log?.warn?.(
			`[tedi-bridge] taxonomy enrichment failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {};
	}
}

async function readSetting(ctx: PluginContext, key: string): Promise<unknown> {
	try {
		if (ctx?.settings?.get) return await ctx.settings.get(key);
		if (ctx?.kv?.get) return await ctx.kv.get(`settings:${key}`);
	} catch {
		/* fall through */
	}
	return undefined;
}

function collectionList(value: unknown): string[] {
	if (Array.isArray(value))
		return value.filter((item): item is string => typeof item === "string");
	if (typeof value !== "string") return DEFAULT_COLLECTIONS;
	const collections = value
		.split(/[,\n]/)
		.map((item) => item.trim())
		.filter(Boolean);
	return collections.length > 0 ? collections : DEFAULT_COLLECTIONS;
}

export default {
	routes: deliveryRoutes,
	hooks: {
		cron: {
			timeout: 60_000,
			handler: async (event, ctx) => {
				if (event.name !== DELIVERY_TASK) return;
				const disabled = await readSetting(ctx, "tedi.bridgeDisabled");
				if (disabled === true || disabled === "true") return;
				await processDeliveries(ctx, async (job) => {
					const apiKey = await readSetting(ctx, "tedi.platformApiKey");
					if (typeof apiKey !== "string" || !apiKey || !ctx.http)
						throw new Error("Bridge not configured");
					const capabilityFetch = ctx.http.fetch.bind(ctx.http);
					const apiUrl = String(
						(await readSetting(ctx, "tedi.platformApiUrl")) ?? DEFAULT_API_URL,
					);
					await callPlatformRpc(
						apiUrl,
						["memory", "learn"],
						job.payload,
						apiKey,
						(url, init) =>
							capabilityFetch(url, {
								...init,
								signal: AbortSignal.timeout(8_000),
							}),
					);
					return { receipt: { acknowledged: true } };
				});
			},
		},
		"content:afterPublish": {
			handler: async (event, ctx) => {
				try {
					const disabled = await readSetting(ctx, "tedi.bridgeDisabled");
					if (disabled === true || disabled === "true") return;

					const collections = collectionList(
						await readSetting(ctx, "tedi.collections"),
					);
					if (!collections.includes(event.collection)) return;

					const entry = publishedEntry(event);
					const taxonomies = await readTaxonomyContext(event, ctx);
					const text = buildFactText(entry, taxonomies);
					const domain =
						(await readSetting(ctx, "tedi.domain")) ?? DEFAULT_DOMAIN;
					const tediId = await readSetting(ctx, "tedi.id");
					const slug = entry.slug ?? entry.id;

					const input = {
						content: text,
						domain,
						factType: "episode",
						confidence: 0.95,
						priority: "active",
						source: `cms://${event.collection}/${slug}`,
						sourceUrl: `cms://${event.collection}/${slug}`,
						metadata: {
							collection: event.collection,
							postId: entry.id,
							slug,
							locale: entry.locale ?? null,
							taxonomies,
							trigger: "content:afterPublish",
						},
						...(tediId ? { tediId } : {}),
					};

					await ensureDeliverySchedule(ctx);
					await enqueueDelivery(
						ctx,
						publication(event, ctx),
						`memory:${String(tediId ?? "organization")}`,
						input,
					);
				} catch {
					ctx.log?.warn?.("[tedi-bridge] delivery enqueue failed");
				}
			},
			errorPolicy: "continue",
		},
	},
} satisfies SandboxedPlugin;
