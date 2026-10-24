import { startFixtureServer } from "./fixture-server";
import { settleAnimations } from "./deck-controls";
import assert from "node:assert/strict";
import { devices, webkit, type Browser, type Page } from "playwright";

/*
 * The Work Deck on iPhone Safari (WebKit). A software keyboard shrinks only the
 * visual viewport there; the Deck once followed it, collapsed the card to 42px,
 * spilled its footer and lifted the Feed/Deck bar into mid-screen.
 */
const server = await startFixtureServer("/work?view=deck");
const { origin } = server;
const shots = process.env.TEDIX_SCREENSHOT_DIR;
const MIN_CARD_HEIGHT = 240;

/** Geometry the Deck must keep at any viewport. */
function measure(page: Page) {
	return page.evaluate(() => {
		const card = document.querySelector<HTMLElement>(
			".fd-deck-current .fd-card",
		)!;
		const cardBox = card.getBoundingClientRect();
		const footer = card.querySelector<HTMLElement>(
			'[data-slot="card-footer"]',
		)!;
		const footerBox = footer.getBoundingClientRect();
		const body = card.querySelector<HTMLElement>('[data-slot="card-content"]')!;
		const nav = document.querySelector<HTMLElement>(
			'[data-slot="bottom-nav"]',
		)!;
		const failures: string[] = [];
		if (
			footerBox.top < cardBox.top - 1 ||
			footerBox.bottom > cardBox.bottom + 1
		)
			failures.push(
				`footer ${footerBox.top}-${footerBox.bottom} outside card ${cardBox.top}-${cardBox.bottom}`,
			);
		if (body.getBoundingClientRect().bottom > footerBox.top + 1)
			failures.push("card body runs into the footer");
		// "Tedix · 19h ago", "Details", the actions and "Not useful" never overlap.
		const pieces = [
			...card.querySelectorAll<HTMLElement>(
				'[data-slot="card-description"] > *, [data-slot="card-footer"] button, [data-slot="card-footer"] a',
			),
		]
			.filter((node) => node.getClientRects().length)
			.map((node) => ({
				name: (node.textContent ?? node.tagName).trim().slice(0, 24),
				box: node.getBoundingClientRect(),
			}))
			.filter(({ box }) => box.width > 0 && box.height > 0);
		for (const [index, a] of pieces.entries()) {
			if (a.box.bottom > cardBox.bottom + 1 || a.box.top < cardBox.top - 1)
				failures.push(`${a.name} outside the card`);
			for (const b of pieces.slice(index + 1)) {
				const overlapX =
					Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
				const overlapY =
					Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
				if (overlapX > 1 && overlapY > 1)
					failures.push(`${a.name} overlaps ${b.name}`);
			}
		}
		// Hit-test the bar so an ancestor clipping it at the keyboard edge fails too.
		const navBox = nav.getBoundingClientRect();
		const hit = document.elementFromPoint(
			navBox.left + navBox.width / 3,
			navBox.bottom - 4,
		);
		if (!hit || !nav.contains(hit))
			failures.push("Feed/Deck bar is covered or clipped");
		// The quick-chat launcher floats above the bar, never on the Deck tab.
		const launcher = document
			.querySelector("[data-tedix-widget]")
			?.shadowRoot?.querySelector(".tedix-launcher")
			?.getBoundingClientRect();
		if (launcher && launcher.height && launcher.bottom > navBox.top - 8)
			failures.push(
				`chat launcher ends at ${launcher.bottom}, bar starts at ${navBox.top}`,
			);
		const active = document.activeElement;
		return {
			failures,
			cardHeight: cardBox.height,
			navBottom: nav.getBoundingClientRect().bottom,
			layoutHeight: document.documentElement.clientHeight,
			focused:
				active && active !== document.body
					? `${active.tagName} ${active.getAttribute("aria-label") ?? active.textContent?.slice(0, 30)}`
					: null,
		};
	});
}

/*
 * The live iPhone report: an overdue yes/no question that also expires later,
 * whose consequence was clipped mid-sentence. The first sample card is
 * rewritten into that shape on the wire.
 */
