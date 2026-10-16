import { parseDocument } from "yaml";

/** Edit only the schedule policy; keep workflow files and the body intact. */
export function setFactoryScheduleEnabled(
	content: string,
	enabled: boolean,
): string {
	const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(content);
	if (!match) throw new Error("Factory lane has no frontmatter");
	const doc = parseDocument(match[2]!);
	if (doc.errors.length || !doc.hasIn(["capabilities", "schedule", "cron"])) {
		throw new Error("Factory lane has no valid schedule policy");
	}
	if (enabled) doc.deleteIn(["capabilities", "schedule", "enabled"]);
	else doc.setIn(["capabilities", "schedule", "enabled"], false);
	const newline = match[1]!.includes("\r\n") ? "\r\n" : "\n";
	const yaml = doc.toString().trimEnd().replace(/\n/g, newline);
	return match[1] + yaml + match[3] + content.slice(match[0].length);
}
