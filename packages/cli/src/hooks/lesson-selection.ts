/** Prompt text lives only in this function's call frame; only lesson ids leave it. */
import type { AgentSessionLesson } from "@tedix/api-contract/schemas/agent-session-lessons";
import { isHoldoutSession } from "@tedix/api-contract/utils/lesson-holdout";

const STOP = new Set(
	"the and for with from this that have into please can you our are use should".split(
		" ",
	),
);
function terms(text: string): string[] {
	return text
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 2 && !STOP.has(w));
}
export interface LessonSelection {
	lessons: AgentSessionLesson[];
	/** Includes learned lessons withheld by the stable holdout. */
	selectedLessonIds: string[];
	holdout: boolean;
}

/** BM25 with bounded query size and deterministic ties; no prompt or score is persisted. */
export async function selectPromptLessons(
	lessons: AgentSessionLesson[],
	context: {
		prompt?: string;
		cwd?: string;
		repo?: string;
		workTitle?: string;
		branch?: string;
		sessionId?: string;
		budgetBytes?: number;
		limit?: number;
	},
): Promise<LessonSelection> {
	const query = [
		...new Set(
			terms(
				`${context.cwd ?? ""} ${context.repo ?? ""} ${context.workTitle ?? ""} ${context.branch ?? ""} ${context.prompt?.slice(0, 16000) ?? ""}`,
			),
		),
	].slice(0, 256);
	const documents = lessons.map((lesson) => ({
		lesson,
		words: terms(`${lesson.scope?.topic ?? ""} ${lesson.text}`),
	}));
	const avg =
		documents.reduce((n, d) => n + d.words.length, 0) /
			Math.max(1, documents.length) || 1;
	const frequency = new Map<string, number>();
	for (const d of documents)
		for (const term of new Set(d.words))
			frequency.set(term, (frequency.get(term) ?? 0) + 1);
	const ranked = documents
		.map(({ lesson, words }, index) => {
			const counts = new Map<string, number>();
			for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
			let score = 0;
			for (const term of query) {
				const tf = counts.get(term) ?? 0;
				const df = frequency.get(term) ?? 0;
				if (tf)
					score +=
						(Math.log(1 + (documents.length - df + 0.5) / (df + 0.5)) *
							tf *
							2.2) /
						(tf + 1.2 * (0.25 + (0.75 * words.length) / avg));
			}
			return { lesson, score, index };
		})
		.sort((a, b) => b.score - a.score || a.index - b.index);
	const chosen: AgentSessionLesson[] = [];
	let bytes = 0;
	for (const { lesson } of ranked) {
		const size = Buffer.byteLength(lesson.text, "utf8") + 16;
		if (bytes + size > (context.budgetBytes ?? 2800)) continue;
		chosen.push(lesson);
		bytes += size;
		if (chosen.length >= (context.limit ?? 6)) break;
	}
	const holdout = context.sessionId
		? await isHoldoutSession(context.sessionId)
		: false;
	return {
		lessons: holdout ? chosen.filter((l) => !l.learned) : chosen,
		selectedLessonIds: chosen.map((l) => l.id),
		holdout,
	};
}
