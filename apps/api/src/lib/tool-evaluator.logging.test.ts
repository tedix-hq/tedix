import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { generateSmartTestInput } from "./tool-evaluator";

describe("tool evaluator logging", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fingerprints prompts and provider errors without logging their bodies", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const secret = "prompt-secret-sk_live_123";
		const ai = {
			run: vi.fn(async () => {
				const providerError = new Error(
					`provider echoed ${secret}`,
				) as Error & {
					body: unknown;
				};
				providerError.body = {
					request: { messages: [{ content: secret }] },
					authorization: `Bearer ${secret}`,
				};
				throw providerError;
			}),
		};

		await generateSmartTestInput(ai, {
			name: "secret_tool",
			description: secret,
		});

		expect(errorLog).toHaveBeenCalledTimes(1);
		const serializedLog = JSON.stringify(errorLog.mock.calls);
		expect(serializedLog).not.toContain(secret);
		expect(serializedLog).not.toContain("authorization");
		expect(serializedLog).toContain("prompt");
		expect(serializedLog).toContain("sha256");
		expect(serializedLog).toContain("messageCount");
	});
});
