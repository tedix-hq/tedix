import { describe, it, expect } from "vite-plus/test";
import * as z from "zod";
import {
	parseRepoCommitRevisionExpectation,
	parseRepoCommitExactTreeValidation,
	RepoCommitExactTreeValidationSchema,
} from "./repo-commit-write";

const validation = {
	version: "v1",
	baseSha: "a".repeat(40),
	resultTreeSha: "b".repeat(40),
	orderedChangesDigest: "c".repeat(64),
	gateRecipeDigest: "d".repeat(64),
	processId: "check-one",
	terminalEvidenceRef: "r2://fictional/check-one/evidence.json",
	exitCode: 0,
};
describe("exact repository tree check receipt", () => {
	it("exposes concrete JSON schema for strict RPC and native tool projection", () => {
		expect(
			z.toJSONSchema(RepoCommitExactTreeValidationSchema).properties?.exitCode,
		).toMatchObject({ const: 0 });
	});
	it("retains exact check identity through revision parsing", () => {
		expect(
			parseRepoCommitRevisionExpectation({
				baseSha: validation.baseSha,
				targetSha: null,
				exactTreeValidation: validation,
			})?.exactTreeValidation,
		).toEqual(validation);
	});
	it("preserves legacy parsing without granting exact tree validation", () => {
		expect(
			parseRepoCommitRevisionExpectation({
				baseSha: validation.baseSha,
				targetSha: null,
			})?.exactTreeValidation,
		).toBeUndefined();
	});
	it.each([
		{ exitCode: 1 },
		{ version: "v0" },
		{ resultTreeSha: "HEAD" },
		{ gateRecipeDigest: "x" },
		{ processId: "" },
		{ terminalEvidenceRef: "https://example.invalid/unchecked" },
	])("rejects malformed receipt %j", (change) => {
		expect(
			parseRepoCommitExactTreeValidation({ ...validation, ...change }),
		).toBeNull();
	});
	it("rejects a receipt against a different base", () => {
		expect(
			parseRepoCommitRevisionExpectation({
				baseSha: "f".repeat(40),
				targetSha: null,
				exactTreeValidation: validation,
			}),
		).toBeNull();
	});
});
