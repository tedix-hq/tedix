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
	for (const width of [390, 1199, 1280, 1600, 2000]) {
		for (const theme of ["light", "dark"] as const) {
			for (const surface of ["feed", "question"]) {
				const page = await browser.newPage({
					viewport: { width, height: 844 },
					colorScheme: theme,
				});
				await page.goto(
					`${origin}/browser-tests/feed-deck-polish.html?shell&surface=${surface}&theme=${theme}`,
				);
				const trigger = page.locator("header").getByRole("button", {
					name: "Decision context",
					exact: true,
				});
				await trigger.waitFor();
				const before = (await page.locator(".fd-context-main").boundingBox())!;
				const target = (await trigger.boundingBox())!;
				if (width === 390 && (target.width < 44 || target.height < 44))
					throw new Error("Context entry is below the mobile touch floor");
				await trigger.focus();
				await page.keyboard.press("Enter");
				const dialog = page.locator("[data-decision-context]:visible");
				await dialog.waitFor();
				await settleAnimations(page);
				const after = (await page.locator(".fd-context-main").boundingBox())!;
				if (
					width < 1200 &&
					(Math.abs(before.width - after.width) > 1 ||
						Math.abs(before.x - after.x) > 1)
				)
					throw new Error("Opening context changed the main column geometry");
				const rail = (await dialog.boundingBox())!;
				if (width >= 1200) {
					const expected = Math.min(360, Math.max(300, width * 0.24));
					if (rail.width > 360 || Math.abs(rail.width - expected) > 1)
						throw new Error(`Context rail width ${rail.width} at ${width}`);
					if (Math.abs(rail.x - after.x - after.width - 32) > 1)
						throw new Error("Card and rail gap is not 32px");
					if (Math.abs(after.x - (width - rail.x - rail.width)) > 1)
						throw new Error("Card and rail group is not centered");
				} else if ((await dialog.getAttribute("role")) !== "dialog") {
					throw new Error("Narrow context did not use the topbar Sheet");
				}
				console.log(
					JSON.stringify({
						surface,
						width,
						theme,
						railWidth: rail.width,
						gap: width >= 1200 ? rail.x - after.x - after.width : null,
					}),
				);
				if (process.env.TEDIX_SCREENSHOT_DIR && width !== 1199)
					await page.screenshot({
						path: `${process.env.TEDIX_SCREENSHOT_DIR}/work-rail-${surface === "question" ? "deck" : "feed"}-${width}-${theme}.png`,
					});
				for (let i = 0; width < 1200 && i < 8; i++) {
					await page.keyboard.press("Tab");
					await page.waitForFunction(() =>
						document.activeElement?.closest("[data-decision-context]"),
					);
				}
				if (
					await page.evaluate(
						() => document.documentElement.scrollWidth > innerWidth,
					)
				)
					throw new Error(`Context overflows at ${width}/${theme}`);
				await page.keyboard.press("Escape");
				await dialog.waitFor({ state: "hidden" });
				await page.waitForFunction(
					() =>
						document.activeElement?.getAttribute("aria-label") ===
						"Decision context",
				);
				await page.keyboard.press("i");
				await dialog.waitFor();
				await page.reload();
				await dialog.waitFor();
				await dialog
					.getByRole("button", { name: "Close decision context" })
					.click();
				await dialog.waitFor({ state: "hidden" });
				await page.keyboard.press("Tab");
				if (
					await page.evaluate(() =>
						Boolean(document.activeElement?.closest("[data-decision-context]")),
					)
				)
					throw new Error("Closed context remained in keyboard navigation");
				if (surface === "question") {
					await page.getByRole("textbox", { name: "Your answer" }).press("i");
					if (await dialog.isVisible())
						throw new Error("Typing i opened context");
					await page
						.getByRole("button", { name: "Why this", exact: true })
						.click();
					await dialog
						.getByRole("heading", { name: "Why this", exact: true })
						.waitFor();
					await page.keyboard.press("Escape");
					await dialog.waitFor({ state: "hidden" });
					await page
						.getByRole("button", { name: "Details", exact: true })
						.click();
					await dialog
						.getByRole("heading", { name: "Details", exact: true })
						.waitFor();
				}
				await page.close();
			}
		}
	}
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
			const deckGeometry = await page.locator(".fd-card").evaluate((card) => {
				const notice = document
					.querySelector(".fd-practice-notice")!
					.getBoundingClientRect();
				const box = card.getBoundingClientRect();
				return {
					left: notice.left - box.left,
					gap: box.top - notice.bottom,
					details: getComputedStyle(card.querySelector(".fd-card-details")!)
						.fontSize,
					whyMargin: getComputedStyle(card.querySelector(".fd-card-why")!)
						.marginLeft,
				};
			});
			if (
				Math.abs(deckGeometry.left) > 1 ||
				deckGeometry.gap !== 12 ||
				deckGeometry.details !== "13px" ||
				deckGeometry.whyMargin !== "0px"
			)
				throw new Error(
					`Deck notice and tertiary actions: ${JSON.stringify(deckGeometry)}`,
				);
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
			await story
				.getByRole("button", { name: "More actions", exact: true })
				.click();
			await page
				.getByRole("menuitem", { name: "Receipt", exact: true })
				.click();
			await story.locator(".fd-preview").waitFor();
			const actions = story.locator("..").locator(".focus-actions");
			const row = story.locator("..");
			await row.hover();
			const geometry = await row.evaluate((el) => {
				const actions = el.querySelector<HTMLElement>(".focus-actions")!;
				const control = el.querySelector<HTMLButtonElement>(
					'[aria-label="More actions"]',
				)!;
				return {
					padding: getComputedStyle(el).padding,
					inline: getComputedStyle(actions).display !== "none",
					count: actions.querySelectorAll("button").length,
					target: control.getBoundingClientRect().height,
				};
			});
			if (
				geometry.padding !== "12px 16px" ||
				geometry.inline !== width > 640 ||
				geometry.count !== 8 ||
				geometry.target < (width === 390 ? 44 : 32)
			)
				throw new Error(
					`Feed row ${width}/${theme}: ${JSON.stringify(geometry)}`,
				);
			await row
				.getByRole("button", { name: "More actions", exact: true })
				.click();
			for (const name of [
				"Receipt",
				"Comment",
				"Why this update",
				"Turn into Work",
				"Pin",
				"Hide",
				"Not important",
				"Tell me earlier",
			])
				await page.getByRole("menuitem", { name, exact: true }).waitFor();
			await page.keyboard.press("Escape");
			if (width > 640) {
				const pin = actions.getByRole("button", { name: "Pin", exact: true });
				const before = await pin.boundingBox();
				await pin.focus();
				const after = await pin.boundingBox();
				if (
					!before ||
					!after ||
					before.width !== after.width ||
					before.height !== after.height
				)
					throw new Error("Feed action focus changed its hit area");
			}
			const rhythm = await page.locator(".focus-feed").evaluate((el) => {
				const control = el.querySelector('[aria-label="Feed order"]')!;
				const summary = el.querySelector(".focus-budget")!;
				return {
					gap: getComputedStyle(el).gap,
					summary:
						summary.getBoundingClientRect().top -
						control.getBoundingClientRect().bottom,
				};
			});
			if (rhythm.summary !== 8 || rhythm.gap !== "32px")
				throw new Error(`Feed rhythm: ${JSON.stringify(rhythm)}`);
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
			const everythingStory = page
				.getByRole("feed", { name: "Everything" })
				.locator(".fd-story")
				.first();
			await everythingStory
				.getByRole("button", { name: "More actions", exact: true })
				.click();
			await page
				.getByRole("menuitem", { name: "Comment", exact: true })
				.click();
			await everythingStory
				.getByRole("textbox", { name: "Your correction", exact: true })
				.waitFor();
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
		await preferred
			.getByRole("button", { name: "Details", exact: true })
			.click();
		const context = preferred.locator("[data-decision-context]:visible");
		await context.getByRole("button", { name: /Decide for me/ }).waitFor();
		await context
			.getByRole("button", { name: "Change", exact: true })
			.waitFor();
		await preferred.keyboard.press("Escape");
		await context.waitFor({ state: "hidden" });
		await preferred.locator(".fd-decision").focus();
		await preferred.keyboard.press("d");
		await preferred.getByText("1 of 5", { exact: true }).waitFor();
		await preferred.close();
	}
	const retry = await browser.newPage({
		viewport: { width: 2000, height: 1000 },
	});
	await retry.route("**/api/rpc/learningFeedback/listInteractions**", (route) =>
		route.fulfill({ json: { json: { events: [] } } }),
	);
	await retry.route("**/api/rpc/workApprovals/listInbox**", (route) =>
		route.fulfill({
			json: {
				json: {
					data: [],
					hasMore: false,
					nextCursor: null,
					observedAt: new Date().toISOString(),
				},
			},
		}),
	);
	await retry.route("**/api/rpc/tediApprovals/list**", (route) =>
		route.fulfill({
			json: {
				json: {
					data: [],
					pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
				},
			},
		}),
	);
	let olderFails = true;
	let approvalFails = true;
	let olderReads = 0;
	let approvalReads = 0;
	await retry.route(
		"**/api/rpc/workInteractions/listInbox**",
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const input =
				request.method() === "GET"
					? (JSON.parse(url.searchParams.get("data") ?? "{}").json ?? {})
					: (request.postDataJSON()?.json ?? {});
			if (input.cursor) olderReads++;
			if (input.decisionKind) approvalReads++;
			if ((input.cursor && olderFails) || (input.decisionKind && approvalFails))
				return route.fulfill({ status: 503, body: "Temporary source failure" });
			return route.fulfill({
				json: {
					json: {
						data: [],
						hasMore: false,
						nextCursor: null,
						observedAt: new Date().toISOString(),
					},
				},
			});
		},
	);
	await retry.goto(
		`${origin}/browser-tests/feed-deck-polish.html?shell&surface=question&retry&motion=reduced`,
	);
	const banner = retry
		.getByRole("status")
		.filter({ hasText: "Some items couldn't load" });
	await banner.waitFor();
	await retry.locator(".fd-decision").waitFor();
	const bannerBox = (await banner.boundingBox())!;
	const cardBox = (await retry.locator(".fd-decision").boundingBox())!;
	if (
		Math.abs(bannerBox.x - cardBox.x) > 1 ||
		Math.abs(bannerBox.width - cardBox.width) > 1
	)
		throw new Error("Source error notice is outside the card column");
	if (await retry.getByRole("alert").count())
		throw new Error("Partial source failure rendered a full error banner");
	if (process.env.TEDIX_SCREENSHOT_DIR)
		await retry.screenshot({
			path: `${process.env.TEDIX_SCREENSHOT_DIR}/work-rail-error-before-retry.png`,
		});
	olderFails = false;
	const partialRetry = retry.waitForResponse(
		(response) =>
			response.url().includes("/workInteractions/listInbox") &&
			response.status() === 503,
	);
	await banner.getByRole("button", { name: "Try again" }).click();
	await (await partialRetry).finished();
	await banner.getByRole("button", { name: "Try again" }).waitFor();
	if (olderReads < 2 || approvalReads < 1 || !(await banner.isVisible()))
		throw new Error(
			"Retry skipped a source or cleared while another source still failed",
		);
	approvalFails = false;
	await banner.getByRole("button", { name: "Try again" }).click();
	await banner.waitFor({ state: "hidden" });
	if (process.env.TEDIX_SCREENSHOT_DIR)
		await retry.screenshot({
			path: `${process.env.TEDIX_SCREENSHOT_DIR}/work-rail-error-after-retry.png`,
		});
	await retry.close();
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
		"Feed and Deck: bounded context rail, responsive Sheets, retry recovery, drag/spring-back, accent, timeline and reduced motion passed.",
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
