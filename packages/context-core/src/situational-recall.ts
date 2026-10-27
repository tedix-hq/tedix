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
// Bound free-text hint extraction; explicit repository and path constraints stay intact.
const MAX_RECALL_HINT_LENGTH = 64 * 1024;

function withoutTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === "/") end--;
	return value.slice(0, end);
}

function repoKey(value: string): string {
	return withoutTrailingSlashes(
		value
			.trim()
			.toLowerCase()
			.replace(/^[a-z+]+:\/\//, "")
			.replace(/^[^@/]+@([^:/]+):/, "$1/")
			.replace(/^[^@/]+@/, "")
			.replace(/\.git$/, ""),
	);
}
function textPaths(text: string): string[] {
	text = text.slice(0, MAX_RECALL_HINT_LENGTH);
	if (!/[./]/.test(text)) return [];
	const paths: string[] = [];
	// Sticky matches cannot search ahead; separators never occur in segments.
	const slashPath = /[\w.@-]+(?:\/[\w.@*-]+)+/y;
	const dottedPath = /[\w@*-]+(?:\.[\w@*-]+)+/y;
	const slashSegment = /[\w.@-]*/y;
	const dotSegment = /[\w@*-]*/y;
	const pathStart = /[\w.@*-]/g;
	let slashFailedUntil = 0;
	let dotFailedUntil = 0;
	for (let i = 0; i < text.length;) {
		// Neither path grammar can start in a run of separators or whitespace.
		pathStart.lastIndex = i;
		const next = pathStart.exec(text);
		if (!next) break;
		i = next.index;
		let match: RegExpExecArray | null = null;
		if (i >= slashFailedUntil) {
			slashPath.lastIndex = i;
			match = slashPath.exec(text);
			// A failed segment cannot succeed at any of its suffixes. Skip retries
			// even when a dotted match consumes only part of that segment.
			if (!match) {
				slashSegment.lastIndex = i;
				slashSegment.test(text);
				slashFailedUntil = slashSegment.lastIndex;
			}
		}
		if (!match && i >= dotFailedUntil) {
			dottedPath.lastIndex = i;
			match = dottedPath.exec(text);
			if (!match) {
				dotSegment.lastIndex = i;
				dotSegment.test(text);
				dotFailedUntil = dotSegment.lastIndex;
			}
		}
		if (match) {
			paths.push(match[0]);
			i += match[0].length;
		} else i = Math.max(i + 1, Math.min(slashFailedUntil, dotFailedUntil));
	}
	return paths;
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
	const paths = [...(situation.paths ?? []), ...textPaths(sourceText)];
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
	brief = brief.slice(0, MAX_RECALL_HINT_LENGTH);
	let raw: string | undefined;
	// Newlines are boundaries themselves; excluding them from whitespace keeps
	// a failed header search from retrying suffixes of the same whitespace run.
	const repoHeader = /(?:^|[\n.;:])[^\S\n]*(?:repository|repo)/gi;
	const whitespace = /\s*/y;
	while (repoHeader.test(brief)) {
		let end = repoHeader.lastIndex;
		const afterHeader = end;
		whitespace.lastIndex = end;
		whitespace.test(brief);
		end = whitespace.lastIndex;
		const beforeSeparator = end;
		if (brief[end] === ":" || brief[end] === "=") {
			end++;
			const afterSeparator = end;
			whitespace.lastIndex = end;
			whitespace.test(brief);
			end = whitespace.lastIndex;
			if (end === afterSeparator) {
				if (beforeSeparator === afterHeader) continue;
				end = beforeSeparator;
			}
		} else if (end === afterHeader) continue;
		raw = /^(?:`[^`]+`|"[^"]+"|'[^']+'|[^\s,;]+)/.exec(brief.slice(end))?.[0];
		if (raw === undefined && beforeSeparator > afterHeader) {
			raw = /^(?:`[^`]+`|"[^"]+"|'[^']+'|[^\s,;]+)/.exec(
				brief.slice(beforeSeparator),
			)?.[0];
		}
		if (raw !== undefined) break;
	}
	if (raw === undefined) return undefined;
	const unquoted = raw.replace(/^[`"']|[`"']$/g, "");
	let end = unquoted.length;
	while (end > 0 && /[.,;)]/.test(unquoted[end - 1]!)) end--;
	const value = unquoted.slice(0, end);
	if (!value || value.length > 500) return undefined;
	if (/^(?:[a-z+]+:\/\/|[^@/]+@[^:/]+:)/i.test(value)) return repoKey(value);
	return value.startsWith("/") || value.startsWith("~/")
		? withoutTrailingSlashes(value).split("/").at(-1)
		: value;
}
