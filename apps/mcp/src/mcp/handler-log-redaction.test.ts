import { describe, expect, it } from "vite-plus/test";
import {
	redactLogValue,
	scrubSensitiveLogText,
	summarizeRpcErrorResponse,
} from "./handler-log-redaction";

describe("handler log redaction", () => {
	it("scrubs normalized sensitive keys recursively without dropping safe fields", () => {
		expect(
			redactLogValue({
				"API-Key": "hidden",
				nested: { refresh_token: "hidden", title: "safe" },
				password: "hidden",
			}),
		).toEqual({
			"API-Key": "<redacted>",
			nested: { refresh_token: "<redacted>", title: "safe" },
			password: "<redacted>",
		});
	});

	it("scrubs auth schemes, assignments, and JWTs in free text", () => {
		expect(
			scrubSensitiveLogText(
				"Bearer abc123 Basic YWJj password=hidden api_key:hidden aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc",
			),
		).toBe(
			"Bearer <redacted> Basic <redacted> password=<redacted> api_key:<redacted> <redacted.jwt>",
		);
	});

	it("caps arrays, object keys, and recursion depth", () => {
		expect(redactLogValue([0, 1, 2, 3, 4, 5, 6])).toEqual([
			0,
			1,
			2,
			3,
			4,
			"... 2 more item(s)",
		]);
		const record = Object.fromEntries(
			Array.from({ length: 14 }, (_, index) => [`key${index}`, index]),
		);
		expect(redactLogValue(record)).toEqual({
			...Object.fromEntries(Object.entries(record).slice(0, 12)),
			_truncatedKeys: 2,
		});
		expect(
			redactLogValue({ a: { b: { c: { secret: "hidden" }, d: ["hidden"] } } }),
		).toEqual({ a: { b: { c: "[object:1 key(s)]", d: "[array:1]" } } });
	});

	it("limits error summaries and handles unserializable values", () => {
		const summary = summarizeRpcErrorResponse("x".repeat(500));
		expect(summary).toEqual({
			type: "string",
			summary: `${"x".repeat(297)}...`,
			truncated: true,
		});
		const record = Object.defineProperty({}, "value", {
			enumerable: true,
			get() {
				throw new Error("private");
			},
		});
		expect(summarizeRpcErrorResponse(record)).toEqual({
			type: "object",
			summary: "[unserializable error response]",
			truncated: false,
		});
	});
});
