import { chromium, type Browser } from "playwright";
import { mkdir } from "node:fs/promises";

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
const evidenceDir = process.env.MEMBER_EVIDENCE_DIR;
let browser: Browser | undefined;
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		try {
			ready = (await fetch(`${origin}/browser-tests/members.html`)).ok;
		} catch {}
		if (ready) break;
		await Bun.sleep(200);
	}
	if (!ready) throw new Error("Member proof server did not start");
	if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
	browser = await chromium.launch({ headless: true });
	for (const locale of ["en", "es"])
		for (const [width, height] of [
			[390, 844],
			[1512, 794],
		] as const)
			for (const theme of ["light", "dark"]) {
				const page = await browser.newPage({
					viewport: { width, height },
					colorScheme: theme as "light" | "dark",
				});
				const requests: string[] = [];
				const resizeErrors: string[] = [];
				page.on("pageerror", (error) => {
					if (error.message.includes("ResizeObserver"))
						resizeErrors.push(error.message);
				});
				page.on("request", (request) => {
					if (request.url().includes("/api/")) requests.push(request.url());
				});
				await page.goto(
					`${origin}/browser-tests/members.html?locale=${locale}&theme=${theme}`,
				);
				await page.locator(".fd-decision").waitFor();
				const text = await page.locator("body").innerText();
				if (
					!(await page
						.getByRole("button", {
							name: "Decision context",
							exact: true,
						})
						.isVisible())
				)
					throw new Error(
						"Work did not land on the configured Deck in the member's locale",
					);
				if (!text.includes("Review Luz's inbox follow-up?"))
					throw new Error("Member's own factory card is missing");
				if (text.includes("PRIVATE_OWNER_SENTINEL"))
					throw new Error("Another person's private card leaked");
				if (
					await page.evaluate(
						() => document.documentElement.scrollWidth > innerWidth,
					)
				)
					throw new Error(`Member Deck overflow at ${width}/${locale}`);
				await page.locator("[data-decision-actions]").waitFor();
				await page.evaluate(() =>
					Promise.all(
						document
							.getAnimations()
							.map((animation) => animation.finished.catch(() => {})),
					),
				);
				const layout = await page.locator(".fd-card").evaluate((card) => {
					const bounds = card.getBoundingClientRect();
					const actions = card
						.querySelector("[data-decision-actions]")!
						.getBoundingClientRect();
					const body = card
						.querySelector('[data-slot="card-content"]')!
						.getBoundingClientRect();
					return {
						bottom: bounds.bottom,
						actionsBottom: actions.bottom,
						bodyHeight: body.height,
						viewportHeight: innerHeight,
					};
				});
				if (
					layout.bodyHeight < 44 ||
					layout.actionsBottom >
						Math.min(layout.bottom, layout.viewportHeight) + 1
				)
					throw new Error(
						`Member factory card is clipped: ${JSON.stringify(layout)}`,
					);
				if (evidenceDir)
					await page.screenshot({
						path: `${evidenceDir}/member-deck-${locale}-${width}-${theme}.png`,
						fullPage: true,
					});
				const later = locale === "es" ? "Más tarde" : "Later";
				if (width < 640) {
					// Phones keep Later in the Deck action row's "⋯" menu.
					await page
						.getByRole("button", {
							name: locale === "es" ? "Más acciones" : "More actions",
						})
						.click();
					await page.getByRole("menuitem", { name: later }).click();
				} else
					await page.getByRole("button", { name: later, exact: true }).click();
				await page.waitForFunction(
					() =>
						!document
							.querySelector(".fd-decision")
							?.textContent?.includes("Review Luz's inbox follow-up?"),
				);
				const keys = await page.evaluate(() => Object.keys(localStorage));
				if (
					!keys.some((key) => key.endsWith(":fictional-luz")) ||
					keys.includes("tedix.cardReview.snoozes")
				)
					throw new Error("Factory snooze is not scoped to this person");
				await page.goto(
					`${origin}/browser-tests/members.html?view=feed&locale=${locale}&theme=${theme}`,
				);
				await page.getByText("Everything", { exact: true }).click();
				await page.locator("article").first().waitFor();
				const feed = await page.locator("body").innerText();
				for (const title of [
					"Prepare a short reply",
					"A useful introduction",
					"Review the opportunity together",
				])
					if (!feed.includes(title))
						throw new Error(`Own/shared factory story missing: ${title}`);
				if (
					feed.includes("PRIVATE_OWNER_SENTINEL") ||
					requests.some((url) =>
						url.includes("11111111-1111-4111-8111-000000000006"),
					)
				)
					throw new Error("Private factory content was requested or rendered");
				if (evidenceDir)
					await page.screenshot({
						path: `${evidenceDir}/member-feed-${locale}-${width}-${theme}.png`,
						fullPage: true,
					});
				if (resizeErrors.length)
					throw new Error(`Deck resize loop: ${resizeErrors.join("; ")}`);
				await page.close();
			}
	const linked = await browser.newPage();
	const card = (suffix: string) =>
		`factory:11111111-1111-4111-8111-${suffix}:0`;
	await linked.goto(
		`${origin}/browser-tests/members.html?locale=en#card=${encodeURIComponent(card("000000000011"))}`,
	);
	await linked.locator(".fd-decision").waitFor();
	const linkedText = await linked.locator(".fd-decision").innerText();
	if (
		!linkedText.includes("Luz · Social introduction") ||
		linkedText.includes("Luz · Inbox follow-up")
	)
		throw new Error("Factory link did not select its exact non-default card");
	await linked.goto(
		`${origin}/browser-tests/members.html?locale=en#card=${encodeURIComponent(card("000000000013"))}`,
	);
	await linked
		.getByText("That decision is no longer available in this view.", {
			exact: true,
		})
		.waitFor();
	if (
		(await linked.locator("body").innerText()).includes(
			"PRIVATE_OWNER_SENTINEL",
		)
	)
		throw new Error("Linked private factory card was exposed");
	await linked.close();
	console.log(
		"PASS: fictional non-admin Work landing, own/shared sources, private-source exclusion, per-person snooze and English/Spanish; phone/desktop × light/dark",
	);
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch {
		server.kill();
	}
	await server.exited;
}
