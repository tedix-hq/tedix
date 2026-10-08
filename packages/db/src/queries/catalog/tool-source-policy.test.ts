import { describe, expect, it } from "vite-plus/test";
import {
	normalizeToolAnnotations,
	splitToolAnnotations,
	UPSTREAM_TOOL_ANNOTATIONS_META_KEY,
	withUpstreamAnnotationsMeta,
} from "./tool-source-policy";

describe("normalizeToolAnnotations", () => {
	it("keeps title and the four boolean hints only", () => {
		expect(
			normalizeToolAnnotations({
				title: "Render deck",
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
				cost: { usd: 0.02 },
				progressHint: true,
				returnDirect: true,
				"x-openai-isConsequential": false,
			}),
		).toEqual({
			title: "Render deck",
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("drops known keys with the wrong type", () => {
		expect(
			normalizeToolAnnotations({
				title: 42,
				readOnlyHint: "true",
				destructiveHint: 1,
				openWorldHint: true,
			}),
		).toEqual({ openWorldHint: true });
	});

	it("returns null when nothing valid remains", () => {
		expect(normalizeToolAnnotations({ cost: { usd: 1 } })).toBeNull();
		expect(normalizeToolAnnotations({})).toBeNull();
		expect(normalizeToolAnnotations(null)).toBeNull();
		expect(normalizeToolAnnotations(["readOnlyHint"])).toBeNull();
		expect(normalizeToolAnnotations("readOnly")).toBeNull();
	});
});

describe("splitToolAnnotations", () => {
	it("returns every dropped key as extras", () => {
		expect(
			splitToolAnnotations({
				readOnlyHint: "yes",
				idempotentHint: true,
				"x-openai-isConsequential": true,
			}),
		).toEqual({
			annotations: { idempotentHint: true },
			extras: { readOnlyHint: "yes", "x-openai-isConsequential": true },
		});
		expect(splitToolAnnotations({ title: "Clean" }).extras).toBeNull();
	});
});

describe("withUpstreamAnnotationsMeta", () => {
	it("merges extras under the namespaced key and leaves meta alone without them", () => {
		const meta = { audience: ["user"] };
		expect(withUpstreamAnnotationsMeta(meta, null)).toBe(meta);
		expect(withUpstreamAnnotationsMeta(null, null)).toBeNull();
		expect(withUpstreamAnnotationsMeta(meta, { cost: 1 })).toEqual({
			audience: ["user"],
			[UPSTREAM_TOOL_ANNOTATIONS_META_KEY]: { cost: 1 },
		});
	});
});
