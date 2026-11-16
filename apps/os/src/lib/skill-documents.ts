import type { SkillEntry } from "@tedix/api-contract/schemas/cognitive";
import { deriveSkillAnatomy } from "@/lib/skill-anatomy";

/*
 * Whether a skill's saved workflow reads or writes documents and sheets,
 * read from the calls its source makes. It names kinds, not particular
 * files: which document a run touched is only known once it has run.
 */

export type SkillDocumentUse = {
	kind: "document" | "sheet";
	access: "reads" | "writes";
};

const READ = /^(get|list|read|search|find)_/;
const WRITE =
	/^(create|set|patch|revise|update|rename|append|write|delete|archive)_/;

export function deriveSkillDocumentUse(
	skill: Pick<
		SkillEntry,
		"content" | "files" | "inputSchema" | "mcpAppBindings" | "tools"
	>,
): SkillDocumentUse[] {
	const found = new Map<string, SkillDocumentUse>();
	const calls = [
		...deriveSkillAnatomy(skill).steps.flatMap((step) => step.toolCalls),
		...(skill.tools ?? []),
	];
	for (const call of calls) {
		const method = call.split(".")[1] ?? "";
		const kind = /sheet/.test(method)
			? "sheet"
			: /(output|document)/.test(method)
				? "document"
				: null;
		if (!kind) continue;
		const access = WRITE.test(method)
			? "writes"
			: READ.test(method)
				? "reads"
				: null;
		if (!access) continue;
		found.set(`${kind}:${access}`, { kind, access });
	}
	return [...found.values()];
}
