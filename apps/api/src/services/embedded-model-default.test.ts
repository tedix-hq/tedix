import { describe, expect, it } from "vite-plus/test";
import { resolveQuickChatDefaultRef } from "./embedded-model-default";

const allowedRefs = ["azure-openai/gpt-5.6-terra", "azure-openai/gpt-5.6-luna"];

describe("embedded quick-chat default", () => {
	it("prefers the operator's configured default over the routed model", () => {
		expect(
			resolveQuickChatDefaultRef({
				allowedRefs,
				configuredRef: "azure-openai/gpt-5.6-luna",
				routedRef: "azure-openai/gpt-5.6-terra",
			}),
		).toBe("azure-openai/gpt-5.6-luna");
	});
	it("uses the tedi's routed model when nothing is configured", () => {
		expect(
			resolveQuickChatDefaultRef({
				allowedRefs,
				routedRef: "azure-openai/gpt-5.6-terra",
			}),
		).toBe("azure-openai/gpt-5.6-terra");
	});
	it("falls through when the configured model is denied", () => {
		expect(
			resolveQuickChatDefaultRef({
				allowedRefs,
				configuredRef: "workers-ai/@cf/openai/gpt-oss-120b",
				routedRef: "azure-openai/gpt-5.6-terra",
			}),
		).toBe("azure-openai/gpt-5.6-terra");
	});
	it("returns no default when every candidate is denied", () => {
		expect(
			resolveQuickChatDefaultRef({
				allowedRefs,
				configuredRef: "workers-ai/@cf/openai/gpt-oss-120b",
				routedRef: "workers-ai/@cf/openai/gpt-oss-120b",
			}),
		).toBeNull();
		expect(
			resolveQuickChatDefaultRef({
				allowedRefs: [],
				routedRef: "azure-openai/x",
			}),
		).toBeNull();
	});
});