const LIVE_CARD = "000000a7-0000-4000-8000-000000000001";
const now = Date.now();
const presentation = {
	version: 2,
	generatedAt: new Date(now - 26 * 3_600_000).toISOString(),
	title: "Keep dark-factory private?",
	context: "Nobody can check the repository for secrets yet.",
	body: "If yes, dark-factory stays private while safety checks run and nobody outside the team can read or clone it.",
	recommendation: "Publishing before the check could expose credentials.",
};
type Row = Record<string, unknown>;
function liveRequest(request: Row) {
	if (request?.id !== LIVE_CARD) return;
	const metadata = { ...(request.metadata as Row) };
	delete metadata.decisionDeck;
	Object.assign(request, {
		kind: "question",
		subject: "Keep dark-factory private while it cannot be checked?",
		dueAt: new Date(now - 23 * 3_600_000).toISOString(),
		expiresAt: new Date(now + 6 * 86_400_000).toISOString(),
		metadata: { ...metadata, cardPresentation: presentation },
	});
}
function liveDeckCard(card: Row) {
	if (card?.id !== LIVE_CARD) return;
	liveRequest((card.interaction as Row)?.request as Row);
	Object.assign(card, {
		kind: "question",
		decision: null,
		presentation,
		dueAt: new Date(now - 23 * 3_600_000).toISOString(),
	});
}

/** The lean phone Deck: one meta line, one date, a whole consequence, one action row. */
async function leanDeck(page: Page) {
	const failures: string[] = [];
	const meta = await page.evaluate(() => {
		const progress = document.querySelector<HTMLElement>(
			"[data-deck-progress]",
		)!;
		const line = progress.querySelector<HTMLElement>(".fd-deck-meta")!;
		const track = progress.querySelector<HTMLElement>(
			'[data-slot="progress-track"], [role="progressbar"] > *',
		);
		const card = document.querySelector<HTMLElement>(
			".fd-deck-current .fd-card",
		)!;
		const between = [...document.querySelectorAll<HTMLElement>(".fd-deck > *")]
			.filter(
				(node) =>
					node.getClientRects().length &&
					node.getBoundingClientRect().bottom <=
						card.getBoundingClientRect().top + 1 &&
					node.getBoundingClientRect().top >=
						progress.getBoundingClientRect().top - 1 &&
					!node.contains(progress),
			)
			.map((node) => node.className);
		return {
			text: line.innerText,
			height: line.getBoundingClientRect().height,
			track: track?.getBoundingClientRect().height ?? 0,
			between,
			cardText: card.innerText,
		};
	});
	if (meta.height > 28) failures.push(`meta line is ${meta.height}px tall`);
	if (meta.track > 2) failures.push(`progress bar is ${meta.track}px thick`);
	if (meta.between.length)
		failures.push(`rows between meta and card: ${meta.between.join(", ")}`);
	if (!/Overdue since/.test(meta.text))
		failures.push(`meta line lacks the deadline: ${meta.text}`);
	if (/drafted, not sent/i.test(meta.text))
		failures.push("stale-draft group is still on the Deck");
	const dates = `${meta.text}\n${meta.cardText}`.match(
		/\b(?:Due|Overdue since|Expires)\b/g,
	);
	if (dates?.length !== 1)
		failures.push(`expected one date, saw ${dates?.join(", ")}`);

	const card = page.locator(".fd-deck-current .fd-card");
	const summary = card.locator(".fd-card-summary");
	const clipped = await summary.evaluate(
		(node) => node.scrollHeight > node.clientHeight + 1,
	);
	const more = card.getByRole("button", { name: "More", exact: true });
	if (clipped && !(await more.isVisible()))
		failures.push("consequence is clipped with no way to read the rest");
	if (clipped) {
		await more.click();
		if (
			await summary.evaluate(
				(node) => node.scrollHeight > node.clientHeight + 1,
			)
		)
			failures.push("More left the consequence clipped");
	}
	if (!(await summary.innerText()).trim().endsWith("clone it."))
		failures.push("consequence does not end with its last words");

	const row = await card.locator("[data-decision-actions]").evaluate((node) => {
		const visible = [...node.children].filter(
			(child) =>
				(child as HTMLElement).getClientRects().length &&
				getComputedStyle(child).visibility !== "hidden",
		) as HTMLElement[];
		return {
			buttons: visible
				.filter((child) => !child.classList.contains("fd-action-more"))
				.map((child) => ({
					text: child.innerText.trim(),
					top: child.getBoundingClientRect().top,
					primary: child.dataset.decisionIntent === "approve",
				})),
			more: visible.find((child) => child.classList.contains("fd-action-more"))
				? visible
						.find((child) => child.classList.contains("fd-action-more"))!
						.getBoundingClientRect().top
				: null,
			textarea: Boolean(
				document.querySelector(".fd-deck-current textarea")?.getClientRects()
					.length,
			),
		};
	});
	if (row.buttons.length > 2)
		failures.push(
			`${row.buttons.length} visible actions: ${row.buttons.map((b) => b.text).join(", ")}`,
		);
	if (row.more === null) failures.push("no ⋯ overflow on the action row");
	const tops = [...row.buttons.map((b) => b.top), row.more ?? 0];
	if (Math.max(...tops) - Math.min(...tops) > 4)
		failures.push("actions wrap to a second row");
	const primary = row.buttons.find((b) => b.primary)?.text;
	if (primary !== "Keep private")
		failures.push(`yes/no primary reads "${primary}"`);
	if (row.textarea) failures.push("a yes/no question shows an answer box");
	if (
		(await page
			.getByText("Not useful", { exact: true })
			.locator("visible=true")
			.count()) > 1
	)
		failures.push("Not useful shows more than once");

	await card.getByRole("button", { name: "More actions" }).click();
	const menu = page.getByRole("menu");
	await menu.getByRole("menuitem").first().waitFor();
	for (const item of ["Write an answer", "Later", "Not useful", "Why this"])
		if (
			(await menu
				.getByRole("menuitem")
				.filter({ hasText: new RegExp(`^${item}$`) })
				.count()) !== 1
		)
			failures.push(
				`overflow lacks ${item}: ${(await menu.getByRole("menuitem").allInnerTexts()).join(", ")}`,
			);
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "hidden" });
	return failures;
}

