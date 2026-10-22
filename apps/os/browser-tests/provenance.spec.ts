import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import { chromium, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = process.env.PROVENANCE_ORIGIN ?? `http://127.0.0.1:${port}`;
const server = process.env.PROVENANCE_ORIGIN
	? undefined
	: Bun.spawn(
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
	await waitForFixtureServer(`${origin}/browser-tests/provenance.html`, {
		server,
	});
	browser = await chromium.launch({ headless: true });
	for (const width of [1280, 390])
		for (const theme of ["light", "dark"] as const)
			for (const palette of ["default", "blue"]) {
				const page = await browser.newPage({
					viewport: { width, height: 1000 },
					colorScheme: theme,
					hasTouch: width === 390,
				});
				await page.route("https://assets.example.test/**", (route) =>
					route.fulfill({
						contentType: "image/svg+xml",
						body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="#166534"/><path d="M20 31V10m0 13L12 15m8 3 7-7" fill="none" stroke="white" stroke-width="3"/></svg>',
					}),
				);
				const errors: string[] = [];
				page.on("pageerror", (e) => errors.push(e.message));
				await page.goto(
					`${origin}/browser-tests/provenance.html?theme=${theme}&palette=${palette}`,
				);
				await page
					.getByText("Juniper for Morgan Lee", { exact: true })
					.first()
					.waitFor();
				await page.evaluate(() => document.fonts.ready);
				await page.evaluate(async () => {
					await Promise.all(
						document
							.getAnimations()
							.map((animation) => animation.finished.catch(() => {})),
					);
				});
				if (
					await page.evaluate(
						() => document.documentElement.scrollWidth > innerWidth,
					)
				)
					throw new Error(`Horizontal overflow: ${width}/${theme}/${palette}`);
				if (errors.length) throw new Error(errors.join("\n"));
				if (
					(await page
						.getByText("Lark for Morgan Lee", { exact: true })
						.count()) !== 1
				)
					throw new Error("Second configured agent missing");
				if (
					!(await page
						.getByText("Submitted by Intake service · System", { exact: true })
						.count())
				)
					throw new Error("Contributor replaced the actual submitter");
				if (width === 390) {
					const targets = await page
						.locator(".work-actor")
						.evaluateAll((nodes) =>
							nodes.map((node) => ({
								width: node.getBoundingClientRect().width,
								height: node.getBoundingClientRect().height,
							})),
						);
					if (targets.some((target) => target.width < 44 || target.height < 44))
						throw new Error("Actor target below 44px");
					await page
						.getByRole("button", { name: "More actions", exact: true })
						.first()
						.click();
					await page
						.getByRole("menuitem", { name: "Receipt", exact: true })
						.click();
				} else {
					await page.locator(".focus-row").first().hover();
					await page
						.getByRole("button", { name: "Receipt", exact: true })
						.first()
						.focus();
					await page.keyboard.press("Enter");
				}
				await page
					.getByText(
						"Authenticated actor: external_agent:22222222-2222-4222-8222-000000000001",
						{ exact: true },
					)
					.first()
					.waitFor();
				if (process.env.PROVENANCE_SCREENSHOT_DIR)
					await page.screenshot({
						path: `${process.env.PROVENANCE_SCREENSHOT_DIR}/provenance-${width}-${theme}-${palette}.png`,
						fullPage: true,
					});
				console.log(
					`PASS provenance ${width}/${theme}/${palette}: contributors, submitters, evidence, keyboard/touch, no overflow`,
				);
				await page.close();
			}
} finally {
	await browser?.close();
	if (server) {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch {
			server.kill();
		}
		await server.exited;
	}
}
