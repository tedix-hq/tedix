import { describe, expect, it } from "vite-plus/test";
import { InitializeRepositoryCandidateInputSchema } from "../schemas/repository-candidate";
import {
	repositoryCandidateContentDigest,
	repositoryCandidateContentError,
	repositoryCandidateRoomName,
} from "./repository-candidate";

describe("bounded repository candidate protocol", () => {
	it("binds a content digest to exact files regardless of map insertion order", async () => {
		const first = await repositoryCandidateContentDigest({
			"b.txt": "B",
			"a.txt": "A",
		});
		expect(first).toBe(
			await repositoryCandidateContentDigest({ "a.txt": "A", "b.txt": "B" }),
		);
		expect(first).not.toBe(
			await repositoryCandidateContentDigest({ "a.txt": "A\n", "b.txt": "B" }),
		);
	});
	it("requires the frozen path set and measures growth in UTF-8 bytes", () => {
		expect(
			repositoryCandidateContentError({ "a.txt": "ok" }, ["a.txt"]),
		).toBeNull();
		expect(
			repositoryCandidateContentError({ "a.txt": "ok", "b.txt": "extra" }, [
				"a.txt",
			]),
		).not.toBeNull();
		expect(repositoryCandidateContentError({}, ["a.txt"])).not.toBeNull();
		expect(
			repositoryCandidateContentError({ "a.txt": "😀".repeat(16385) }, [
				"a.txt",
			]),
		).not.toBeNull();
		expect(
			repositoryCandidateContentError({ "a.txt": "\0" }, ["a.txt"]),
		).not.toBeNull();
	});
	it("separates organizations, admissions and exact bases in room identity", () => {
		const scope = {
			organizationId: "org-1",
			workItemId: "work",
			attemptId: "attempt",
			admissionId: "admission",
			baseRevision: "a".repeat(40),
			selectionDigest: "b".repeat(64),
		};
		const room = repositoryCandidateRoomName(scope);
		for (const changed of [
			{ organizationId: "org-2" },
			{ admissionId: "other" },
			{ baseRevision: "c".repeat(40) },
		])
			expect(repositoryCandidateRoomName({ ...scope, ...changed })).not.toBe(
				room,
			);
	});
	it("refuses traversal, duplicate and excessive selections before repository access", () => {
		const input = {
			id: "11111111-1111-4111-8111-111111111111",
			attemptId: "22222222-2222-4222-8222-222222222222",
			expectedBaseRevision: "a".repeat(40),
		};
		for (const paths of [
			["../secret"],
			["/absolute"],
			["a", "a"],
			Array.from({ length: 9 }, (_, i) => `${i}.txt`),
		])
			expect(
				InitializeRepositoryCandidateInputSchema.safeParse({ ...input, paths })
					.success,
			).toBe(false);
	});
});
