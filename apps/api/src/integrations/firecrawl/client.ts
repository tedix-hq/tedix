import { createFirecrawlRestClient, type FirecrawlClient } from "./rest-client";

/** Build the catalog scrape client from the Worker configuration. */
export function createFirecrawlClient(env: CloudflareEnv): FirecrawlClient {
	if (!env.FIRECRAWL_API_KEY) {
		throw new Error("FIRECRAWL_API_KEY not configured");
	}
	return createFirecrawlRestClient(env.FIRECRAWL_API_KEY);
}
