import {
	AttentionViewInputSchema,
	DeckProjectionSchema,
	DeckCardSchema,
	DecideDeckCardInputSchema,
	ForYouProjectionSchema,
} from "@tedix/api-contract/schemas/attention";
import { normalizeCodeResult, truncationErrorMessage } from "./code-result";
import { errorText } from "./format";
import { callConfiguredNativeTool, type NativeToolContext } from "./work";

export function attentionUsage(): string {
	return `tedix deck list [--project <uuid>] [--limit <n>] [--json]
tedix deck show <card-id> [--json]
tedix deck decide <card-id> '<decision-json>' [--json]
tedix feed [for-you] [--project <uuid>] [--limit <n>] [--json]

Optional final JSON on list, show, or feed selects {"gadgetId":"…","timeZone":"Europe/Berlin"}.
Decisions save factory feedback or bounded, unprotected interaction responses using the typed decision JSON.
Critical decisions, governed approvals, handoffs and executable effects require the OS card or Home approval flow.
Interaction decisions require the expected version from show.
Reads use your authenticated recipient, not another person's identity. They do not record impressions.
A partial projection prints complete=false; it is not an exact total.`;
}

export interface AttentionCommandContext extends NativeToolContext {
	json: boolean;
	positionals: string[];
	projectId?: string;
	limit?: number;
}
export async function runAttentionCommand(
	command: "deck" | "feed",
	ctx: AttentionCommandContext,
): Promise<number> {
	try {
		const args = [...ctx.positionals];
		const verb =
			command === "feed"
				? args[0]?.startsWith("{")
					? "for-you"
					: (args.shift() ?? "for-you")
				: (args.shift() ?? "list");
		let tool: string;
		let input: Record<string, unknown>;
		let schema:
			| typeof DeckProjectionSchema
			| typeof DeckCardSchema
			| typeof ForYouProjectionSchema
			| undefined;
		if (command === "deck" && verb === "decide") {
			const cardId = args.shift();
			const json = args.shift();
			if (!cardId || !json || args.length) throw new Error(attentionUsage());
			const parsed = DecideDeckCardInputSchema.parse(JSON.parse(json));
			const expectedId =
				parsed.kind === "interaction"
					? parsed.decision.requestId
					: parsed.kind === "work_approval"
						? `work-approval:${parsed.decision.proposalId}`
						: parsed.kind === "runtime_approval"
							? `approval:${parsed.decision.id}`
							: parsed.cardId;
			if (expectedId !== cardId)
				throw new Error("The card ID and decision payload do not match");
			tool = "decide_deck_card";
			input = { decision: parsed };
		} else {
			const cardId =
				command === "deck" && verb === "show" ? args.shift() : undefined;
			if (
				(command === "deck" && !["list", "show"].includes(verb)) ||
				(command === "feed" && verb !== "for-you")
			)
				throw new Error(attentionUsage());
			if (command === "deck" && verb === "show" && !cardId)
				throw new Error(attentionUsage());
			const selection = args.shift();
			if (args.length) throw new Error(attentionUsage());
			const view = AttentionViewInputSchema.parse({
				...(selection ? JSON.parse(selection) : {}),
				...(ctx.projectId ? { projectId: ctx.projectId } : {}),
				...(ctx.limit !== undefined ? { limit: ctx.limit } : {}),
			});
			input = cardId ? { ...view, cardId } : view;
			tool =
				command === "feed"
					? "list_feed_for_you"
					: cardId
						? "get_deck_card"
						: "list_deck_cards";
			schema =
				command === "feed"
					? ForYouProjectionSchema
					: cardId
						? DeckCardSchema
						: DeckProjectionSchema;
		}
		const raw = await callConfiguredNativeTool(ctx, `attention.${tool}`, input);
		const normalized = normalizeCodeResult(raw);
		if (normalized.truncated)
			throw new Error(truncationErrorMessage(normalized));
		const value = schema ? schema.parse(normalized.value) : normalized.value;
		if (
			!schema &&
			(!value ||
				typeof value !== "object" ||
				!("saved" in value) ||
				value.saved !== true)
		)
			throw new Error(errorText(value));
		if (ctx.json) console.log(JSON.stringify(value, null, 2));
		else if (
			value &&
			typeof value === "object" &&
			"cards" in value &&
			Array.isArray(value.cards)
		) {
			const projection = DeckProjectionSchema.parse(value);
			console.log(
				`${projection.count} cards${projection.complete ? "" : " (partial inventory)"}`,
			);
			for (const card of value.cards)
				console.log(`${card.id}  ${card.label}\n  ${card.source}`);
		} else console.log(JSON.stringify(value, null, 2));
		return 0;
	} catch (error) {
		console.error(errorText(error));
		return 2;
	}
}
