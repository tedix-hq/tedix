import { validateUrl } from "@tedix/ssrf-guard";
import {
	browserRunTransport,
	type BrowserRunEngine,
	BrowserRunQuickActionError,
	type BrowserRunRestConfig,
	scrapeMarkdownPage,
} from "../integrations/browser-run/client";

export interface IngestionBrowserPage {
	url: string;
	title: string;
	content: string;
}

export interface IngestionBrowserAttempt {
	engine: BrowserRunEngine;
	transport: "workers-binding" | "rest";
	status: "succeeded" | "failed";
	wallMs: number;
	browserMsUsed?: number;
	error?: string;
}

export interface IngestionBrowserTelemetry {
	requestedEngine: BrowserRunEngine;
	selectedEngine?: BrowserRunEngine;
	transport: "workers-binding" | "rest";
	fallbackReason?: string;
	retryCount: number;
	totalWallMs: number;
	browserMsUsed: number;
	attempts: IngestionBrowserAttempt[];
}

export class IngestionBrowserError extends Error {
	constructor(
		message: string,
		readonly telemetry: IngestionBrowserTelemetry,
	) {
		super(message);
		this.name = "IngestionBrowserError";
	}
}

interface KitesurfEligibility {
	appVisibility: "public" | "private" | "disabled";
	sourceType: string;
	config: Record<string, unknown> | null;
	url: string;
}

const KITESURF_SOURCE_TYPES = new Set([
	"webpage",
	"website",
	"sitemap",
	"rss",
	"manual",
]);

export function isKitesurfIngestionEligible({
	appVisibility,
	sourceType,
	config,
	url,
}: KitesurfEligibility): boolean {
	if (appVisibility !== "public") return false;
	if (config?.browserEngine !== "kitesurf") return false;
	if (!KITESURF_SOURCE_TYPES.has(sourceType)) {
		return false;
	}
	return validateUrl(url, { allowHttp: true }) === null;
}

export async function scrapeIngestionPage(
	browserBinding: unknown | undefined,
	url: string,
	options: {
		requestKitesurf: boolean;
		rest?: BrowserRunRestConfig;
		clock?: () => number;
	},
): Promise<{
	page: IngestionBrowserPage;
	telemetry: IngestionBrowserTelemetry;
}> {
	const clock = options.clock ?? Date.now;
	const operationStartedAt = clock();
	const requestedEngine: BrowserRunEngine = options.requestKitesurf
		? "kitesurf"
		: "chromium";
	const engines: BrowserRunEngine[] = options.requestKitesurf
		? ["kitesurf", "chromium"]
		: ["chromium"];
	const attempts: IngestionBrowserAttempt[] = [];
	let fallbackReason: string | undefined;

	for (const engine of engines) {
		const attemptStartedAt = clock();
		try {
			const page = await scrapeMarkdownPage(browserBinding, url, {
				timeoutMs: 30_000,
				engine,
				rest: options.rest,
			});
			if (!page) {
				throw new Error("Browser Run returned empty or incomplete Markdown");
			}
			attempts.push({
				engine,
				transport: browserRunTransport("markdown", engine),
				status: "succeeded",
				wallMs: Math.max(0, clock() - attemptStartedAt),
				...(page.browserMsUsed !== undefined
					? { browserMsUsed: page.browserMsUsed }
					: {}),
			});
			return {
				page: {
					url: page.finalUrl ?? url,
					title: page.title,
					content: page.markdown,
				},
				telemetry: {
					requestedEngine,
					selectedEngine: engine,
					transport: browserRunTransport("markdown", engine),
					...(fallbackReason ? { fallbackReason } : {}),
					retryCount: attempts.length - 1,
					totalWallMs: Math.max(0, clock() - operationStartedAt),
					browserMsUsed: attempts.reduce(
						(total, attempt) => total + (attempt.browserMsUsed ?? 0),
						0,
					),
					attempts,
				},
			};
		} catch (error) {
			const message = (
				error instanceof Error ? error.message : String(error)
			).slice(0, 500);
			attempts.push({
				engine,
				transport: browserRunTransport("markdown", engine),
				status: "failed",
				wallMs: Math.max(0, clock() - attemptStartedAt),
				...(error instanceof BrowserRunQuickActionError &&
				error.browserMsUsed !== undefined
					? { browserMsUsed: error.browserMsUsed }
					: {}),
				error: message,
			});
			if (engine === "kitesurf") fallbackReason = message;
		}
	}

	throw new IngestionBrowserError(
		`Browser ingestion failed after ${attempts.length} attempt(s): ${attempts
			.map((attempt) => `${attempt.engine}: ${attempt.error ?? "failed"}`)
			.join("; ")}`,
		{
			requestedEngine,
			transport: attempts.at(-1)?.transport ?? "workers-binding",
			...(fallbackReason ? { fallbackReason } : {}),
			retryCount: Math.max(0, attempts.length - 1),
			totalWallMs: Math.max(0, clock() - operationStartedAt),
			browserMsUsed: attempts.reduce(
				(total, attempt) => total + (attempt.browserMsUsed ?? 0),
				0,
			),
			attempts,
		},
	);
}
