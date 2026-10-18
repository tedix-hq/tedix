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
			await page
				.getByRole("button", { name: "Decision context", exact: true })
				.click();
			await page
				.getByRole("button", { name: "Try examples", exact: true })
				.click();
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
			await page.mouse.move(x + 35, y, { steps: 5 });
			if (
				(await page.locator(".fd-decision").getAttribute("data-dragging")) !==
				"true"
			)
				throw new Error("Card does not follow drag");
			await page.mouse.up();
			await page.waitForTimeout(550);
			if (
				(await page.locator(".fd-decision").getAttribute("data-dragging")) !==
				"false"
			)
				throw new Error("Short drag did not spring back");
			if (await page.evaluate(() => Boolean(getSelection()?.toString())))
				throw new Error(
					"Card drag selected text instead of owning the gesture",
				);
			await settleAnimations(page);
			const settledBox = (await title.boundingBox())!;
			const swipeX = settledBox.x + 30;
			const swipeY = settledBox.y + 20;
			await page.mouse.move(swipeX, swipeY);
			await page.mouse.down();
			await page.mouse.move(swipeX + 110, swipeY, { steps: 12 });
			await page.mouse.up();
			await page
				.waitForFunction(() =>
					document.body.textContent?.includes("1 practice choice"),
				)
				.catch((error) => {
					throw new Error(
						`Mouse swipe did not finish at ${width}px in ${theme} mode`,
						{ cause: error },
					);
				});
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
			await page
				.getByRole("button", { name: "Decision context", exact: true })
				.click();
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
	for (const theme of ["light", "dark"]) {
		const preferred = await browser.newPage();
		await preferred.goto(
			`${origin}/browser-tests/feed-deck-polish.html?theme=${theme}`,
		);
		await preferred
			.getByRole("button", { name: "Decision context", exact: true })
			.click();
		await preferred
			.getByRole("button", { name: "Try examples", exact: true })
			.click();
		await preferred.keyboard.press("Escape");
		await preferred.locator(".fd-decision").focus();
		await preferred.keyboard.press("j");
		const fill = (selector: string) =>
			preferred
				.locator(selector)
				.evaluate((el) => getComputedStyle(el).backgroundColor);
		const [active, delegate, approve] = await Promise.all([
			fill('.fd-deck-toolbar [aria-pressed="true"]'),
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
	await touch
		.getByRole("button", { name: "Decision context", exact: true })
		.click();
	await touch
		.getByRole("button", { name: "Try examples", exact: true })
		.click();
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
	await explicitReduced
		.getByRole("button", { name: "Decision context", exact: true })
		.click();
	await explicitReduced
		.getByRole("button", { name: "Try examples", exact: true })
		.click();
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
