import { openExamples } from "./deck-controls";
import { chromium, type Browser, type Page } from "playwright";

async function settleAnimations(page: Page) {
	await page.evaluate(async () => {
		await document.fonts.ready;
		await Promise.all(
			document
				.getAnimations()
				.map((animation) => animation.finished.catch(() => {})),
		);
	});
}

const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		String(port),
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{ cwd, stdout: "ignore", stderr: "inherit", detached: true },
);
let browser: Browser | undefined;
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null) throw new Error("Visual test server exited");
		try {
			ready = (await fetch(`${origin}/browser-tests/feed-deck-polish.html`)).ok;
		} catch {}
		if (ready) break;
		await Bun.sleep(200);
	}
	if (!ready) throw new Error("Visual test server did not start");
	browser = await chromium.launch({ headless: true });
	for (const width of [390, 1440]) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: width === 390 ? 844 : 900 },
				colorScheme: theme,
			});
			await page.goto(
				`${origin}/browser-tests/feed-deck-polish.html?cards=one&theme=${theme}`,
			);
			await openExamples(page);
			await page.keyboard.press("Escape");
			const title = page.locator('[data-slot="card-title"]');
			await title.waitFor();
			await settleAnimations(page);
			if (
				(await title.evaluate((el) =>
					Number.parseFloat(getComputedStyle(el).fontSize),
				)) < 20
			)
				throw new Error("Proposal lost its type hierarchy");
			if (
				await page.evaluate(
					() => document.documentElement.scrollWidth > innerWidth,
				)
			)
				throw new Error(`Deck overflows at ${width}/${theme}`);
			const primary = page.locator('[data-decision-intent="approve"]');
			if (
				await page
					.locator(".fd-decision")
					.evaluate((el) => el === document.activeElement)
			)
				throw new Error("Card stole focus on load");
			if (
				!(await primary
					.locator("xpath=ancestor::*[@data-slot='card-footer']")
					.count()) ||
				!(await page.locator('[data-slot="card-footer"] .fd-card-why').count())
			)
				throw new Error("Card actions and Why this must share one surface");
			const rejectBefore = await page
				.locator('[data-decision-intent="reject"]')
				.boundingBox();
			await primary.hover();
			const rejectAfter = await page
				.locator('[data-decision-intent="reject"]')
				.boundingBox();
			if (
				rejectBefore?.x !== rejectAfter?.x ||
				rejectBefore?.y !== rejectAfter?.y
			)
				throw new Error("Key cap hover moved the adjacent action");
			const colors = await primary.evaluate((el) => ({
				fill: getComputedStyle(el).backgroundColor,
				text: getComputedStyle(el).color,
				honey: getComputedStyle(el).getPropertyValue("--accent-honey").trim(),
			}));
			if (
				colors.text !== "rgb(23, 23, 23)" ||
				colors.fill === "rgba(0, 0, 0, 0)"
			)
				throw new Error(
					`Approve lost its honey fill or dark text: ${JSON.stringify(colors)}`,
				);
			const type = await title.evaluate((el) => ({
				family: getComputedStyle(el).fontFamily,
				weight: getComputedStyle(el).fontWeight,
			}));
			if (/mono/i.test(type.family) || type.weight !== "600")
				throw new Error(`Wrong display type: ${JSON.stringify(type)}`);
			if (
				(await page
					.locator(".fd-deck")
					.evaluate((el) => getComputedStyle(el).backgroundImage)) !== "none"
			)
				throw new Error("Deck background is decorated");
			await title.scrollIntoViewIfNeeded();
			const box = (await title.boundingBox())!;
			const x = box.x + 30,
				y = box.y + 20;
			await page.mouse.move(x, y);
			await page.mouse.down();
			await page.mouse.move(x + 110, y, { steps: 12 });
			await page.mouse.up();
			if (
				(await page.locator(".fd-decision").getAttribute("data-dragging")) !==
				"false"
			)
				throw new Error("Mouse drag moved the card");
			if (!(await page.evaluate(() => Boolean(getSelection()?.toString()))))
				throw new Error("Mouse drag could not select title text");
			await page.locator(".fd-decision").focus();
			await page.keyboard.press("ArrowRight");
			await page.locator(".fd-closure").waitFor();
			await page.goto(
				`${origin}/browser-tests/feed-deck-polish.html?surface=approval&theme=${theme}`,
			);
			await page
				.getByRole("heading", { name: "Approve fictional test login" })
				.waitFor();
			if (
				!(await page
					.getByRole("button", { name: "Approve", exact: true })
					.isEnabled()) ||
				(await page.getByRole("textbox", { name: "Your answer" }).count())
			)
				throw new Error("Typed approval regressed to a free-text question");
			if (await page.getByText("Prepared args:", { exact: false }).isVisible())
				throw new Error("Raw approval arguments leaked outside Details");
			await page.getByRole("button", { name: "Details", exact: true }).click();
			await page.getByText("Prepared args:", { exact: false }).waitFor();
			await page.keyboard.press("Escape");
			await settleAnimations(page);
			const footer = await page
				.locator('[data-slot="card-footer"]')
				.boundingBox();
			const primaryBox = await page
				.getByRole("button", { name: "Approve", exact: true })
				.boundingBox();
			if (
				!footer ||
				!primaryBox ||
				primaryBox.y + primaryBox.height > footer.y + footer.height + 1
			)
				throw new Error("Approval actions escaped the footer");
			await page.goto(
				`${origin}/browser-tests/feed-deck-polish.html?surface=feed&theme=${theme}`,
			);
			await page.locator("article").first().waitFor();
			if (await page.locator(".fd-feed-filters").count())
				throw new Error("Feed brought back the filter row");
			const feedFilters = page.getByRole("button", {
				name: "Filters",
				exact: true,
			});
			if (await feedFilters.isVisible()) await feedFilters.click();
			await page.getByRole("combobox", { name: "Your activity" }).click();
			await page.getByRole("option", { name: "Done", exact: true }).click();
			await page
				.getByRole("combobox", { name: "Your activity" })
				.filter({ hasText: "Done" })
				.waitFor();
			await page.keyboard.press("Escape");
			if (
				await page.getByText("Loading your activity…", { exact: true }).count()
			)
				throw new Error("Loaded stories still show a loading label");
			const story = page.locator("article").first();
			await story.hover();
			await story
				.getByRole("button", { name: "More like this", exact: true })
				.waitFor();
			if (!(await story.locator(".fd-preview").count()))
				throw new Error("Outcome lost its source preview");
			const hitAreas = await story.evaluate((el) => {
				const avatar = el.querySelector(".ft-avatar")!;
				const actor = avatar.getBoundingClientRect();
				const row = el.getBoundingClientRect();
				return {
					actor:
						document
							.elementFromPoint(
								actor.x + actor.width / 2,
								actor.y + actor.height / 2,
							)
							?.closest("button") === avatar,
					row: Boolean(
						document
							.elementFromPoint(row.right - 2, row.top + 2)
							?.closest(".ft-post-link"),
					),
				};
			});
			if (!hitAreas.actor || !hitAreas.row)
				throw new Error(
					`Feed row covered a nested control or lost its link: ${JSON.stringify(hitAreas)}`,
				);
			const hierarchy = await story.evaluate((el) => ({
				actor: getComputedStyle(el.querySelector(".ft-byline p")!).fontWeight,
				outcome: getComputedStyle(el.querySelector(".ft-sentence")!).fontWeight,
				preview: getComputedStyle(el.querySelector(".fd-preview-title")!)
					.fontWeight,
			}));
			if (
				hierarchy.actor !== "600" ||
				hierarchy.outcome !== "400" ||
				hierarchy.preview !== "500"
			)
				throw new Error(
					`Feed hierarchy regressed: ${JSON.stringify(hierarchy)}`,
				);
			const previewTitle = await story
				.locator(".fd-preview-title")
				.evaluate((el) => ({
					height: el.getBoundingClientRect().height,
					lineHeight: parseFloat(getComputedStyle(el).lineHeight),
				}));
			if (previewTitle.height > previewTitle.lineHeight * 2 + 1)
				throw new Error("Long evidence title overwhelms the story preview");
			const actions = await story.locator(".ft-reactions").evaluate((el) => {
				const preview = el.previousElementSibling!.getBoundingClientRect();
				const row = el.getBoundingClientRect();
				const style = getComputedStyle(el);
				return {
					clearance: row.top - preview.bottom,
					padding: [
						parseFloat(style.paddingTop),
						parseFloat(style.paddingBottom),
					],
					gap: parseFloat(style.gap),
					buttons: [...el.querySelectorAll("button")].map((button) => {
						const rect = button.getBoundingClientRect();
						return { width: rect.width, height: rect.height };
					}),
				};
			});
			if (actions.clearance < 0 || actions.padding.some((value) => value < 8))
				throw new Error(
					"Feed actions overlap preview content or lack breathing room",
				);
			if (
				actions.gap !== 8 ||
				actions.buttons.some((box) => box.width < 36 || box.height < 36)
			)
				throw new Error("Feed actions lost their hit areas or consistent gaps");
			const digest = page.locator(".fd-quiet-updates button").first();
			const checkDigest = async () => {
				const box = await digest.evaluate((el) => {
					const range = document.createRange();
					range.selectNodeContents(el);
					const text = range.getBoundingClientRect();
					const button = el.getBoundingClientRect();
					return {
						left: text.left - button.left,
						right: button.right - text.right,
						height: button.height,
					};
				});
				if (
					box.left < 12 ||
					box.right < 12 ||
					(width === 390 && box.height < 44)
				)
					throw new Error(
						`Quiet update control is cramped: ${JSON.stringify(box)}`,
					);
			};
			await checkDigest();
			await digest.click();
			await page
				.getByRole("button", { name: "Show less", exact: true })
				.waitFor();
			await checkDigest();
			const rhythm = await story.evaluate((el) => {
				const style = getComputedStyle(el);
				return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
			});
			if (rhythm > 24) throw new Error("Feed post spacing exceeded 24px");
			if ((await page.locator(".fd-moment").count()) < 1)
				throw new Error("Missing moment headers");
			if (await page.locator('article [data-slot="card"]').count())
				throw new Error("Feed reverted to stacked cards");
			if (
				await page.evaluate(
					() => document.documentElement.scrollWidth > innerWidth,
				)
			)
				throw new Error(`Feed overflows at ${width}/${theme}`);
			await page.close();
		}
	}

	for (const width of [390, 1440])
		for (const theme of ["light", "dark"]) {
			const page = await browser.newPage({
				viewport: { width, height: width === 390 ? 844 : 900 },
			});
			await page.goto(
				`${origin}/browser-tests/feed-deck-polish.html?shell&surface=question&theme=${theme}`,
			);
			const answer = page.getByRole("textbox", {
				name: "Your answer",
				exact: true,
			});
			await answer.waitFor();
			await settleAnimations(page);
			const layout = await page.evaluate(() => {
				const card = document.querySelector(".fd-card")!;
				const field = card.querySelector("textarea")!;
				const style = getComputedStyle(field);
				const why = card.querySelector(".fd-card-why")!.getBoundingClientRect();
				return {
					bar: document
						.querySelector(".fd-app-toolbar")!
						.getBoundingClientRect().height,
					gap:
						card.getBoundingClientRect().top -
						document.querySelector("header")!.getBoundingClientRect().bottom,
					field: field.getBoundingClientRect().height,
					min: 3 * parseFloat(style.lineHeight) + 24,
					inset: card.getBoundingClientRect().right - why.right,
					details:
						card.querySelector('[data-slot="card-header"] .fd-card-details') !==
						null,
					overflow: document.documentElement.scrollWidth > innerWidth,
				};
			});
			if (
				layout.bar > 50 ||
				layout.gap > 96 ||
				layout.field < layout.min ||
				layout.inset < 16 ||
				!layout.details ||
				layout.overflow
			)
				throw new Error(
					`Round 3 geometry ${width}/${theme}: ${JSON.stringify(layout)}`,
				);
			if (
				await page
					.getByRole("button", { name: "Answer", exact: true })
					.isEnabled()
			)
				throw new Error("Empty answer enabled");
			await answer.fill("Friday works for us.");
			await answer.press("End");
			await answer.press("Enter");
			await answer.press("x");
			if (!(await answer.inputValue()).includes("\n"))
				throw new Error("Enter submitted instead of adding a newline");
			if (
				!(await page
					.getByRole("button", { name: "Answer", exact: true })
					.isEnabled())
			)
				throw new Error("Nonempty answer stayed disabled");
			await answer.fill(
				Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n"),
			);
			const grown = await answer.evaluate((el) => ({
				height: el.getBoundingClientRect().height,
				max: 8 * parseFloat(getComputedStyle(el).lineHeight) + 26,
				scroll: el.scrollHeight,
				client: el.clientHeight,
			}));
			if (
				grown.height <= layout.field ||
				grown.height > grown.max + 1 ||
				grown.scroll <= grown.client
			)
				throw new Error(`Answer growth: ${JSON.stringify(grown)}`);
			await page.getByRole("button", { name: "Why this", exact: true }).click();
			await page
				.getByRole("heading", {
					name: "Learning your preferences",
					exact: true,
				})
				.waitFor();
			for (const name of [
				"Filters",
				"Shortcuts",
				"History",
				"What each choice does",
			])
				if (await page.getByRole("heading", { name, exact: true }).isVisible())
					throw new Error(`Unexpected context section: ${name}`);
			await page.keyboard.press("Escape");
			await page.getByRole("button", { name: "Details", exact: true }).click();
			await page
				.getByRole("heading", { name: "Details", exact: true })
				.first()
				.waitFor();
			await page.close();
		}

	for (const theme of ["light", "dark"]) {
		const preferred = await browser.newPage();
		await preferred.goto(
			`${origin}/browser-tests/feed-deck-polish.html?theme=${theme}`,
		);
		await openExamples(preferred);
		await preferred.keyboard.press("Escape");
		await preferred.locator(".fd-decision").focus();
		await preferred.keyboard.press("j");
		const fill = (selector: string) =>
			preferred
				.locator(selector)
				.evaluate((el) => getComputedStyle(el).backgroundColor);
		const [active, delegate, approve] = await Promise.all([
			fill(".fd-filter-chip:first-child"),
			fill('[data-decision-intent="delegate"]'),
			fill('[data-decision-intent="approve"]'),
		]);
		if (delegate === approve || approve === active)
			throw new Error(`Approve must be the only honey action in ${theme}`);
		await preferred.close();
	}
	const touch = await browser.newPage({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	await touch.goto(`${origin}/browser-tests/feed-deck-polish.html?cards=one`);
	await openExamples(touch);
	await touch.keyboard.press("Escape");
	const touchTitle = touch.locator('[data-slot="card-title"]');
	await touchTitle.scrollIntoViewIfNeeded();
	await settleAnimations(touch);
	const touchBox = (await touchTitle.boundingBox())!;
	const cdp = await touch.context().newCDPSession(touch);
	const point = { x: touchBox.x + 25, y: touchBox.y + 20 };
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [point],
	});
	for (let i = 1; i <= 8; i++)
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchMove",
			touchPoints: [{ x: point.x + i * 14, y: point.y }],
		});
	if (
		(await touch.locator(".fd-decision").getAttribute("data-dragging")) !==
		"true"
	)
		throw new Error("Touch drag lost physical feedback");
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchEnd",
		touchPoints: [],
	});
	await touch
		.waitForFunction(() =>
			document.body.textContent?.includes("1 practice choice"),
		)
		.catch((error) => {
			throw new Error("Touch swipe did not finish", { cause: error });
		});
	await touch.locator(".fd-closure").waitFor();
	await touch.close();
	const reduced = await browser.newPage({ reducedMotion: "reduce" });
	await reduced.goto(`${origin}/browser-tests/feed-deck-polish.html`);
	await reduced.locator(".fd-closure").waitFor();
	if (
		(await reduced
			.locator(".fd-closure-mark path")
			.evaluate((el) => getComputedStyle(el).animationName)) !== "none"
	)
		throw new Error("Reduced motion closure still animates");
	await reduced.close();
	const explicitReduced = await browser.newPage({
		reducedMotion: "no-preference",
	});
	await explicitReduced.goto(
		`${origin}/browser-tests/feed-deck-polish.html?motion=reduced&cards=one`,
	);
	await openExamples(explicitReduced);
	await explicitReduced.keyboard.press("Escape");
	const explicitBox = (await explicitReduced
		.locator('[data-slot="card-title"]')
		.boundingBox())!;
	await explicitReduced.mouse.move(explicitBox.x + 20, explicitBox.y + 20);
	await explicitReduced.mouse.down();
	await explicitReduced.mouse.move(explicitBox.x + 55, explicitBox.y + 20, {
		steps: 4,
	});
	if (
		(await explicitReduced
			.locator(".fd-decision")
			.getAttribute("data-dragging")) !== "false"
	)
		throw new Error("Explicit reduced motion still moves the card");
	await explicitReduced.mouse.up();
	await explicitReduced.close();
	const failed = await browser.newPage({
		viewport: { width: 390, height: 844 },
	});
	await failed.goto(
		`${origin}/browser-tests/feed-deck-polish.html?surface=motion-failure`,
	);
	const proposer = failed.locator(".fd-proposer p[title]");
	if (
		(await proposer.textContent()) !== "Codex" ||
		(await proposer.getAttribute("title")) !== "Codex" ||
		(await failed.locator('[data-harness-mark="codex"]').count()) !== 1
	)
		throw new Error(
			"Session identity must use the structured harness and hide opaque IDs",
		);
	if (
		await failed.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth,
		)
	)
		throw new Error("Session proposer overflowed the phone viewport");
	await failed.getByRole("button", { name: "Approve", exact: true }).click();
	await failed.getByRole("alert").waitFor();
	await failed.waitForTimeout(300);
	if (
		(await failed
			.locator(".fd-decision")
			.evaluate((el) => getComputedStyle(el).opacity)) !== "1"
	)
		throw new Error("Failed save left the card invisible");
	await failed.close();
	console.log(
		"Feed and Deck: 4 viewport/theme combinations, drag/spring-back, accent, timeline and reduced motion passed.",
	);
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await server.exited;
}
