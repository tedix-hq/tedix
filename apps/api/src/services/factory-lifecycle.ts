import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/skill-schedule";
import { parseDocument } from "yaml";

/**
 * Edit only the schedule policy inside frontmatter; keep workflow files and
 * the body intact.
 */
function editFactorySchedule(
	content: string,
	edit: (doc: ReturnType<typeof parseDocument>) => void,
): string {
	const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(content);
	if (!match) throw new Error("Factory lane has no frontmatter");
	const doc = parseDocument(match[2]!);
	if (doc.errors.length || !doc.hasIn(["capabilities", "schedule", "cron"])) {
		throw new Error("Factory lane has no valid schedule policy");
	}
	edit(doc);
	const newline = match[1]!.includes("\r\n") ? "\r\n" : "\n";
	const yaml = doc.toString().trimEnd().replace(/\n/g, newline);
	return match[1] + yaml + match[3] + content.slice(match[0].length);
}

/** Edit only the schedule policy; keep workflow files and the body intact. */
export function setFactoryScheduleEnabled(
	content: string,
	enabled: boolean,
): string {
	return editFactorySchedule(content, (doc) => {
		if (enabled) doc.deleteIn(["capabilities", "schedule", "enabled"]);
		else doc.setIn(["capabilities", "schedule", "enabled"], false);
	});
}

/** Change only the cadence field of the schedule policy. Throws on a cron the scheduler could never fire. */
export function setFactoryScheduleCron(content: string, cron: string): string {
	nextSkillScheduleFireAt(cron, Date.now());
	return editFactorySchedule(content, (doc) => {
		doc.setIn(["capabilities", "schedule", "cron"], cron);
	});
}
