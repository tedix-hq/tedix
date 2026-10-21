import { describe, expect, it, vi } from "vite-plus/test";
import { webMcpError } from "@tedix/webmcp-core/model-context";
import type {
	DeckCardAgentHandle,
	DeckNotUsefulHandle,
} from "@/lib/deck-card-agent";
import {
	buildDecisionDeckWebMcpTools,
	type DecisionDeckController,
} from "./decision-deck-webmcp-tools";

function handle(
	overrides: Partial<DeckCardAgentHandle> = {},
): DeckCardAgentHandle {
	const card: DeckCardAgentHandle = {
		kind: "question",
		field: "answer",
		value: "",
		suggestedAnswers: ["Friday"],
		actions: [
			{
				id: "answer",
				label: "Answer",
				intent: "approve",
				needsConfirmation: false,
				disabled: false,
			},
			{
				id: "decline",
				label: "Decline",
				intent: "reject",
				needsConfirmation: false,
				disabled: false,
			},
		],
		stagedOptionId: null,
		busy: false,
		fill: vi.fn((text: string) => {
			card.value = text;
			return { ok: true as const, status: "filled" };
		}),
		stage: vi.fn((optionId: string) => {
			card.stagedOptionId = optionId;
			return { ok: true as const, status: "staged" };
		}),
		submit: vi.fn(async () => ({ ok: true as const, status: "saved" })),
		...overrides,
	};
	return card;
}

function deck(agent: DeckCardAgentHandle | null = handle()) {
	const notUseful: DeckNotUsefulHandle = {
		reasons: ["duplicate"],
		mark: vi.fn(async () => ({
			ok: true as const,
			status: "marked_not_useful",
		})),
	};
	const state: DecisionDeckController = {
		mode: "decide",
		card: { id: "card-1", kind: "question", label: "When?", decision: null },
		readiness: null,
		remaining: 2,
		queue: [
			{ id: "card-1", label: "When?" },
			{ id: "card-2", label: "Which vendor?" },
		],
		agent: () => agent,
		notUseful: () => notUseful,
		later: vi.fn(),
		show: vi.fn((cardId: string) => cardId === "card-2"),
	};
	const tools = buildDecisionDeckWebMcpTools(() => state);
	const tool = (name: string) => {
		const found = tools.find((candidate) => candidate.name === name);
		if (!found) throw new Error(`missing ${name}`);
		return found;
	};
	return { state, agent, notUseful, tools, tool };
}

