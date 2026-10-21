/**
 * The Decision Deck with the real quick chat widget mounted beside it, for
 * the page-tool round trip. The widget reads the page's tools from the same
 * registry the OS quick chat passes it. The Home turn here is a scripted
 * model: it asks the page to run tools through the widget, exactly as the
 * Home path relays a model's calls, and nothing else is faked.
 */
import "./deck.tsx";
import { listPageChatTools } from "../src/lib/page-chat-tools";

type PageToolCall = {
	callId: string;
	name: string;
	args: Record<string, unknown>;
	confirm: boolean;
};
type PageToolResult = { ok: boolean; content: string } | null;
type HomeTurnInput = {
	text: string;
	pageTools?: Array<{ name: string; confirm?: boolean }>;
	runPageTool?: (call: PageToolCall) => Promise<PageToolResult>;
	onDelta?: (text: string) => void;
};

const log: Array<{ name: string; ok: boolean | null }> = [];
(window as unknown as { __pageToolLog: typeof log }).__pageToolLog = log;

let calls = 0;
async function run(
	input: HomeTurnInput,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
	const tool = input.pageTools?.find((entry) => entry.name === name);
	const result = await input.runPageTool!({
		callId: `call-${String(++calls).padStart(8, "0")}`,
		name,
		args,
		confirm: tool?.confirm === true,
	});
	log.push({ name, ok: result?.ok ?? null });
	if (!result?.ok) return null;
	try {
		return JSON.parse(result.content) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** "Fill this card with X and choose Y", the way a model would do it. */
async function turn(input: HomeTurnInput): Promise<{ text: string }> {
	const fill = /fill this card with "([^"]+)"/i.exec(input.text)?.[1];
	const choose = /choose (\w+)/i.exec(input.text)?.[1];
	const target = /card (example:\d+)/i.exec(input.text)?.[1];
	if (target) {
		await run(input, "set_decision_deck_card", { cardId: target });
		// A model's next call comes a round trip later; the card renders first.
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	const read = await run(input, "get_decision_deck_card", {});
	const card = (read?.card ?? null) as {
		id: string;
		options?: Array<{ id: string; label: string }>;
	} | null;
	(window as unknown as { __card: unknown }).__card = card;
	if (!card) return { text: "I could not read the card." };
	if (fill)
		await run(input, "set_decision_card_answer", {
			cardId: card.id,
			text: fill,
		});
	if (choose) {
		const option =
			card.options?.find(
				(entry) =>
					entry.id === choose ||
					entry.label.toLowerCase() === choose.toLowerCase(),
			)?.id ?? choose;
		await run(input, "set_decision_card_option", {
			cardId: card.id,
			optionId: option,
		});
		const submitted = await run(input, "respond_decision_card", {
			cardId: card.id,
			optionId: option,
			confirmedByUser: true,
		});
		input.onDelta?.(submitted ? "Done: " : "Not submitted: ");
		return {
			text: submitted
				? `Done: filled the card and submitted ${choose}.`
				: `Not submitted: you kept ${choose} prepared on the card.`,
		};
	}
	return { text: "Filled the card." };
}

const script = document.createElement("script");
script.type = "text/plain";
script.dataset.tedixTenant = "demo-org";
document.head.append(script);
await import("../../widget/src/embed/embed.mjs");
(
	window as unknown as {
		Tedix: { init(options: Record<string, unknown>): void };
	}
).Tedix.init({
	script,
	branding: false,
	title: "Tedi",
	locale: "en-US",
	session: () => new Promise(() => {}),
	pageTools: { list: listPageChatTools },
	home: { label: "Home", turn },
});
