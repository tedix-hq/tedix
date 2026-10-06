import { describe, expect, it } from "vite-plus/test";
import {
	classifyProviderError,
	isCloudflareEdge5xxError,
	providerErrorText,
} from "./provider-error.js";

describe("classifyProviderError — non-retryable families", () => {
	const terminal: Array<[string, string]> = [
		["Error code: 429 - Spend limited", "billing"],
		["Incorrect API key provided: sk-***", "auth"],
		["Error code: 401 - {'error': {'message': 'Unauthorized'}}", "auth"],
		["permission_denied for this deployment", "auth"],
		[
			"The model `gpt-9` does not exist or you do not have access to it",
			"not_found",
		],
		["DeploymentNotFound: deployment does not exist", "not_found"],
		["invalid_request_error: unsupported_value for 'tools'", "bad_request"],
		[
			"This model's maximum context length is 200000 tokens, however you requested 240000",
			"context_overflow",
		],
		["context_length_exceeded", "context_overflow"],
		[
			"The response was filtered due to content_filter policy",
			"content_filter",
		],
		["ResponsibleAIPolicyViolation", "content_filter"],
		["You exceeded your current quota: insufficient_quota", "quota"],
		["not-enough-credits for organization", "quota"],
		["premium-usage-exceeded", "quota"],
	];

	for (const [message, family] of terminal) {
		it(`seals ${family}: ${message.slice(0, 44)}`, () => {
			const verdict = classifyProviderError(new Error(message));
			expect(verdict.retryable).toBe(false);
			expect(verdict.family).toBe(family);
			expect(verdict.retryAfterMs).toBe(0);
		});
	}
});

describe("classifyProviderError — retryable families", () => {
	const transient: Array<[string, string]> = [
		["Error code: 429 - rate limit reached for gpt-4o", "rate_limit"],
		["Too Many Requests", "rate_limit"],
		["Error code: 503 - service_unavailable", "overloaded"],
		["The engine is currently overloaded, please try again", "overloaded"],
		["fetch failed", "network"],
		["socket hang up", "network"],
		["Connection reset by peer", "network"],
		["ETIMEDOUT", "network"],
		["empty_assistant_message", "empty_response"],
	];

	for (const [message, family] of transient) {
		it(`retries ${family}: ${message.slice(0, 44)}`, () => {
			const verdict = classifyProviderError(new Error(message));
			expect(verdict.retryable).toBe(true);
			expect(verdict.family).toBe(family);
		});
	}

	it("gives rate limits a longer base delay than generic transients", () => {
		expect(
			classifyProviderError("Error code: 429").retryAfterMs,
		).toBeGreaterThan(classifyProviderError("fetch failed").retryAfterMs);
	});
});

describe("classifyProviderError — ordering and precedence", () => {
	it("treats a quota-bearing 429 as terminal, not as a rate limit", () => {
		const verdict = classifyProviderError(
			new Error(
				"Error code: 429 - {'message': 'You exceeded-quota for this org'}",
			),
		);
		expect(verdict.retryable).toBe(false);
		expect(verdict.family).toBe("quota");
	});

	it("treats a bare 429 as a retryable rate limit", () => {
		expect(classifyProviderError("Error code: 429").retryable).toBe(true);
	});

	it("treats a provider-side spend gate as terminal billing", () => {
		const verdict = classifyProviderError({
			message: "Error code: 429",
			body: { message: "Spend limited" },
		});
		expect(verdict).toEqual({
			retryable: false,
			family: "billing",
			retryAfterMs: 0,
		});
	});

	it("treats an unrecognized 4xx as terminal via the status guard", () => {
		const verdict = classifyProviderError("Error code: 422 - unprocessable");
		expect(verdict.retryable).toBe(false);
		expect(verdict.family).toBe("bad_request");
	});

	it("keeps 408/409/425 retryable", () => {
		for (const status of [408, 409, 425]) {
			expect(classifyProviderError(`Error code: ${status}`).retryable).toBe(
				true,
			);
		}
	});
});

describe("classifyProviderError — Cloudflare edge", () => {
	it("classifies edge 52x as retryable with a longer delay", () => {
		const verdict = classifyProviderError(
			new Error("Error code: 524 - A timeout occurred"),
		);
		expect(verdict.retryable).toBe(true);
		expect(verdict.family).toBe("edge_5xx");
		expect(verdict.retryAfterMs).toBeGreaterThan(
			classifyProviderError("fetch failed").retryAfterMs,
		);
	});

	it("detects the edge signature directly", () => {
		expect(isCloudflareEdge5xxError("error code: 520")).toBe(true);
		expect(
			isCloudflareEdge5xxError("Web server is returning an unknown error"),
		).toBe(true);
		expect(isCloudflareEdge5xxError("plain failure")).toBe(false);
	});
});

describe("classifyProviderError — conservatism", () => {
	it("defaults an unrecognized error to retryable (today's behavior)", () => {
		const verdict = classifyProviderError(new Error("something odd happened"));
		expect(verdict.retryable).toBe(true);
		expect(verdict.family).toBe("unknown");
	});

	it("defaults empty/absent errors to retryable", () => {
		expect(classifyProviderError(null).retryable).toBe(true);
		expect(classifyProviderError(undefined).retryable).toBe(true);
		expect(classifyProviderError("").retryable).toBe(true);
		expect(classifyProviderError("   ").retryable).toBe(true);
	});
});

describe("providerErrorText", () => {
	it("flattens nested detail/cause bodies where gateways bury the provider body", () => {
		const text = providerErrorText({
			message: "Request failed",
			detail: "invalid_api_key",
		});
		expect(text).toContain("invalid_api_key");
	});

	it("reads a nested error object's message", () => {
		const text = providerErrorText({
			message: "upstream",
			error: { message: "context_length_exceeded" },
		});
		expect(text).toContain("context_length_exceeded");
	});

	it("classifies through the nested body", () => {
		const verdict = classifyProviderError({
			message: "Request failed",
			error: { message: "insufficient_quota" },
		});
		expect(verdict.retryable).toBe(false);
		expect(verdict.family).toBe("quota");
	});

	it("passes strings through", () => {
		expect(providerErrorText("plain")).toBe("plain");
	});
});
