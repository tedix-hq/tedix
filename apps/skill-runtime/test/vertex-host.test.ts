import { describe, expect, test } from "bun:test";
import {
	isVertexHost,
	isVertexInferenceCall,
	isVertexRegionalHost,
} from "../src/vertex-host";

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

describe("Vertex inference calls", () => {
	const base = "/v1/projects/p/locations/us-central1/publishers/google/models";

	test("accepts model inference in the platform project", () => {
		for (const path of [
			`${base}/gemini-2.5-pro:generateContent`,
			`${base}/gemini-2.5-flash:streamGenerateContent`,
			`${base}/text-embedding-005:predict`,
			"/v1/publishers/google/models/gemini-2.5-pro:countTokens",
			"/v1beta1/publishers/google/models/gemini-2.5-pro:generateContent",
			"/v1/models/m:generateContent",
		]) {
			expect(isVertexInferenceCall("POST", path, "p")).toBe(true);
		}
	});

	test("rejects other methods, resources, verbs and projects", () => {
		const ok = `${base}/m:generateContent`;
		expect(isVertexInferenceCall("GET", ok, "p")).toBe(false);
		expect(isVertexInferenceCall("POST", ok, "another-project")).toBe(false);
		for (const path of [
			"/v1/projects/p/locations/us-central1/endpoints/1:predict",
			"/v1/projects/p/locations/us-central1/batchPredictionJobs",
			"/v1/projects/p/locations/us-central1/datasets",
			`${base}/m:predictLongRunning`,
			`${base}/m:generateContent/extra`,
			`${base}/m`,
			"/v2/publishers/google/models/m:generateContent",
		]) {
			expect(isVertexInferenceCall("POST", path, "p")).toBe(false);
		}
	});
});
