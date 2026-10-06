import { describe, expect, it } from "vite-plus/test";
import {
	decodeSkillsListCursor,
	encodeSkillsListCursor,
	paginateSortedSkillsList,
	SKILLS_LIST_PAGE_SIZE,
	sortSkillEntriesDeterministically,
} from "./skills-list-pagination";
import { encodeToolsListCursor } from "./tools-list-pagination";

/** Zero-padded uris so byte order == numeric order. */
function makeSkills(count: number): Array<{ uri: string }> {
	return Array.from({ length: count }, (_, i) => ({
		uri: `skill://tedix/skill-${String(i).padStart(4, "0")}/SKILL.md`,
	}));
}

describe("skills-list cursor codec", () => {
	it("round-trips a skill uri through an opaque base64 cursor", () => {
		const uri = "skill://tedix/deploy-widget/SKILL.md";
		const cursor = encodeSkillsListCursor(uri);
		expect(cursor).not.toContain(uri);
		expect(decodeSkillsListCursor(cursor)).toBe(uri);
	});

	it("rejects garbage, foreign base64, empty, and tools/list cursors", () => {
		expect(decodeSkillsListCursor("!!!not-base64!!!")).toBeUndefined();
		expect(decodeSkillsListCursor(btoa("some-other-token"))).toBeUndefined();
		expect(decodeSkillsListCursor("")).toBeUndefined();
		// A tools/list cursor is valid base64 with the wrong prefix — it must
		// not silently anchor a skills page.
		expect(
			decodeSkillsListCursor(encodeToolsListCursor("run_skill_workflow")),
		).toBeUndefined();
	});
});

describe("sortSkillEntriesDeterministically", () => {
	it("sorts by uri ascending byte order regardless of insertion order", () => {
		const shuffled = [
			{ uri: "skill://tedix/zeta/SKILL.md" },
			{ uri: "skill://alpha/SKILL.md" },
			{ uri: "skill://tedix/alpha/SKILL.md" },
		];
		expect(
			sortSkillEntriesDeterministically(shuffled).map((s) => s.uri),
		).toEqual([
			"skill://alpha/SKILL.md",
			"skill://tedix/alpha/SKILL.md",
			"skill://tedix/zeta/SKILL.md",
		]);
	});
});

describe("paginateSortedSkillsList", () => {
	it("returns a catalog at/under the page size whole, with no nextCursor", () => {
		const skills = makeSkills(SKILLS_LIST_PAGE_SIZE);
		const page = paginateSortedSkillsList(skills, undefined);
		expect(page).toEqual({ ok: true, skills });
	});

	it("returns the empty catalog whole (no nextCursor)", () => {
		expect(paginateSortedSkillsList([], undefined)).toEqual({
			ok: true,
			skills: [],
		});
	});

	it("pages a large catalog with no overlap and no gaps", () => {
		const skills = makeSkills(SKILLS_LIST_PAGE_SIZE * 2 + 25);
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = paginateSortedSkillsList(skills, cursor);
			if (!page.ok) throw new Error("unexpected invalid cursor");
			seen.push(...page.skills.map((skill) => skill.uri));
			cursor = page.nextCursor;
			pages += 1;
		} while (cursor !== undefined);
		expect(pages).toBe(3);
		expect(seen).toEqual(skills.map((skill) => skill.uri));
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("walks 2 pages + terminal with an explicit page size", () => {
		const skills = makeSkills(5);
		const first = paginateSortedSkillsList(skills, undefined, 2);
		if (!first.ok) throw new Error("invalid");
		expect(first.skills).toEqual(skills.slice(0, 2));
		expect(first.nextCursor).toBeDefined();

		const second = paginateSortedSkillsList(skills, first.nextCursor, 2);
		if (!second.ok) throw new Error("invalid");
		expect(second.skills).toEqual(skills.slice(2, 4));
		expect(second.nextCursor).toBeDefined();

		const last = paginateSortedSkillsList(skills, second.nextCursor, 2);
		if (!last.ok) throw new Error("invalid");
		expect(last.skills).toEqual(skills.slice(4));
		expect(last.nextCursor).toBeUndefined();
	});

	it("flags undecodable and non-string cursors as invalid", () => {
		const skills = makeSkills(10);
		expect(paginateSortedSkillsList(skills, "not-a-cursor")).toEqual({
			ok: false,
		});
		expect(paginateSortedSkillsList(skills, 42)).toEqual({ ok: false });
		// Invalid cursors stay invalid on an empty catalog too.
		expect(paginateSortedSkillsList([], "not-a-cursor")).toEqual({
			ok: false,
		});
	});

	it("returns an empty terminal page when the cursor is past the end", () => {
		const skills = makeSkills(5);
		const page = paginateSortedSkillsList(
			skills,
			encodeSkillsListCursor("skill://tedix/skill-9999/SKILL.md"),
		);
		expect(page).toEqual({ ok: true, skills: [] });
	});
});
