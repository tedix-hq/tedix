import diff from "fast-diff";
import type { WorkProposal } from "@tedix/api-contract/schemas/work-interactions";

/** Compare whole words so the review never splices letters from two drafts. */
export function cardRevisionDiff(
	before: string,
	after: string,
	granularity: "word" | "paragraph" = "word",
): [number, string][] {
	const tokens: string[] = [];
	const ids = new Map<string, string>();
	const encode = (text: string) =>
		(text.match(granularity === "word" ? /\s+|\S+/g : /[^\n]+|\n+/g) ?? [])
			.map((token) => {
				let id = ids.get(token);
				if (!id) {
					tokens.push(token);
					id = String.fromCharCode(tokens.length);
					ids.set(token, id);
				}
				return id;
			})
			.join("");
	const left = encode(before);
	const right = encode(after);
	if (tokens.length >= 0xd800)
		return [
			[-1, before],
			[1, after],
		];
	return diff(left, right).map(([kind, text]) => [
		kind,
		[...text].map((id) => tokens[id.charCodeAt(0) - 1]).join(""),
	]);
}

export interface CardRevisionHunk {
	index: number;
	unchanged: boolean;
	original: string;
	replacement: string;
	canKeep?: boolean;
}

export function cardRevisionHunks(
	before: string,
	after: string,
): CardRevisionHunk[] {
	const hunks: CardRevisionHunk[] = [];
	for (const [kind, text] of cardRevisionDiff(before, after, "paragraph")) {
		const prior = hunks.at(-1);
		if (kind !== 0 && prior && !prior.unchanged) {
			if (kind < 0) prior.original += text;
			else prior.replacement += text;
		} else
			hunks.push({
				index: hunks.length,
				unchanged: kind === 0,
				original: kind <= 0 ? text : "",
				replacement: kind >= 0 ? text : "",
			});
	}
	return hunks;
}

export function keepOriginalHunks(
	hunks: CardRevisionHunk[],
	kept: number[],
): string {
	return hunks
		.map((hunk) =>
			kept.includes(hunk.index) ? hunk.original : hunk.replacement,
		)
		.join("");
}

/** Match plan wording by stable Work identity, never by the displayed row. */
export function proposalRevisionHunks(
	before: WorkProposal,
	after: WorkProposal,
) {
	const originals = [before.item, ...before.children];
	const revised = [after.item, ...after.children];
	return revised
		.flatMap((item) => {
			const matches = originals.filter(
				(original) => original.sourceIntentId === item.sourceIntentId,
			);
			const original = matches.length === 1 ? matches[0] : undefined;
			return (["title", "description"] as const).map((field) => ({
				sourceIntentId: item.sourceIntentId,
				field,
				canKeep:
					Boolean(original) &&
					revised.filter((row) => row.sourceIntentId === item.sourceIntentId)
						.length === 1,
				original: original?.[field] ? `${original[field]}\n\n` : "",
				replacement: item[field] ? `${item[field]}\n\n` : "",
				unchanged: (original?.[field] ?? "") === (item[field] ?? ""),
			}));
		})
		.map((hunk, index) => ({ ...hunk, index }));
}

export function keepOriginalProposalHunks(
	before: WorkProposal,
	after: WorkProposal,
	kept: number[],
): WorkProposal {
	const hunks = proposalRevisionHunks(before, after);
	const originals = [before.item, ...before.children];
	const copy = (item: WorkProposal["item"]) => {
		const result = { ...item };
		for (const hunk of hunks) {
			if (
				!hunk.canKeep ||
				!kept.includes(hunk.index) ||
				hunk.sourceIntentId !== item.sourceIntentId
			)
				continue;
			const value = originals.find(
				(original) => original.sourceIntentId === item.sourceIntentId,
			)![hunk.field];
			if (value === undefined) delete result.description;
			else result[hunk.field] = value;
		}
		return result;
	};
	return {
		...after,
		item: copy(after.item),
		children: after.children.map(copy),
	};
}

export function proposalRevisionBody(proposal: WorkProposal): string {
	return [
		...[proposal.item, ...proposal.children].map((item) =>
			[item.title, item.description].filter(Boolean).join("\n"),
		),
		...(proposal.start ? [`First: ${proposal.start.brief}`] : []),
	].join("\n\n");
}
