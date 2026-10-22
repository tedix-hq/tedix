import { startFixtureServer } from "./fixture-server";
/**
 * The quick chat acts on the Decision Deck card on screen: the person asks
 * "fill this card with X and choose Y", the chat runs the page's own tools
 * through the real widget, the card fills, and nothing is submitted until the
 * person taps the inline confirm in the chat.
 */
import { openExamples } from "./deck-controls";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";

const server = await startFixtureServer("/browser-tests/deck-chat.html");
const { origin } = server;

const pageToolLog = (page: Page) =>
	page.evaluate(
		() =>
			(
				window as unknown as {
					__pageToolLog: Array<{ name: string; ok: boolean | null }>;
				}
			).__pageToolLog,
	);

async function ask(page: Page, text: string) {
	const input = page.locator(".tedix-input");
	await input.fill(text);
	await input.press("Enter");
}

let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1280, height: 800 },
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.goto(`${origin}/browser-tests/deck-chat.html`);
		await openExamples(page);
		await page
			.getByRole("region", { name: "Send Morgan the revised delivery date?" })
			.waitFor();
		await page.locator(".tedix-launcher").click();
		await page.locator(".tedix-input").waitFor();

		// 1. Fill and choose, then decline the submit in the chat.
		await ask(
			page,
			'Show card example:2, fill this card with "A smaller release this month" and choose approve',
		);
		const confirm = page.locator('.tedix-page-action[data-state="confirm"]');
		await confirm.waitFor();
		await page
			.getByRole("region", {
				name: "Which outcome matters most for this project?",
			})
			.waitFor();
		assert.equal(
			await page.getByRole("textbox", { name: "Your answer" }).inputValue(),
			"A smaller release this month",
			"the chat filled the card on screen",
		);
		assert.equal(
			await page.locator("[data-agent-staged]").count(),
			1,
			"the chosen option is prepared on the card",
		);
		assert.match(
			(await confirm.textContent()) ?? "",
			/Home wants to submit this/,
		);
		// Nothing is submitted while the confirm waits.
		assert.equal(await page.getByRole("alertdialog").count(), 0);
		assert.deepEqual(
			(await pageToolLog(page)).map((entry) => entry.name),
			[
				"set_decision_deck_card",
				"get_decision_deck_card",
				"set_decision_card_answer",
				"set_decision_card_option",
			],
		);
		await confirm.getByRole("button", { name: "Don't submit" }).click();
		await page.getByText("Not submitted", { exact: true }).waitFor();
		await page.getByText(/Not submitted: you kept/).waitFor();
		assert.equal(
			(await pageToolLog(page)).at(-1)?.ok,
			false,
			"a declined submit reports failure to the model",
		);
		await page
			.getByRole("region", {
				name: "Which outcome matters most for this project?",
			})
			.waitFor();
		// The activity rows say what the chat did, with Undo where it can.
		await page.getByText('Home chose "Approve"').first().waitFor();
		await page.getByText("Home filled the answer").first().waitFor();

		// 2. Ask again and tap Submit: only now is the decision saved.
		await ask(
			page,
			'Fill this card with "A smaller release this month" and choose approve',
		);
		const second = page.locator('.tedix-page-action[data-state="confirm"]');
		await second.waitFor();
		await second.getByRole("button", { name: "Submit", exact: true }).click();
		await page.getByRole("alertdialog").waitFor();
		await page
			.getByText(/Done: filled the card and submitted/)
			.waitFor({ state: "attached" });
		assert.equal(
			(await pageToolLog(page)).at(-1)?.name,
			"respond_decision_card",
		);
		assert.equal((await pageToolLog(page)).at(-1)?.ok, true);
		// This choice asks for confirmation on the card too; the card's own
		// dialog reaches the person, as when they click Approve themselves.
		assert.deepEqual(errors, [], "no page errors");
	} finally {
		await page.close();
	}
	assert.equal(server.exitCode(), null, "Own fixture server stayed alive");
} finally {
	await browser?.close();
	await server.stop();
}
