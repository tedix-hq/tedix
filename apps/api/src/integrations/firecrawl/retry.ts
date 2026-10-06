/**
 * Firecrawl Retry Utilities
 * Exponential backoff retry logic for Firecrawl operations
 */

import type { FirecrawlClient } from "./rest-client";
import { sleep } from "@tedix/worker-kit/sleep";

/**
 * Retry options
 */
export interface RetryOptions {
	/** Maximum number of retry attempts */
	maxRetries?: number;
	/** Initial delay in milliseconds */
	initialDelay?: number;
	/** Backoff multiplier */
	backoffMultiplier?: number;
	/** Maximum delay in milliseconds */
	maxDelay?: number;
	/** Add jitter to avoid synchronized retries (default true) */
	useJitter?: boolean;
	/** Max jitter percentage of computed delay (0.2 = +/-20%) */
	jitterRatio?: number;
	/** Optional retry gate. Return false to stop retrying for this error. */
	shouldRetry?: (error: Error, attempt: number) => boolean;
}

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(
	attempt: number,
	options: Required<RetryOptions>,
): number {
	const delay = options.initialDelay * options.backoffMultiplier ** attempt;
	const bounded = Math.min(delay, options.maxDelay);
	if (!options.useJitter) return bounded;
	const jitterSpan = Math.max(1, Math.floor(bounded * options.jitterRatio));
	const offset = Math.floor(Math.random() * (jitterSpan * 2 + 1)) - jitterSpan;
	return Math.max(1, bounded + offset);
}

/**
 * Execute function with exponential backoff retry
 */
async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const opts: Required<RetryOptions> = {
		maxRetries: options.maxRetries ?? 3,
		initialDelay: options.initialDelay ?? 1000,
		backoffMultiplier: options.backoffMultiplier ?? 2,
		maxDelay: options.maxDelay ?? 10000,
		useJitter: options.useJitter ?? true,
		jitterRatio: options.jitterRatio ?? 0.2,
		shouldRetry: options.shouldRetry ?? (() => true),
	};

	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (!opts.shouldRetry(lastError, attempt)) {
				throw lastError;
			}

			// Don't retry on last attempt
			if (attempt === opts.maxRetries) {
				break;
			}

			// Calculate delay and wait
			const delay = getBackoffDelay(attempt, opts);
			console.log(
				`[Retry] Attempt ${attempt + 1}/${opts.maxRetries} failed, retrying in ${delay}ms...`,
			);
			await sleep(delay);
		}
	}

	throw lastError || new Error("Operation failed after retries");
}

/**
 * Scrape URL with retry logic
 */
export async function scrapeWithRetry(
	client: FirecrawlClient,
	url: string,
	options?: Record<string, unknown>,
	retryOptions?: RetryOptions,
): Promise<unknown> {
	return retryWithBackoff(async () => {
		const result = await client.scrape(url, options);
		return result;
	}, retryOptions);
}
