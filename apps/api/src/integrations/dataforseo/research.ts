import type { DataForSeoClient, DataForSeoReceipt } from "./client";

const KEYWORD_SUGGESTIONS_ENDPOINT =
	"/v3/dataforseo_labs/google/keyword_suggestions/live";
const SERP_RESULTS_ENDPOINT = "/v3/serp/google/organic/live/advanced";
const DOMAIN_OVERVIEW_ENDPOINT =
	"/v3/dataforseo_labs/google/domain_rank_overview/live";
const BACKLINKS_OVERVIEW_ENDPOINT = "/v3/backlinks/summary/live";

interface MarketInput {
	locationCode: number;
	languageCode: string;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
	return typeof value === "object" && value !== null
		? (value as UnknownRecord)
		: null;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function firstResultItems(result: unknown[]): unknown[] {
	const first = record(result[0]);
	return Array.isArray(first?.items) ? first.items : [];
}

function firstResult(result: unknown[]): UnknownRecord | null {
	return record(result[0]);
}

export interface SeoResearchResult<T> {
	data: T;
	receipt: DataForSeoReceipt;
}

export interface KeywordResearchItem {
	keyword: string;
	searchVolume: number | null;
	cpc: number | null;
	competition: number | null;
	competitionLevel: string | null;
	keywordDifficulty: number | null;
}

export async function researchKeywords(
	client: DataForSeoClient,
	input: MarketInput & { keyword: string; limit: number },
): Promise<SeoResearchResult<KeywordResearchItem[]>> {
	const response = await client.post(KEYWORD_SUGGESTIONS_ENDPOINT, {
		keyword: input.keyword,
		location_code: input.locationCode,
		language_code: input.languageCode,
		limit: input.limit,
		include_seed_keyword: true,
		include_serp_info: false,
		include_clickstream_data: false,
		ignore_synonyms: false,
		exact_match: false,
	});

	const data = firstResultItems(response.result).flatMap((raw) => {
		const item = record(raw);
		const keyword = stringOrNull(item?.keyword);
		if (!item || !keyword) return [];
		const info = record(item.keyword_info);
		const properties = record(item.keyword_properties);
		return [
			{
				keyword,
				searchVolume: numberOrNull(info?.search_volume),
				cpc: numberOrNull(info?.cpc),
				competition: numberOrNull(info?.competition),
				competitionLevel: stringOrNull(info?.competition_level),
				keywordDifficulty:
					numberOrNull(properties?.keyword_difficulty) ??
					numberOrNull(info?.keyword_difficulty),
			},
		];
	});

	return { data, receipt: response.receipt };
}

export interface SerpResearchItem {
	type: string;
	rank: number | null;
	domain: string | null;
	title: string | null;
	url: string | null;
	description: string | null;
}

export async function getSerpResults(
	client: DataForSeoClient,
	input: MarketInput & {
		keyword: string;
		depth: number;
		device: "desktop" | "mobile";
	},
): Promise<SeoResearchResult<SerpResearchItem[]>> {
	const response = await client.post(SERP_RESULTS_ENDPOINT, {
		keyword: input.keyword,
		location_code: input.locationCode,
		language_code: input.languageCode,
		device: input.device,
		os: input.device === "desktop" ? "windows" : "android",
		depth: input.depth,
	});

	const data = firstResultItems(response.result).flatMap((raw) => {
		const item = record(raw);
		const type = stringOrNull(item?.type);
		if (!item || !type) return [];
		return [
			{
				type,
				rank: numberOrNull(item.rank_absolute) ?? numberOrNull(item.rank_group),
				domain: stringOrNull(item.domain),
				title: stringOrNull(item.title),
				url: stringOrNull(item.url),
				description: stringOrNull(item.description),
			},
		];
	});

	return { data, receipt: response.receipt };
}

export interface DomainOverview {
	domain: string;
	organicTraffic: number | null;
	organicKeywords: number | null;
}

export async function getDomainOverview(
	client: DataForSeoClient,
	input: MarketInput & { domain: string },
): Promise<SeoResearchResult<DomainOverview>> {
	const response = await client.post(DOMAIN_OVERVIEW_ENDPOINT, {
		target: input.domain,
		location_code: input.locationCode,
		language_code: input.languageCode,
		limit: 1,
	});
	const item = record(firstResultItems(response.result)[0]);
	const metrics = record(item?.metrics);
	const organic = record(metrics?.organic);

	return {
		data: {
			domain: input.domain,
			organicTraffic: numberOrNull(organic?.etv),
			organicKeywords: numberOrNull(organic?.count),
		},
		receipt: response.receipt,
	};
}

export interface BacklinksOverview {
	target: string;
	rank: number | null;
	backlinks: number | null;
	referringPages: number | null;
	referringDomains: number | null;
	brokenBacklinks: number | null;
	newBacklinks: number | null;
	lostBacklinks: number | null;
	spamScore: number | null;
}

export async function getBacklinksOverview(
	client: DataForSeoClient,
	input: { target: string; includeSubdomains: boolean },
): Promise<SeoResearchResult<BacklinksOverview>> {
	const response = await client.post(BACKLINKS_OVERVIEW_ENDPOINT, {
		target: input.target,
		include_subdomains: input.includeSubdomains,
		include_indirect_links: true,
		exclude_internal_backlinks: true,
		backlinks_status_type: "live",
		rank_scale: "one_hundred",
	});
	const item = firstResult(response.result);
	const info = record(item?.info);

	return {
		data: {
			target: input.target,
			rank: numberOrNull(item?.rank),
			backlinks: numberOrNull(item?.backlinks),
			referringPages: numberOrNull(item?.referring_pages),
			referringDomains: numberOrNull(item?.referring_domains),
			brokenBacklinks: numberOrNull(item?.broken_backlinks),
			newBacklinks: numberOrNull(item?.new_backlinks),
			lostBacklinks: numberOrNull(item?.lost_backlinks),
			spamScore:
				numberOrNull(item?.backlinks_spam_score) ??
				numberOrNull(info?.target_spam_score),
		},
		receipt: response.receipt,
	};
}
