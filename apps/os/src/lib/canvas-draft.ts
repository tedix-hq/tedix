import type {
	OsOutputContent,
	OsOutputKind,
} from "@tedix/api-contract/schemas/os-workspaces";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { normalizeOutputContent } from "@/lib/output-models";

/**
 * Pure draft parsing for the Canvas document panel: validate the room's shared
 * text before it may open a structured editor or commit a canonical revision.
 * None of these helpers touch React, the collaboration client, or the network.
 *
 * There is no immutable-base bookkeeping here, because the room carries no
 * second copy of D1 truth to date-stamp. A commit's CAS base is simply the
 * canonical revision the panel loaded, which it already has from its own
 * query — no room metadata is read back to establish it.
 */

export type ParsedDraft =
	| { ok: true; value: unknown }
	| { ok: false; error: string };

export function parseDraft(text: string): ParsedDraft {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** The router refuses a body whose kind differs from the output's; catch it before sending. */
export function outputKindError(
	value: unknown,
	kind: OsOutputKind,
): string | null {
	const draftedKind =
		typeof value === "object" && value !== null && "kind" in value
			? (value as { kind?: unknown }).kind
			: undefined;
	return draftedKind === kind
		? null
		: `The draft must keep "kind": "${kind}" — this output is a ${kind}.`;
}

export type OutputDraftIssue =
	| "invalid_json"
	| "invalid_content"
	| "wrong_kind";

export type ParsedOutputDraft =
	| { ok: true; content: OsOutputContent }
	| { ok: false; issue: OutputDraftIssue };

/** Parse shared output bytes without discarding the reason a semantic editor cannot open. */
export function parseOutputDraft(
	text: string,
	expectedKind: OsOutputKind,
): ParsedOutputDraft {
	const parsed = parseDraft(text);
	if (!parsed.ok) return { ok: false, issue: "invalid_json" };
	const content = OsOutputContentSchema.safeParse(parsed.value);
	if (!content.success) return { ok: false, issue: "invalid_content" };
	if (content.data.kind !== expectedKind) {
		return { ok: false, issue: "wrong_kind" };
	}
	return { ok: true, content: normalizeOutputContent(content.data) };
}
