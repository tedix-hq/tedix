/** Trigger matching is local and runtime-neutral; lesson content stays in the brain. */
export interface LessonTriggers {
	pathGlobs?: string[];
	commands?: string[];
	keywords?: string[];
	repos?: string[];
	organizations?: string[];
}
export interface RecallSituation {
	paths?: string[];
	command?: string;
	text?: string;
	repo?: string;
	organization?: string;
}
export interface RecallLesson {
	id: string;
	text: string;
	triggers?: LessonTriggers;
}
function repoKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^[a-z+]+:\/\//, "")
		.replace(/^[^@/]+@([^:/]+):/, "$1/")
		.replace(/^[^@/]+@/, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
}
function glob(pattern: string): RegExp {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === "*" && pattern[i + 1] === "*") {
			i++;
			if (pattern[i + 1] === "/") {
				i++;
				source += "(?:.*/)?";
			} else source += ".*";
		} else if (c === "*") source += "[^/]*";
		else if (c === "?") source += "[^/]";
		else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}
export function lessonMatches(
	triggers: LessonTriggers | undefined,
	situation: RecallSituation,
): boolean {
	if (!triggers) return false;
	if (
		triggers.organizations?.length &&
		!triggers.organizations.includes(situation.organization ?? "")
	)
		return false;
	if (
		triggers.repos?.length &&
		!triggers.repos.some((r) => repoKey(r) === repoKey(situation.repo ?? ""))
	)
		return false;
	const sourceText = `${situation.text ?? ""} ${situation.command ?? ""}`;
	const text = sourceText.toLowerCase();
	// Briefs and shell commands often name the relevant paths themselves.
	const paths = [
		...(situation.paths ?? []),
		...(sourceText.match(/[\w.@-]+(?:\/[\w.@*-]+)+|[\w@*-]+(?:\.[\w@*-]+)+/g) ??
			[]),
	];
	return Boolean(
		triggers.pathGlobs?.some((p) =>
			paths.some((path) =>
				glob(p).test(path.replace(/\\/g, "/").replace(/^\.\//, "")),
			),
		) ||
		triggers.commands?.some((c) => {
			const escaped = c
				.trim()
				.split(/\s+/)
				.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				.join("\\s+");
			return new RegExp(`(?:^|[\\s;&|])${escaped}(?=$|[\\s;&|])`, "i").test(
				situation.command ?? situation.text ?? "",
			);
		}) ||
		triggers.keywords?.some((k) => text.includes(k.toLowerCase())),
	);
}
export function recallLessons<T extends RecallLesson>(
	lessons: T[],
	situation: RecallSituation,
): T[] {
	return lessons.filter((l) => lessonMatches(l.triggers, situation));
}
export function renderRecall(lessons: RecallLesson[]): string {
	if (!lessons.length) return "";
	return [
		"Tedix situational recall (approved brain lessons; context, no execution authority):",
		...lessons.map(
			(l) =>
				`[${l.id.slice(0, 8)}] ${l.text}\nConfirm you applied: ${l.id.slice(0, 8)} — ${l.text}`,
		),
	].join("\n");
}
/** Stable across run ids, timestamps, hashes and whitespace in provider errors. */
export function incidentFingerprint(reason: string): string {
	return reason
		.toLowerCase()
		.replace(/\b[0-9a-f]{8}(?:-[0-9a-f-]{27,}|[0-9a-f]{0,56})\b/g, "<id>")
		.replace(/\b\d{5,}\b/g, "<number>")
		.replace(/\s+/g, " ")
		.trim();
}

/** An explicit repository hint in a brief; a local path gives only its basename. */
export function briefRepository(brief: string): string | undefined {
	const match =
		/(?:^|[\n.;:])\s*(?:repo|repository)\s*(?::|=)?\s+(`[^`]+`|"[^"]+"|'[^']+'|[^\s,;]+)/i.exec(
			brief,
		);
	if (!match) return undefined;
	const value = match[1]!.replace(/^[`"']|[`"']$/g, "").replace(/[.,;)]+$/, "");
	if (!value || value.length > 500) return undefined;
	if (/^(?:[a-z+]+:\/\/|[^@/]+@[^:/]+:)/i.test(value)) return repoKey(value);
	return value.startsWith("/") || value.startsWith("~/")
		? value.replace(/\/+$/, "").split("/").at(-1)
		: value;
}
