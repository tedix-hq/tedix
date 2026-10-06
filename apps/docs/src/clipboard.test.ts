import { describe, expect, it, vi } from "vite-plus/test";
import { copyTextWithFallback } from "../template/clipboard";

function fallbackDocument(result = true) {
	const field = {
		value: "",
		style: { position: "", opacity: "" },
		setAttribute: vi.fn(),
		select: vi.fn(),
		remove: vi.fn(),
	};
	return {
		field,
		document: {
			body: { appendChild: vi.fn() },
			createElement: vi.fn(() => field),
			execCommand: vi.fn(() => result),
		},
	};
}

describe("bounded documentation copy action", () => {
	it("uses the modern clipboard when it completes", async () => {
		const clipboard = { writeText: vi.fn(async () => {}) };
		const fallback = fallbackDocument();
		expect(
			await copyTextWithFallback("https://docs.example/llms.txt", {
				clipboard,
				document: fallback.document,
			}),
		).toBe(true);
		expect(clipboard.writeText).toHaveBeenCalledWith(
			"https://docs.example/llms.txt",
		);
		expect(fallback.document.execCommand).not.toHaveBeenCalled();
	});

	it("falls back when the clipboard stalls", async () => {
		const clipboard = { writeText: vi.fn(() => new Promise<void>(() => {})) };
		const fallback = fallbackDocument();
		expect(
			await copyTextWithFallback("copy me", {
				clipboard,
				document: fallback.document,
				timeoutMs: 0,
			}),
		).toBe(true);
		expect(fallback.field.value).toBe("copy me");
		expect(fallback.field.select).toHaveBeenCalledOnce();
		expect(fallback.document.execCommand).toHaveBeenCalledWith("copy");
		expect(fallback.field.remove).toHaveBeenCalledOnce();
	});
});
