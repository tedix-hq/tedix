import { describe, it, expect } from "vite-plus/test";
import {
	parseGuidanceFrontmatter,
	classifyGuidanceResource,
	scoreGuidanceResource,
	buildGuidanceSummary,
	guidanceMetadataFromResource,
} from "./guidance";
describe("guidance frontmatter", () => {
	it("parses YAML scalar, inline-list, and block-list metadata", () => {
		const metadata = parseGuidanceFrontmatter(`---
title: "Deploy: Review"
summary: "Roll forward safely"
description: |
  Checks deploy state before shipping.
version: 2.1
tags:
  - mcp
  - "release:prod"
dependencies: ["git", "wrangler"]
provenance: https://example.com/deploy-review
source: tedix
---

Use this before deploys.`);
		expect(metadata).toMatchObject({
			title: "Deploy: Review",
			summary: "Roll forward safely",
			description: "Checks deploy state before shipping.",
			version: "2.1",
			tags: ["mcp", "release:prod"],
			dependencies: ["git", "wrangler"],
			provenance: "https://example.com/deploy-review",
			source: "tedix",
		});
	});
	it("ignores non-scalar YAML list entries instead of stringifying objects", () => {
		const metadata = parseGuidanceFrontmatter(`---
title: Cleanup Guide
tags:
  - useful
  - nested: nope
dependencies: git, wrangler
---

Body.`);

		expect(metadata?.tags).toEqual(["useful"]);
		expect(metadata?.dependencies).toEqual(["git", "wrangler"]);
	});
	it("classifies skill manifests and archives without activating supporting files", () => {
		const resource = { serverId: "srv", uri: "skill://review/SKILL.md" };
		expect(classifyGuidanceResource(resource)).toBe("skill");
		expect(
			classifyGuidanceResource({ ...resource, uri: "skill://review.tar.gz" }),
		).toBe("skill");
		expect(
			classifyGuidanceResource({
				...resource,
				uri: "skill://review/archive.tar.gz",
			}),
		).toBeNull();
		expect(
			classifyGuidanceResource({
				...resource,
				uri: "skill://review/index.json",
			}),
		).toBeNull();
	});
	it("uses priority before kind and reads namespaced metadata for summaries", () => {
		const resource = {
			serverId: "srv",
			uri: "guide://review",
			name: "Review",
			_meta: {
				"io.tedix/version": "2",
				"io.tedix/tags": ["review"],
				"io.tedix/provenance": { serverUrl: "https://example.com" },
			},
			annotations: { priority: 0.9, audience: ["assistant"] },
		};
		const metadata = guidanceMetadataFromResource(resource);
		expect(metadata).toEqual({
			title: "Review",
			version: "2",
			tags: ["review"],
			provenance: "https://example.com",
			audience: ["assistant"],
		});
		expect(scoreGuidanceResource(resource, "guide")).toBeGreaterThan(
			scoreGuidanceResource(
				{ ...resource, annotations: { priority: 0.1 } },
				"skill",
			),
		);
		expect(
			buildGuidanceSummary(
				"# Heading\nBody",
				undefined,
				{ ...metadata, summary: "Use this review" },
				8,
			),
		).toBe("Use thi…");
	});
});
