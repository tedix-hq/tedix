import { startFixtureServer } from "./fixture-server";
/**
 * A page-connected browser agent sees the Decision Deck's WebMCP tools and
 * drives the card on screen through the card's own controls: it fills,
 * prepares, refuses other cards, and submits only on explicit confirmation.
 */
import { openExamples } from "./deck-controls";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";

const server = await startFixtureServer("/browser-tests/deck.html");
const { origin } = server;

type CallResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Calls a registered tool the way a WebMCP host does. */
function call(page: Page, name: string, args: Record<string, unknown>) {
	return page.evaluate(
		async ([toolName, toolArgs]) => {
			const tools = (
				window as unknown as {
					__webmcpTools: Map<
						string,
						{ execute: (args: unknown) => Promise<unknown> }
					>;
				}
			).__webmcpTools;
			const tool = tools.get(toolName as string);
			if (!tool) return { ok: false, error: `missing ${toolName}` };
			try {
				return { ok: true, value: await tool.execute(toolArgs) };
			} catch (error) {
				return { ok: false, error: (error as Error).message };
			}
		},
		[name, args] as const,
	) as Promise<CallResult>;
}

let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1280, height: 800 },
	});
	try {
		// A WebMCP host: the page connects by registering tools on it.
		await page.addInitScript(() => {
			const tools = new Map<string, unknown>();
			(window as unknown as { __webmcpTools: unknown }).__webmcpTools = tools;
			(document as unknown as { modelContext: unknown }).modelContext = {
				registerTool(
					tool: { name: string },
					options?: { signal?: AbortSignal },
				) {
					tools.set(tool.name, tool);
					options?.signal?.addEventListener("abort", () => {
						if (tools.get(tool.name) === tool) tools.delete(tool.name);
					});
				},
			};
		});
		await page.goto(`${origin}/browser-tests/deck.html`);
		await openExamples(page);
		await page
			.getByRole("region", { name: "Send Morgan the revised delivery date?" })
			.waitFor();

		const names = await page.evaluate(() => [
			...(
				window as unknown as { __webmcpTools: Map<string, unknown> }
			).__webmcpTools.keys(),
		]);
		for (const name of [
			"get_decision_deck_card",
			"set_decision_deck_card",
			"set_decision_card_answer",
			"set_decision_card_option",
			"set_decision_card_later",
			"set_decision_card_not_useful",
			"respond_decision_card",
		])
			assert(names.includes(name), `the page offers ${name}`);

		const read = await call(page, "get_decision_deck_card", {});
		assert(read.ok, "the read succeeds");
		const snapshot = read.value as {
			card: { id: string; options: { id: string }[] };
		};
		const cardId = snapshot.card.id;
		assert.equal(cardId, "example:0");
		assert(snapshot.card.options.some((option) => option.id === "approve"));

		const wrong = await call(page, "set_decision_card_option", {
			cardId: "example:1",
			optionId: "approve",
		});
		assert(!wrong.ok && wrong.error.includes("not the card on screen"));
		assert.equal(await page.locator("[data-agent-staged]").count(), 0);

		const prepared = await call(page, "set_decision_card_option", {
			cardId,
			optionId: "approve",
		});
		assert(prepared.ok, "the option is prepared");
		await page.getByText("Prepared in chat: Approve").waitFor();
		assert.equal(await page.locator("[data-agent-staged]").count(), 1);

		const unconfirmed = await call(page, "respond_decision_card", {
			cardId,
			optionId: "approve",
			confirmedByUser: false,
		});
		assert(!unconfirmed.ok, "no submit without the person's instruction");
		assert.equal(await page.getByRole("alertdialog").count(), 0);

		// This card protects a message, so the person still confirms it.
		const confirming = await call(page, "respond_decision_card", {
			cardId,
			optionId: "approve",
			confirmedByUser: true,
		});
		assert(confirming.ok);
		assert.deepEqual(
			(confirming.value as { status: string }).status,
			"confirming",
		);
		await page.getByRole("alertdialog").waitFor();
		await page.getByRole("button", { name: "Go back", exact: true }).click();

		await call(page, "set_decision_card_later", { cardId });
		await page
			.getByRole("region", {
				name: "File this request under Supplier review?",
			})
			.waitFor();

		await call(page, "set_decision_card_option", {
			cardId: "example:1",
			optionId: "approve",
		});
		const saved = await call(page, "respond_decision_card", {
			cardId: "example:1",
			optionId: "approve",
			confirmedByUser: true,
		});
		assert(saved.ok, `the prepared choice is saved: ${JSON.stringify(saved)}`);
		await page
			.getByRole("region", {
				name: "Which outcome matters most for this project?",
			})
			.waitFor();

		const filled = await call(page, "set_decision_card_answer", {
			cardId: "example:2",
			text: "A smaller release this month",
		});
		assert(filled.ok, `the answer is filled: ${JSON.stringify(filled)}`);
		assert.equal(
			await page.getByRole("textbox", { name: "Your answer" }).inputValue(),
			"A smaller release this month",
		);
	} finally {
		await page.close();
	}
	assert.equal(server.exitCode(), null, "Own fixture server stayed alive");
} finally {
	await browser?.close();
	await server.stop();
}
