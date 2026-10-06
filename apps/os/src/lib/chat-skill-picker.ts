import type {
	SkillEntry,
	SkillLifecycleState,
} from "@tedix/api-contract/schemas/cognitive";
import {
	formatSkillReference,
	parseSkillReferences,
	skillReferenceOnLine,
} from "@tedix/api-contract/utils/skill-reference";

/**
 * Composer skill picker — the pure half.
 *
 * The grammar of a reference itself lives in
 * `@tedix/api-contract/utils/skill-reference` and is shared with the kernel's
 * operator-slash parser. Nothing here re-implements it; this module owns only
 * what the composer adds on top: which skills are offerable, which ones a
 * typed token matches, and how a confirmation edits the draft.
 */

/** The compact projection a picker row needs. Never the SKILL.md body. */
export type ComposerSkill = {
	id: string;
	slug: string;
	title: string;
	summary: string | null;
	lifecycleState: SkillLifecycleState | null;
};

/**
 * Progressive disclosure, deliberately. The picker shows a short summary and
 * nothing else; the full body is a `read_skill` the runtime performs on demand
 * once the reference names a skill. Injecting an org's whole catalog into the
 * prompt measurably degraded task performance, so the picker is a lookup, not
 * a catalog wall — hence both the summary-only projection and this ceiling.
 */
export const SKILL_PICKER_MATCH_LIMIT = 8;

/** Reachable but never offered as a NEW reference. */
const NOT_OFFERABLE: ReadonlySet<SkillLifecycleState> = new Set(["archived"]);

type SkillCatalogRow = Pick<
	SkillEntry,
	"id" | "title" | "visibility" | "slug" | "summary" | "tediId"
> & { lifecycleState?: SkillLifecycleState | null };

/**
 * The skills a Home turn can actually reach.
 *
 * Verified against the server rather than assumed. The catalog read this
 * picker shares with the admin surface (`skills.listByOrg` with no `tediId`)
 * runs `listAllSkillsForOrg` — the ADMIN lens: every row in the organization,
 * including another tedi's `private` skills and unfinished drafts. The lens a
 * RUNTIME read applies is `readableSkillCondition`
 * (`packages/db/src/queries/cognitive/skill-crud.ts`): org-level rows only,
 * `tediId IS NULL AND visibility != 'private'`, widened by the calling tedi's
 * own rows, and `listSkillsByTedi` additionally drops `draft`.
 *
 * The OS composer posts to Home/kernel, which has no single fixed tedi at
 * compose time, so the honest lens is the UN-widened one. Offering another
 * tedi's private or draft skill would write a reference into a durable message
 * that the turn cannot resolve — the mirror image of the org-scoped-skills-are-
 * invisible-to-tedi-queries defect.
 *
 * `draft` is excluded the way SQL excludes it: `lifecycle_state != 'draft'` is
 * NULL for a NULL column and drops that row too, so an unclassified skill is
 * not offerable either.
 */
export function composerReachableSkills(
	entries: readonly SkillCatalogRow[],
): ComposerSkill[] {
	const reachable: ComposerSkill[] = [];
	for (const entry of entries) {
		if (entry.tediId != null) continue;
		if (entry.visibility === "private") continue;
		const slug = entry.slug?.trim();
		if (!slug) continue;
		const lifecycleState = entry.lifecycleState ?? null;
		if (lifecycleState === null || lifecycleState === "draft") continue;
		if (NOT_OFFERABLE.has(lifecycleState)) continue;
		reachable.push({
			id: entry.id,
			slug,
			title: entry.title,
			summary: entry.summary ?? null,
			lifecycleState,
		});
	}
	return reachable;
}

/**
 * A bare slash token on a line opens the picker.
 *
 * Returns the typed query (possibly `""` for a lone `/`), or `null` when the
 * line is not a trigger. A line with a space in it — `/read app.tool {…}`, or
 * any prose — is never a trigger, so the existing composer commands and
 * ordinary typing are untouched.
 */
export function skillPickerTrigger(line: string): string | null {
	const match = /^\/([a-z0-9-]*)$/.exec(line);
	return match ? (match[1] ?? "") : null;
}

/** The trigger on the line the operator is typing, i.e. the draft's last. */
export function draftPickerTrigger(draft: string): string | null {
	const lines = draft.split("\n");
	return skillPickerTrigger(lines[lines.length - 1] ?? "");
}

/** Slug/title substring match, bounded. Ranked slug-first so an exact slug
 *  the operator already knows never falls off the end of the list. */
export function filterComposerSkills(
	skills: readonly ComposerSkill[],
	query: string,
	limit: number = SKILL_PICKER_MATCH_LIMIT,
): ComposerSkill[] {
	const needle = query.trim().toLowerCase();
	const matches = needle
		? skills.filter(
				(skill) =>
					skill.slug.includes(needle) ||
					skill.title.toLowerCase().includes(needle),
			)
		: [...skills];
	matches.sort((a, b) => {
		const rank = (skill: ComposerSkill) =>
			needle && skill.slug.startsWith(needle) ? 0 : 1;
		return rank(a) - rank(b);
	});
	return matches.slice(0, limit);
}

/**
 * Confirm a pick: consume the trigger token the operator was typing and hoist
 * the canonical reference into a block above their prose, so the durable
 * message reads as "these skills, then the request".
 */
export function insertSkillReference(draft: string, slug: string): string {
	const lines = draft.split("\n");
	if (skillPickerTrigger(lines[lines.length - 1] ?? "") !== null) lines.pop();
	const slugs = parseSkillReferences(draft);
	if (!slugs.includes(slug)) slugs.push(slug);
	const body = lines
		.filter((line) => skillReferenceOnLine(line) === undefined)
		.join("\n")
		.trim();
	const head = slugs.map(formatSkillReference).join("\n");
	return `${head}\n\n${body}`;
}

/** Remove one pill's reference, collapsing the blank block it leaves behind. */
export function removeSkillReference(draft: string, slug: string): string {
	return draft
		.split("\n")
		.filter((line) => skillReferenceOnLine(line) !== slug)
		.join("\n")
		.replace(/^\n+/, "");
}
