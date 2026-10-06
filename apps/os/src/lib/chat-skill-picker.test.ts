import type { SkillEntry } from "@tedix/api-contract/schemas/cognitive";
import {
	formatSkillReference,
	parseSkillReferences,
} from "@tedix/api-contract/utils/skill-reference";
import { describe, expect, it } from "vite-plus/test";
import {
	composerReachableSkills,
	draftPickerTrigger,
	filterComposerSkills,
	insertSkillReference,
	removeSkillReference,
	skillPickerTrigger,
} from "@/lib/chat-skill-picker";

type Row = Parameters<typeof composerReachableSkills>[0][number];

/** Spread-merged, never `??`-merged: an explicit `null` slug or lifecycle is
 *  exactly the case under test and a nullish default would erase it. */
function row(overrides: Partial<SkillEntry> = {}): Row {
	return {
		id: "skill-1",
		title: "Deploy runbook",
		slug: "deploy-runbook",
		summary: "How a surface ships.",
		tediId: null,
		visibility: "org",
		lifecycleState: "active",
		...overrides,
	};
}

describe("composer skill scope", () => {
	it("offers only the rows a Home turn can resolve", () => {
		const reachable = composerReachableSkills([
			row({ id: "a", slug: "org-shared", visibility: "org" }),
			row({ id: "b", slug: "org-shared-alt", visibility: "shared" }),
			// The admin lens returns these three; a Home turn cannot reach any.
			row({ id: "c", slug: "tedi-owned", tediId: "tedi-cto" }),
			row({ id: "d", slug: "org-private", visibility: "private" }),
			row({ id: "e", slug: "unfinished", lifecycleState: "draft" }),
		]);
		expect(reachable.map((skill) => skill.slug)).toEqual([
			"org-shared",
			"org-shared-alt",
		]);
	});

	it("drops an unclassified lifecycle the way the SQL predicate does", () => {
		// `lifecycle_state != 'draft'` is NULL for a NULL column, so the server
		// drops the row. Offering it here would advertise a skill the runtime
		// read never returns.
		expect(
			composerReachableSkills([row({ lifecycleState: null })]),
		).toHaveLength(0);
	});

	it("keeps an archived skill out of the picker", () => {
		expect(
			composerReachableSkills([row({ lifecycleState: "archived" })]),
		).toHaveLength(0);
	});

	it("skips a row with no slug, because a reference needs one", () => {
		expect(composerReachableSkills([row({ slug: null })])).toHaveLength(0);
	});
});

describe("skill picker trigger", () => {
	it("opens on a bare slash token and carries the typed query", () => {
		expect(skillPickerTrigger("/")).toBe("");
		expect(skillPickerTrigger("/dep")).toBe("dep");
		expect(draftPickerTrigger("please check\n/dep")).toBe("dep");
	});

	it("stays closed for prose and for the existing composer commands", () => {
		expect(skillPickerTrigger("/read app.tool {}")).toBeNull();
		expect(skillPickerTrigger("summarize the run set")).toBeNull();
		expect(skillPickerTrigger("/Users/owner/x.md")).toBeNull();
		expect(draftPickerTrigger("/skill deploy-runbook\n\nship it")).toBeNull();
	});
});

describe("skill matching", () => {
	const skills = composerReachableSkills([
		row({ id: "a", slug: "deploy-runbook", title: "Deploy runbook" }),
		row({ id: "b", slug: "audit-costs", title: "Audit deploy costs" }),
		row({ id: "c", slug: "write-adr", title: "Write an ADR" }),
	]);

	it("matches slug or title and ranks a slug prefix first", () => {
		expect(filterComposerSkills(skills, "deploy").map((s) => s.slug)).toEqual([
			"deploy-runbook",
			"audit-costs",
		]);
	});

	it("bounds the list so the picker is never a catalog wall", () => {
		const many = composerReachableSkills(
			Array.from({ length: 30 }, (_, index) =>
				row({ id: `s${index}`, slug: `skill-${index}` }),
			),
		);
		expect(filterComposerSkills(many, "")).toHaveLength(8);
	});
});

describe("draft editing", () => {
	it("consumes the trigger token and hoists a canonical reference", () => {
		const draft = insertSkillReference(
			"ship the widget\n/dep",
			"deploy-runbook",
		);
		expect(draft).toBe("/skill deploy-runbook\n\nship the widget");
		expect(parseSkillReferences(draft)).toEqual(["deploy-runbook"]);
	});

	it("accumulates references without duplicating one", () => {
		let draft = insertSkillReference("/", "deploy-runbook");
		draft = insertSkillReference(`${draft}audit`, "audit-costs");
		draft = insertSkillReference(`${draft}\n/dep`, "deploy-runbook");
		expect(parseSkillReferences(draft)).toEqual([
			"deploy-runbook",
			"audit-costs",
		]);
		expect(draft).toContain("audit");
	});

	it("removes one pill and collapses the block when the last one goes", () => {
		const draft = "/skill deploy-runbook\n/skill audit-costs\n\nship it";
		const one = removeSkillReference(draft, "audit-costs");
		expect(parseSkillReferences(one)).toEqual(["deploy-runbook"]);
		expect(removeSkillReference(one, "deploy-runbook")).toBe("ship it");
	});

	it("leaves prose that merely mentions a reference alone", () => {
		const draft = "we use /skill deploy-runbook in the composer";
		expect(parseSkillReferences(draft)).toEqual([]);
		expect(removeSkillReference(draft, "deploy-runbook")).toBe(draft);
	});

	it("formats exactly what the parser reads back", () => {
		expect(parseSkillReferences(formatSkillReference("audit-costs"))).toEqual([
			"audit-costs",
		]);
	});
});
