import type { UnclassifiedWriteCapabilityItem } from "@tedix/db/queries/catalog/write-capability";
import {
	DESTRUCTIVE_VERBS,
	WRITE_ONLY_VERBS,
} from "../rpc/routers/kernel/write-tool-policy";

const destructive = new Set<string>(DESTRUCTIVE_VERBS);
const write = new Set<string>(WRITE_ONLY_VERBS);

/** Split a tool name into lowercase words, camelCase included. */
export function toolNameWords(value: string): string[] {
	return value
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/);
}

/**
 * What a tool's name suggests when nobody declared its class. This is the
 * guess the gates fall back on today; it is recorded, never stored on the
 * row, because a wrong guess written down would read as a declaration.
 */
export function guessToolClassFromName(
	toolId: string,
): "destructive" | "write" | "no_write_verb" {
	const words = toolNameWords(toolId);
	if (words.some((word) => destructive.has(word))) return "destructive";
	if (words.some((word) => write.has(word))) return "write";
	return "no_write_verb";
}

export type UndeclaredToolClassSummary = {
	total: number;
	/** Annotations state the answer; a re-sync writes it. */
	fromAnnotations: { read: number; write: number; destructive: number };
	/** Only the name is left to go on. Each needs an owner's declaration. */
	fromNameGuess: { destructive: number; write: number; no_write_verb: number };
};

/** Sort tools with no declared write class by how today's logic reads them. */
export function summarizeUndeclaredToolClasses(
	items: readonly Pick<
		UnclassifiedWriteCapabilityItem,
		"toolId" | "derivable"
	>[],
): UndeclaredToolClassSummary {
	const summary: UndeclaredToolClassSummary = {
		total: items.length,
		fromAnnotations: { read: 0, write: 0, destructive: 0 },
		fromNameGuess: { destructive: 0, write: 0, no_write_verb: 0 },
	};
	for (const item of items) {
		if (item.derivable) summary.fromAnnotations[item.derivable]++;
		else summary.fromNameGuess[guessToolClassFromName(item.toolId)]++;
	}
	return summary;
}
