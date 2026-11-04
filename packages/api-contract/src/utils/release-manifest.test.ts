import { describe, expect, it } from "vite-plus/test";
import { releaseManifest } from "./release-manifest";

const valid = {
	repository: "fictional/product",
	commitSha: "a".repeat(40),
	surface: "api" as const,
	deploymentRunId: "12345",
};
describe("version-bound release manifest", () => {
	it("preserves exact source and surface identities", () => {
		expect(releaseManifest(valid)).toEqual({
			...valid,
			deploymentRunId: 12345,
		});
		expect(releaseManifest({ ...valid, surface: "os" })).toEqual({
			...valid,
			surface: "os",
			deploymentRunId: 12345,
		});
	});
	it("refuses unconfigured or malformed metadata without inventing identity", () => {
		for (const repository of [
			undefined,
			"configured-via-private-overlay",
			"fictional/product/extra",
			"https://example.test/repo",
		])
			expect(releaseManifest({ ...valid, repository })).toBeNull();
		for (const commitSha of [
			undefined,
			"unknown",
			"a".repeat(39),
			"A".repeat(40),
		])
			expect(releaseManifest({ ...valid, commitSha })).toBeNull();
		for (const deploymentRunId of [
			undefined,
			"0",
			"-1",
			"1.5",
			"01",
			"1e3",
			"9007199254740992",
			"123abc",
		])
			expect(releaseManifest({ ...valid, deploymentRunId })).toBeNull();
	});
});
