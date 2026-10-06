export interface QuestionOption {
	label: string;
	value: string;
}

export interface ParsedQuestion {
	prompt: string;
	options: QuestionOption[];
}

const OPTION_LINE = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;

/**
 * Extract lightweight choices from a kernel ask_human question. The kernel
 * contract remains prose-first, so unstructured questions simply render a
 * focused free-text modal.
 */
export function parseQuestionPrompt(raw: string): ParsedQuestion {
	const lines = raw
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	const options: QuestionOption[] = [];
	const promptLines: string[] = [];
	for (const line of lines) {
		const match = line.match(OPTION_LINE);
		if (match?.[1]) {
			const label = match[1].trim();
			if (!options.some((option) => option.value === label)) {
				options.push({ label, value: label });
			}
		} else {
			promptLines.push(line.trim());
		}
	}
	return {
		prompt: promptLines.join("\n") || raw.trim(),
		options: options.slice(0, 8),
	};
}