describe("Decision deck WebMCP tools", () => {
	it("registers reads, card actions and one deciding tool", () => {
		const { tools } = deck();
		expect(tools.map((tool) => tool.name)).toEqual([
			"get_decision_deck_card",
			"set_decision_deck_card",
			"set_decision_card_answer",
			"set_decision_card_option",
			"set_decision_card_later",
			"set_decision_card_not_useful",
			"respond_decision_card",
		]);
		for (const tool of tools.slice(1)) {
			expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
			expect(tool.annotations.consequentialHint, tool.name).toBe(true);
		}
		expect(tools[0]!.annotations).toEqual({
			readOnlyHint: true,
			untrustedContentHint: true,
		});
	});

	it("reads the live card with its answer field, options and queue", async () => {
		const { tool, agent } = deck();
		await tool("set_decision_card_answer").execute({
			cardId: "card-1",
			text: "Friday at noon",
		});
		const read = await tool("get_decision_deck_card").execute({});
		expect(read.structuredContent).toMatchObject({
			mode: "decide",
			card: {
				id: "card-1",
				answer: { field: "answer", value: "Friday at noon" },
				options: agent!.actions,
				preparedOptionId: null,
				canMarkNotUseful: true,
				canSnooze: true,
			},
			queue: [{ id: "card-1" }, { id: "card-2" }],
		});
	});

	it("fills the answer and prepares an option without saving", async () => {
		const { tool, agent } = deck();
		const fill = await tool("set_decision_card_answer").execute({
			cardId: "card-1",
			text: "Friday",
		});
		expect(fill.structuredContent).toEqual({
			cardId: "card-1",
			status: "filled",
		});
		const choose = await tool("set_decision_card_option").execute({
			cardId: "card-1",
			optionId: "answer",
		});
		expect(choose.structuredContent).toEqual({
			cardId: "card-1",
			status: "staged",
		});
		expect(agent!.fill).toHaveBeenCalledWith("Friday");
		expect(agent!.stage).toHaveBeenCalledWith("answer");
		expect(agent!.submit).not.toHaveBeenCalled();
	});

	it("submits only with confirmedByUser and only the prepared option", async () => {
		const { tool, agent } = deck();
		const respond = tool("respond_decision_card");
		const unconfirmed = await respond.execute({
			cardId: "card-1",
			optionId: "answer",
			confirmedByUser: false,
		});
		expect(unconfirmed.isError).toBe(true);
		expect(unconfirmed.content[0]!.text).toContain("explicitly asked");
		const missing = await respond.execute({
			cardId: "card-1",
			optionId: "answer",
		});
		expect(missing.isError).toBe(true);
		const unprepared = await respond.execute({
			cardId: "card-1",
			optionId: "answer",
			confirmedByUser: true,
		});
		expect(unprepared.content[0]!.text).toContain("Prepare the option");
		expect(agent!.submit).not.toHaveBeenCalled();

		await tool("set_decision_card_option").execute({
			cardId: "card-1",
			optionId: "answer",
		});
		const other = await respond.execute({
			cardId: "card-1",
			optionId: "decline",
			confirmedByUser: true,
		});
		expect(other.isError).toBe(true);
		expect(agent!.submit).not.toHaveBeenCalled();

		const saved = await respond.execute({
			cardId: "card-1",
			optionId: "answer",
			confirmedByUser: true,
		});
		expect(saved.structuredContent).toEqual({
			cardId: "card-1",
			status: "saved",
		});
		expect(agent!.submit).toHaveBeenCalledWith("answer");
	});

	it("refuses every write on a card that is not on screen", async () => {
		const { tools, agent, notUseful, state } = deck();
		const args = {
			cardId: "card-2",
			text: "x",
			optionId: "answer",
			reason: "duplicate",
			confirmedByUser: true,
		};
		for (const tool of tools.slice(2)) {
			const result = await tool.execute(args);
			expect(result.isError, tool.name).toBe(true);
			expect(result.content[0]!.text, tool.name).toContain(
				'Card "card-2" is not the card on screen ("card-1")',
			);
		}
		expect(agent!.fill).not.toHaveBeenCalled();
		expect(agent!.stage).not.toHaveBeenCalled();
		expect(agent!.submit).not.toHaveBeenCalled();
		expect(notUseful.mark).not.toHaveBeenCalled();
		expect(state.later).not.toHaveBeenCalled();
	});

	it("shows a named card only when it is in this view", async () => {
		const { tool, state } = deck();
		const shown = await tool("set_decision_deck_card").execute({
			cardId: "card-2",
		});
		expect(shown.structuredContent).toEqual({
			cardId: "card-2",
			status: "shown",
		});
		const absent = await tool("set_decision_deck_card").execute({
			cardId: "card-9",
		});
		expect(absent).toEqual(
			webMcpError('Card "card-9" is not in this Deck view.'),
		);
		expect(state.show).toHaveBeenCalledTimes(2);
	});

	it("snoozes through the card's Later option, or the Deck's Later control", async () => {
		const withOption = handle({
			actions: [
				{
					id: "later",
					label: "Later",
					intent: "later",
					needsConfirmation: false,
					disabled: false,
				},
			],
		});
		const optionDeck = deck(withOption);
		await optionDeck
			.tool("set_decision_card_later")
			.execute({ cardId: "card-1" });
		expect(withOption.submit).toHaveBeenCalledWith("later");
		expect(optionDeck.state.later).not.toHaveBeenCalled();

		const plain = deck();
		const result = await plain
			.tool("set_decision_card_later")
			.execute({ cardId: "card-1" });
		expect(result.structuredContent).toEqual({
			cardId: "card-1",
			status: "later",
		});
		expect(plain.state.later).toHaveBeenCalledOnce();
	});

	it("marks not useful with the person's reason", async () => {
		const { tool, notUseful } = deck();
		const result = await tool("set_decision_card_not_useful").execute({
			cardId: "card-1",
			reason: "duplicate",
		});
		expect(result.structuredContent).toEqual({
			cardId: "card-1",
			status: "marked_not_useful",
		});
		expect(notUseful.mark).toHaveBeenCalledWith("duplicate");
	});

	it("keeps past decisions read-only", async () => {
		const { tool, state, agent } = deck();
		state.mode = "history";
		const result = await tool("set_decision_card_answer").execute({
			cardId: "card-1",
			text: "Friday",
		});
		expect(result).toEqual(webMcpError("Past decisions are read-only."));
		expect(agent!.fill).not.toHaveBeenCalled();
	});

	it("returns errors instead of throwing when the deck or card fails", async () => {
		const tools = buildDecisionDeckWebMcpTools(() => {
			throw new Error("private controller details".repeat(1000));
		});
		for (const tool of tools)
			await expect(
				tool.execute({ cardId: "card-1", text: "x", optionId: "answer" }),
			).resolves.toMatchObject({ isError: true });
		const failing = deck(
			handle({
				submit: vi.fn(async () => {
					throw new Error("boom");
				}),
				stagedOptionId: "answer",
			}),
		);
		await expect(
			failing.tool("respond_decision_card").execute({
				cardId: "card-1",
				optionId: "answer",
				confirmedByUser: true,
			}),
		).resolves.toEqual(
			webMcpError("The card could not be changed. Try again in a moment."),
		);
	});
});
