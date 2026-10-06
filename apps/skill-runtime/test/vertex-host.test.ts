import { describe, expect, test } from "bun:test";
import { isVertexHost, isVertexRegionalHost } from "../src/vertex-host";

describe("Vertex host checks", () => {
	test("accepts global and regional Vertex hosts", () => {
		expect(isVertexRegionalHost("us-central1-aiplatform.googleapis.com")).toBe(
			true,
		);
		expect(isVertexHost("aiplatform.googleapis.com")).toBe(true);
		expect(isVertexHost("US-Central1-AIPlatform.googleapis.com")).toBe(true);
		expect(isVertexHost("x.aiplatform.googleapis.com")).toBe(true);
	});

	test("rejects lookalike hosts", () => {
		for (const host of [
			"aiplatform.googleapis.com.evil.example",
			"us-central1-aiplatform.googleapis.com.evil.example",
			"evil.example",
			"-aiplatform.googleapis.com",
			"a.b-aiplatform.googleapis.com",
			"evilaiplatform.googleapis.com",
		]) {
			expect(isVertexHost(host)).toBe(false);
		}
		expect(isVertexRegionalHost("aiplatform.googleapis.com")).toBe(false);
	});
});
