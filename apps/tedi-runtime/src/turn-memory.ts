import type { TurnMemory } from "@tedix/api-contract/schemas/turn-memory";
import { memorySourceReferences } from "@tedix/context-core/memory-freshness";
import { wrapUntrustedInput } from "./untrusted-input";

/** Canonical refresh is awaited independently of the optional semantic recall budget. */
export async function refreshTurnMemory(input: {
	userText: string;
	remembered: string;
	history?: unknown;
	refresh: (references: string[]) => Promise<TurnMemory>;
}): Promise<string> {
	const references = memorySourceReferences(
		`${input.userText}\n${input.remembered}\n${JSON.stringify(input.history ?? [])}`,
	);
	try {
		const state = await input.refresh(references);
		return [
			"# Preferences and current task state",
			"Remembered task state is historical. Use the live state below before acting. Completed or cancelled Work stays closed. An elapsed deadline does not authorize action. A snapshot is not approval or an admitted Attempt; verify authorization at execution. For references not resolved here, read their canonical source before acting or chasing anyone.",
			wrapUntrustedInput(JSON.stringify(state), "turn_memory"),
		].join("\n\n");
	} catch {
		return "# Current task state unavailable\n\nLive refresh failed. Remembered preferences remain applicable, but task status, approvals and deadlines in memory are unverified. Do not act on or chase remembered tasks until their canonical source can be read. Missing state is not proof of completion or absence.";
	}
}
