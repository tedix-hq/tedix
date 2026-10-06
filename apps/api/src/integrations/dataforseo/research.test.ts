import { describe, expect, it } from "vite-plus/test";
import type { DataForSeoClient, DataForSeoReceipt } from "./client";
import {
	getBacklinksOverview,
	getDomainOverview,
	getSerpResults,
	researchKeywords,
} from "./research";

const receipt: DataForSeoReceipt = {
	providerTaskId: "task-1",
	endpoint: "/v3/test/live",
	path: ["v3", "test", "live"],
	costMicros: 100,
	statusCode: 20000,
	statusMessage: "Ok.",
};

function clientWith(result: unknown[]): DataForSeoClient {
	return {
		post: async () => ({ result, receipt }),
	};
}

describe("DataForSEO research normalization", () => {
	it("normalizes keyword and SERP provider DTOs", async () => {
		const keywords = await researchKeywords(
			clientWith([
				{
					items: [
						{
							keyword: "durable workers",
							keyword_info: {
								search_volume: 720,
								cpc: 3.25,
								competition: 0.41,
								competition_level: "MEDIUM",
							},
							keyword_properties: { keyword_difficulty: 38 },
						},
					],
				},
			]),
			{
				keyword: "workers",
				locationCode: 2840,
				languageCode: "en",
				limit: 25,
			},
		);
		expect(keywords.data).toEqual([
			{
				keyword: "durable workers",
				searchVolume: 720,
				cpc: 3.25,
				competition: 0.41,
				competitionLevel: "MEDIUM",
				keywordDifficulty: 38,
			},
		]);

		const serp = await getSerpResults(
			clientWith([
				{
					items: [
						{
							type: "organic",
							rank_absolute: 2,
							domain: "example.com",
							title: "Example",
							url: "https://example.com/article",
							description: "An example result.",
							unused_vendor_field: true,
						},
					],
				},
			]),
			{
				keyword: "durable workers",
				locationCode: 2840,
				languageCode: "en",
				depth: 20,
				device: "desktop",
			},
		);
		expect(serp.data).toEqual([
			{
				type: "organic",
				rank: 2,
				domain: "example.com",
				title: "Example",
				url: "https://example.com/article",
				description: "An example result.",
			},
		]);
	});

	it("normalizes domain and backlink summaries without leaking raw DTOs", async () => {
		const domain = await getDomainOverview(
			clientWith([
				{
					items: [
						{
							metrics: {
								organic: { etv: 1200.5, count: 42 },
							},
						},
					],
				},
			]),
			{
				domain: "example.com",
				locationCode: 2840,
				languageCode: "en",
			},
		);
		expect(domain.data).toEqual({
			domain: "example.com",
			organicTraffic: 1200.5,
			organicKeywords: 42,
		});

		const backlinks = await getBacklinksOverview(
			clientWith([
				{
					target: "example.com",
					rank: 67,
					backlinks: 1234,
					referring_pages: 456,
					referring_domains: 78,
					broken_backlinks: 9,
					new_backlinks: 10,
					lost_backlinks: 3,
					info: { target_spam_score: 4 },
				},
			]),
			{ target: "example.com", includeSubdomains: true },
		);
		expect(backlinks.data).toEqual({
			target: "example.com",
			rank: 67,
			backlinks: 1234,
			referringPages: 456,
			referringDomains: 78,
			brokenBacklinks: 9,
			newBacklinks: 10,
			lostBacklinks: 3,
			spamScore: 4,
		});
	});
});
