import { describe, expect, it } from "vite-plus/test";
import {
	guessBundleContentType,
	isBundleArtifact,
	resolveBundleObject,
} from "./artifact-serve";
import { isOwnedArtifactR2Uri } from "./artifact-uri-ownership";

const BUNDLE = {
	uri: "r2://tedix-tedi-production/tedi-1/artifacts/deliverable/bundle/art-1/",
	metadata: { bundle: true, entrypoint: "index.html" },
};

describe("guessBundleContentType", () => {
	it("maps common dashboard extensions", () => {
		expect(guessBundleContentType("index.html")).toContain("text/html");
		expect(guessBundleContentType("js/app.js")).toContain("text/javascript");
		expect(guessBundleContentType("data.json")).toContain("application/json");
		expect(guessBundleContentType("style.css")).toContain("text/css");
		expect(guessBundleContentType("logo.svg")).toBe("image/svg+xml");
	});

	it("falls back to octet-stream", () => {
		expect(guessBundleContentType("blob.weird")).toBe(
			"application/octet-stream",
		);
	});
});

describe("isBundleArtifact", () => {
	it("requires metadata.bundle === true", () => {
		expect(isBundleArtifact({ bundle: true })).toBe(true);
		expect(isBundleArtifact({ bundle: "true" })).toBe(false);
		expect(isBundleArtifact(null)).toBe(false);
		expect(isBundleArtifact(undefined)).toBe(false);
	});
});

describe("resolveBundleObject", () => {
	it("empty subpath serves the entrypoint", () => {
		const target = resolveBundleObject(BUNDLE, "");
		expect(target?.uri).toBe(`${BUNDLE.uri}index.html`);
		expect(target?.mimeType).toContain("text/html");
	});

	it("resolves nested subpaths with extension content types", () => {
		const target = resolveBundleObject(BUNDLE, "js/app.js");
		expect(target?.uri).toBe(`${BUNDLE.uri}js/app.js`);
		expect(target?.mimeType).toContain("text/javascript");
	});

	it("rejects traversal — plain and percent-encoded", () => {
		expect(resolveBundleObject(BUNDLE, "../secret")).toBeNull();
		expect(resolveBundleObject(BUNDLE, "%2e%2e/secret")).toBeNull();
		expect(resolveBundleObject(BUNDLE, "a/%2E%2E/b")).toBeNull();
	});

	it("rejects non-prefix uris (single-file artifacts)", () => {
		expect(
			resolveBundleObject(
				{ uri: "r2://bucket/key.html", metadata: { bundle: true } },
				"x",
			),
		).toBeNull();
	});

	it("honors a custom entrypoint", () => {
		const target = resolveBundleObject(
			{ uri: BUNDLE.uri, metadata: { bundle: true, entrypoint: "app.html" } },
			"",
		);
		expect(target?.uri).toBe(`${BUNDLE.uri}app.html`);
	});

	it("keeps a resolved bundle object inside the owning artifact namespace", () => {
		const target = resolveBundleObject(BUNDLE, "js/app.js");
		expect(
			isOwnedArtifactR2Uri({
				uri: target?.uri,
				organizationId: "org-1",
				tediId: "tedi-1",
			}),
		).toBe(true);
		expect(
			isOwnedArtifactR2Uri({
				uri: "r2://tedix-tedi-production/orgs/other-org/tedis/22222222-2222-4222-8222-222222222222/workstations/coding/processes/p/terminal/app.js",
				organizationId: "org-1",
				tediId: "tedi-1",
			}),
		).toBe(false);
	});
});
