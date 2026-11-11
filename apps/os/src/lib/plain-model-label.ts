/**
 * A model's name as a person would say it. The server labels models by where
 * they run and their full id ("Workers AI: @cf/moonshotai/kimi-k2.7-code");
 * the picker shows "Kimi K2.7 Code" and keeps the full label as a tooltip.
 */
const UPPER = new Set(["gpt", "ai", "oss", "xl", "hd", "llm", "qwq"]);

export function plainModelLabel(label: string): string {
	const afterPrefix = label.includes(": ")
		? label.slice(label.indexOf(": ") + 2)
		: label;
	const name = afterPrefix.split("/").pop() ?? afterPrefix;
	const words = name
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((word) =>
			UPPER.has(word.toLowerCase())
				? word.toUpperCase()
				: /^[a-z]/.test(word)
					? word[0]!.toUpperCase() + word.slice(1)
					: word,
		);
	return words.join(" ") || label;
}
