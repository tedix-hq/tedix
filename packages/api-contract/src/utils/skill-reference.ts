/**
 * The one grammar for a composer skill reference.
 *
 * A skill reference is a durable, readable line in the message's own content —
 * `/skill <slug>` — rather than browser-only composer state. It survives in
 * D1, in the transcript, and in every replay of the turn, the same way
 * `[[tedix-context:…]]` does for a workspace handle.
 *
 * It lives in the shared contract package because BOTH ends need the identical
 * grammar: the OS composer writes the line, and the kernel's operator-slash
 * parser (`detectOperatorSlashCommand`) reads it. A second copy of this regex
 * in the frontend is exactly the drift that would make a picker insertion mean
 * nothing on the server.
 */

import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * Reserved verb. `OPERATOR_SLASH_COMMANDS` in the kernel parser must never
 * claim it: a skill reference is a REFERENCE the operator deliberately put in
 * the message, not a command they expected some other surface to run. Claiming
 * it would refuse every picker insertion.
 */
export const SKILL_REFERENCE_VERB = "skill";

/**
 * Slugs are the `skill_entries.slug` shape: lowercase alphanumerics and
 * dashes. Anything else is prose and is left alone.
 */
const SKILL_REFERENCE_LINE = /^\/skill[ \t]+([a-z0-9][a-z0-9-]*)$/;

/** The canonical text a picker confirmation inserts. */
export function formatSkillReference(slug: string): string {
	return `/${SKILL_REFERENCE_VERB} ${slug}`;
}

/**
 * The slug on a line that is EXACTLY a skill reference, else `undefined`.
 *
 * Whole lines only. Prose that merely mentions `/skill foo` mid-sentence is
 * untouched — the same conservatism `detectOperatorSlashCommand` applies to a
 * leading `/`, so an ordinary message is never silently reinterpreted.
 */
export function skillReferenceOnLine(line: string): string | undefined {
	return SKILL_REFERENCE_LINE.exec(line.trim())?.[1];
}

type MarkdownNode = {
	type: string;
	children?: MarkdownNode[];
	position?: { start: { line: number }; end: { line: number } };
};

/** Zero-based reference lines outside Markdown code, also used by draft editing. */
export function parseSkillReferenceLines(content: string): Map<number, string> {
	const references = new Map<number, string>();
	for (const [index, line] of content.split(/\r\n|\r|\n/).entries()) {
		const slug = skillReferenceOnLine(line);
		if (slug !== undefined) references.set(index, slug);
	}
	if (references.size === 0) return references;
	// Use the Markdown grammar for nested, indented and unclosed code fences.
	const pending: MarkdownNode[] = [fromMarkdown(content)];
	while (pending.length > 0) {
		const node = pending.pop()!;
		if ((node.type === "code" || node.type === "inlineCode") && node.position) {
			for (
				let line = node.position.start.line;
				line <= node.position.end.line;
				line++
			) {
				references.delete(line - 1);
			}
		}
		for (const child of node.children ?? []) pending.push(child);
	}
	return references;
}

/** Every referenced slug, in first-seen order, deduplicated. */
export function parseSkillReferences(content: string): string[] {
	return [...new Set(parseSkillReferenceLines(content).values())];
}

/**
 * The first non-blank line that is not a skill reference.
 *
 * The composer writes its references ABOVE the operator's own prose, so a
 * naive "inspect the first line" read sees `/skill <slug>` and lets a real
 * operator command on the next line through unrefused — reopening exactly the
 * hole the refusal guard was added to close. Callers that classify the leading
 * token must start here.
 */
export function firstNonSkillReferenceLine(content: string): string {
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		if (skillReferenceOnLine(trimmed) !== undefined) continue;
		return trimmed;
	}
	return "";
}
