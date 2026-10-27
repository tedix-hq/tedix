import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

/*
 * A written card face (story line, recommendation and context strip) on
 * Work > Decisions must fit any window at least 320px wide and 560px tall:
 * nothing in the card overlaps the action row, the action row stays in view,
 * the face has no empty gaps, and what does not fit scrolls inside the body.
 *
 * Regression: the story line reused the feed's .fd-story class and picked up
 * 68px of padding, which pushed the strip half under the action row.
 */
const presentation = {
	version: 2,
	title: "Record your review?",
	context: "You set the prep deadline yourself; nobody outside is waiting.",
	body: "Records your review on the prep task; nothing is sent.",
	recommendation:
		"Record it — the prep deadline is proposed, not an external commitment.",
	actionLabels: { approve: "Record review", reject: "Keep open" },
};

const server = await startFixtureServer("/");
const browser = await chromium.launch({ headless: true });

try {
	for (const theme of ["light", "dark"] as const) {
		for (const [width, height] of [
			[320, 560],
			[375, 667],
			[1280, 560],
			[1280, 623],
			[1440, 900],
		] as const) {
			const label = `${width}x${height} ${theme}`;
			const phone = width < 640;
			const context = await browser.newContext({
				viewport: { width, height },
				colorScheme: theme,
				reducedMotion: "reduce",
				isMobile: phone,
				hasTouch: phone,
			});
			const page = await context.newPage();
			await page.route("**/userSettings/getPreferences", async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				body.json.preferences.theme = theme;
				return route.fulfill({ response, json: body });
			});
			await page.route("**/workInteractions/listInbox", async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				const row = body.json.data[0];
				if (row) {
					row.lastRelatedDecision = {
						subject: "Filed to GTM?",
						body: "Kept the filing under GTM.",
						decidedAt: "2026-10-25T12:00:00.000Z",
					};
					row.request.metadata.cardPresentation = presentation;
				}
				return route.fulfill({ response, json: body });
			});
			await page.route("**/attention/getDeckCard", async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				body.json.presentation = presentation;
				return route.fulfill({ response, json: body });
			});
			await page.goto(`${server.origin}/work?view=deck`, {
				waitUntil: "domcontentloaded",
			});
			await page
				.locator(".fd-context-strip [data-context-item=last_decision]")
				.waitFor();
			await page.evaluate(() => document.fonts.ready);
			assert.equal(
				await page.locator("html").getAttribute("data-mode"),
				theme,
				`${label}: theme applied`,
			);

			const failures = await page.evaluate(() => {
				const problems: string[] = [];
				const card = document.querySelector<HTMLElement>(
					".fd-deck-current .fd-card",
				)!;
				const body = card.querySelector<HTMLElement>(
					'[data-slot="card-content"]',
				)!;
				const footer = card.querySelector<HTMLElement>(
					'[data-slot="card-footer"]',
				)!;
				const header = card.querySelector<HTMLElement>(
					'[data-slot="card-header"]',
				)!;
				const row = footer.getBoundingClientRect();
				const cardRect = card.getBoundingClientRect();
				if (row.top < 0 || row.bottom > innerHeight)
					problems.push("action row outside the window");
				if (row.bottom > cardRect.bottom + 1)
					problems.push("action row outside the card");
				if (header.getBoundingClientRect().bottom > row.top + 1)
					problems.push("header overlaps the action row");

				// Any element's visible part (clipped by the scrolling body)
				// must stay above the action row.
				const overlapsRow = (node: Element) => {
					const rect = node.getBoundingClientRect();
					const clip = body.getBoundingClientRect();
					const top = Math.max(rect.top, clip.top);
					const bottom = Math.min(rect.bottom, clip.bottom);
					return (
						bottom - top > 1 && bottom > row.top + 1 && top < row.bottom - 1
					);
				};
				const nodes = [
					...card.querySelectorAll('[data-slot="card-content"] *'),
				].filter((node) => node.getClientRects().length);
				for (const top of [0, body.scrollHeight]) {
					body.scrollTop = top;
					for (const node of nodes)
						if (overlapsRow(node))
							problems.push(
								`overlaps the action row at scroll ${top}: ${node.className || node.tagName}`,
							);
				}

				// Everything in the face can be scrolled fully into view.
				for (const node of card.querySelectorAll<HTMLElement>(
					".fd-face > :not(.fd-context-strip), .fd-context-item",
				)) {
					node.scrollIntoView({ block: "nearest" });
					const rect = node.getBoundingClientRect();
					const clip = body.getBoundingClientRect();
					if (
						rect.height <= clip.height &&
						(rect.top < clip.top - 1 || rect.bottom > clip.bottom + 1)
					)
						problems.push(`cannot scroll into view: ${node.textContent}`);
				}
				body.scrollTop = 0;

				// No empty gap between the face's lines, measured on what they
				// show, so padding counts as gap.
				const lines = [
					...card.querySelectorAll<HTMLElement>(".fd-face > *"),
				].map((node) => {
					const range = document.createRange();
					range.selectNodeContents(node);
					return range.getBoundingClientRect();
				});
				if (lines.length < 3) problems.push("face lines missing");
				for (let i = 1; i < lines.length; i++) {
					const gap = lines[i]!.top - lines[i - 1]!.bottom;
					if (gap > 16) problems.push(`empty gap of ${Math.round(gap)}px`);
				}
				if (document.documentElement.scrollWidth > innerWidth + 1)
					problems.push("sideways page scroll");
				return problems;
			});
			assert.deepEqual(failures, [], `${label}: card fits`);
			await context.close();
			console.log(`deck face fit ${label}: ok`);
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