let browser: Browser | undefined;
try {
	browser = await webkit.launch({ headless: true });
	for (const [size, device] of [
		["390x844", devices["iPhone 13"]],
		["375x667", devices["iPhone 8"]],
	] as const)
		for (const colorScheme of ["light", "dark"] as const) {
			const label = `${size} ${colorScheme}`;
			const context = await browser.newContext({
				...device,
				colorScheme,
				reducedMotion: "reduce",
			});
			await context.addInitScript(
				(theme) => localStorage.setItem("tedix-os-theme", theme),
				colorScheme,
			);
			const page = await context.newPage();
			await page.route(
				/\/api\/rpc\/(?:workInteractions\/(?:listInbox|get)|attention\/(?:getDeckCard|listDeckCards))/,
				async (route) => {
					const response = await route.fetch();
					const body = (await response.json()) as { json?: Row };
					const data = body.json;
					if (data) {
						for (const row of (data.data as Row[] | undefined) ?? [])
							liveRequest(row.request as Row);
						for (const card of (data.cards as Row[] | undefined) ?? [])
							liveDeckCard(card);
						liveRequest(data.request as Row);
						liveDeckCard(data);
					}
					await route.fulfill({ response, json: body });
				},
			);
			await page.goto(`${origin}/work?view=deck`);
			await page.locator(".fd-deck-current .fd-card").waitFor();
			await page.locator('[data-slot="card-footer"]').first().waitFor();
			await page.waitForFunction(
				() =>
					document
						.querySelector("[data-tedix-widget]")
						?.shadowRoot?.querySelector(".tedix-launcher")
						?.getBoundingClientRect().height,
			);
			await settleAnimations(page, ".fd-deck");

			const loaded = await measure(page);
			assert.equal(loaded.focused, null, `${label}: focused on load`);
			assert.deepEqual(loaded.failures, [], `${label}: card layout on load`);
			assert(
				loaded.cardHeight >= MIN_CARD_HEIGHT,
				`${label}: card only ${loaded.cardHeight}px tall`,
			);
			assert(
				Math.abs(loaded.navBottom - loaded.layoutHeight) <= 1,
				`${label}: Feed/Deck bar ends at ${loaded.navBottom}, viewport ${loaded.layoutHeight}`,
			);
			if (shots)
				await page.screenshot({
					path: `${shots}/deck-${size}-${colorScheme}.png`,
				});
			// CI can sample an entrance animation after the old fixed delay.
			await page.locator(".fd-deck-current .fd-card").evaluate(async (card) => {
				await card.animate(
					[{ transform: "scale(0.98)" }, { transform: "none" }],
					{
						duration: 1_000,
					},
				).finished;
			});
			await settleAnimations(page, ".fd-deck");
			const animated = await measure(page);
			assert(
				Math.abs(animated.cardHeight - loaded.cardHeight) <= 1,
				`${label}: measured an unfinished card animation ${loaded.cardHeight} -> ${animated.cardHeight}`,
			);
			const lean = !process.env.TEDIX_DECK_LEAN_SKIP;
			if (lean) {
				assert.deepEqual(await leanDeck(page), [], `${label}: lean Deck`);
				if (shots) {
					await page
						.locator(".fd-deck-current .fd-card")
						.getByRole("button", { name: "More actions" })
						.click();
					await page.getByRole("menu").waitFor();
					await page.screenshot({
						path: `${shots}/deck-menu-${size}-${colorScheme}.png`,
					});
					await page.keyboard.press("Escape");
					await page.getByRole("menu").waitFor({ state: "hidden" });
				}
				await page.locator(".fd-decision").first().blur();
				await settleAnimations(page, ".fd-deck");
			}
			// "More" may have opened the consequence; the keyboard compares against this.
			const reference = await measure(page);

			// The iOS keyboard: the layout viewport stays, the visual viewport shrinks and pans.
			await page.evaluate(() => {
				const viewport = window.visualViewport!;
				const height = Math.round(innerHeight * 0.55);
				Object.defineProperty(viewport, "height", {
					configurable: true,
					get: () => height,
				});
				Object.defineProperty(viewport, "offsetTop", {
					configurable: true,
					get: () => 40,
				});
				viewport.dispatchEvent(new Event("resize"));
				viewport.dispatchEvent(new Event("scroll"));
			});
			await settleAnimations(page, ".fd-deck");
			const keyboard = await measure(page);
			assert.deepEqual(
				keyboard.failures,
				[],
				`${label}: card layout with keyboard`,
			);
			assert(
				Math.abs(keyboard.cardHeight - reference.cardHeight) <= 1,
				`${label}: keyboard resized the card ${reference.cardHeight} -> ${keyboard.cardHeight}`,
			);
			assert(
				Math.abs(keyboard.navBottom - keyboard.layoutHeight) <= 1,
				`${label}: keyboard lifted the Feed/Deck bar to ${keyboard.navBottom}`,
			);
			if (shots)
				await page.screenshot({
					path: `${shots}/after-keyboard-${size}-${colorScheme}.png`,
				});

			// A browser that shrinks the layout viewport for its keyboard still keeps a usable card.
			await page.setViewportSize({ width: device.viewport.width, height: 360 });
			await settleAnimations(page, ".fd-deck");
			const short = await measure(page);
			assert.deepEqual(short.failures, [], `${label}: card layout at 360px`);
			assert(
				short.cardHeight >= MIN_CARD_HEIGHT,
				`${label}: card only ${short.cardHeight}px tall at 360px`,
			);
			// Wider glyphs (CI's Linux fonts) wrap the action row onto two lines.
			await page.addStyleTag({
				content:
					".fd-deck-current [data-decision-actions] > button { padding-inline: 1.6rem !important }",
			});
			await settleAnimations(page, ".fd-deck");
			const wrapped = await measure(page);
			assert.deepEqual(
				wrapped.failures,
				[],
				`${label}: card layout at 360px with a wrapped action row`,
			);
			await context.close();
			console.log(`PASS ${label}`);
		}
} finally {
	await browser?.close();
	await server.stop();
}
