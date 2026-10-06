/** Firecrawl scrape and browser APIs used by catalog enrichment and widget tests. */

const BASE_URL = "https://api.firecrawl.dev";

export interface FirecrawlClient {
	scrape(
		url: string,
		options?: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
}

async function request(
	apiKey: string,
	path: string,
	body: unknown,
): Promise<Record<string, unknown>> {
	const response = await fetch(`${BASE_URL}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Firecrawl API error ${response.status}: ${text}`);
	}

	return response.json() as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Browser Sandbox API
// ---------------------------------------------------------------------------

export interface BrowserSession {
	id: string;
	cdpUrl: string;
	liveViewUrl: string;
	interactiveLiveViewUrl: string;
}

export interface BrowserExecuteResult {
	success: boolean;
	result?: string;
	stdout?: string;
	screenshot?: string;
	error?: string;
}

export interface FirecrawlBrowserClient {
	launch(options?: {
		ttl?: number;
		activityTtl?: number;
	}): Promise<BrowserSession>;
	execute(
		sessionId: string,
		code: string,
		language?: "node" | "python" | "bash",
	): Promise<BrowserExecuteResult>;
	close(sessionId: string): Promise<void>;
}

export function createFirecrawlBrowserClient(
	apiKey: string,
): FirecrawlBrowserClient {
	return {
		async launch(options) {
			const result = await request(apiKey, "/v2/browser", {
				ttl: options?.ttl ?? 120,
				activityTtl: options?.activityTtl ?? 60,
			});
			return result as unknown as BrowserSession;
		},

		async execute(sessionId, code, language = "node") {
			const result = await request(apiKey, `/v2/browser/${sessionId}/execute`, {
				code,
				language,
			});
			return result as unknown as BrowserExecuteResult;
		},

		async close(sessionId) {
			const response = await fetch(`${BASE_URL}/v2/browser/${sessionId}`, {
				method: "DELETE",
				headers: {
					Authorization: `Bearer ${apiKey}`,
				},
			});
			if (!response.ok && response.status !== 404) {
				const text = await response.text();
				throw new Error(
					`Firecrawl browser close error ${response.status}: ${text}`,
				);
			}
		},
	};
}

/** Create the scrape client used by catalog enrichment. */
export function createFirecrawlRestClient(apiKey: string): FirecrawlClient {
	return {
		async scrape(url, options) {
			const result = await request(apiKey, "/v1/scrape", { url, ...options });
			if (result.success && result.data && typeof result.data === "object") {
				return result.data as Record<string, unknown>;
			}
			return result;
		},
	};
}
