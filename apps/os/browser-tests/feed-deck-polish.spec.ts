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
				expectedText: getComputedStyle(el)
					.getPropertyValue("--primary-foreground")
					.trim(),
			}));
			if (
				colors.text !==
					(theme === "light" ? "rgb(255, 255, 255)" : "rgb(3, 3, 3)") ||
				colors.fill === "rgba(0, 0, 0, 0)"
			)
				throw new Error(
					`Approve lost its tenant fill or contrasting text: ${JSON.stringify(colors)}`,
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
			if (
				await page.evaluate(
					() => document.documentElement.scrollWidth > innerWidth,
				)
			)
				throw new Error(`Focus feed overflows at ${width}/${theme}`);
			const forYouCount = await page.locator("[data-focus-row]").count();
			if (forYouCount > 5)
				throw new Error("For you exceeded its first-screen item limit");
			const handled = page.getByRole("button", {
				name: /Handled without you:/,
			});
			if (await handled.count()) {
				await handled.click();
				const singleLine = await page
					.locator(".focus-handled-row .ft-sentence")
					.evaluateAll((nodes) =>
						nodes.every(
							(node) =>
								node.getBoundingClientRect().height <=
								parseFloat(getComputedStyle(node).lineHeight) + 1,
						),
					);
				if (!singleLine)
					throw new Error("Handled outcomes must expand as one-line receipts");
				await handled.click();
			}
			await page.keyboard.press("j");
			if (
				!(await page
					.locator("[data-focus-row]")
					.first()
					.evaluate((el) => el === document.activeElement))
			)
				throw new Error("j did not focus the first feed row");
			await page.keyboard.press("j");
			await page.keyboard.press("k");
			const story = page.locator("article").first();
			await story.getByRole("button", { name: "Receipt", exact: true }).click();
			await story.locator(".fd-preview").waitFor();
			const actions = story.locator("..").locator(".focus-actions");
			const geometry = await actions.evaluate((row) => ({
				gap: getComputedStyle(row).gap,
				clearance:
					row.getBoundingClientRect().top -
					row.previousElementSibling!.getBoundingClientRect().bottom,
				buttons: [...row.querySelectorAll("button")].map((button) => {
					const icon = button.querySelector("svg");
					const style = getComputedStyle(button);
					return {
						height: button.getBoundingClientRect().height,
						padding: [style.paddingLeft, style.paddingRight],
						icon: icon ? icon.getBoundingClientRect().width : 0,
						muted: icon && getComputedStyle(icon).color === style.color,
					};
				}),
			}));
			if (
				geometry.gap !== "8px" ||
				geometry.clearance < 8 ||
				geometry.buttons.length !== 4 ||
				geometry.buttons.some(
					(b) =>
						b.height < (width === 390 ? 44 : 36) ||
						b.padding.some((p) => parseFloat(p) < 12) ||
						b.icon < 16 ||
						!b.muted,
				)
			)
				throw new Error(
					`Feed actions ${width}/${theme}: ${JSON.stringify(geometry)}`,
				);
			const pin = actions.getByRole("button", { name: "Pin", exact: true });
			const pinBefore = await pin.boundingBox();
			await pin.hover();
			const pinHover = await pin.boundingBox();
			await pin.focus();
			const pinFocus = await pin.boundingBox();
			if (
				!pinBefore ||
				!pinHover ||
				!pinFocus ||
				[pinHover, pinFocus].some(
					(box) =>
						box.width !== pinBefore.width || box.height !== pinBefore.height,
				)
			)
				throw new Error("Feed action hover/focus changed its hit area");
			const feedFilters = page.getByRole("button", {
				name: "Filters",
				exact: true,
			});
			if (await feedFilters.isVisible()) await feedFilters.click();
			await page.getByText("Everything", { exact: true }).click();
			await page.keyboard.press("Escape");
			await page.getByRole("feed", { name: "Everything" }).waitFor();
			if ((await page.locator("[data-focus-row]").count()) !== 17)
				throw new Error("Everything lost canonical fixture records");
			if (
				await page.getByRole("button", { name: /Handled without you:/ }).count()
			)
				throw new Error("Everything folded records");
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
			throw new Error(`Approve must be the only primary action in ${theme}`);
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
