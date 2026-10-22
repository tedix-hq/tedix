import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence =
	process.env.B13_BUNDLE_EVIDENCE_DIR ??
	(process.env.TEDIX_LANE_LOG
		? join(dirname(process.env.TEDIX_LANE_LOG), "b13-skill-bundle-selection")
		: new URL(
				"../node_modules/.cache/b13-skill-bundle-selection/",
				import.meta.url,
			).pathname);
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer(
	"/browser-tests/b13-skill-bundle-selection.html",
	{
		stdout: Bun.file(`${evidence}/server.stdout.log`),
		stderr: Bun.file(`${evidence}/server.stderr.log`),
	},
);
const url = `${server.origin}/browser-tests/b13-skill-bundle-selection.html`;
const checklist =
	"references/quarterly-supplier-onboarding-and-contract-renewal-checklist.md";
const checklistName =
	"quarterly-supplier-onboarding-and-contract-renewal-checklist.md";
type Fixture = Window & {
	bundleFixture: { refresh(next: string): void };
};
const report: unknown[] = [];
const errors: string[] = [];
let launchMode = "default";

// Sandboxed lanes deny Chromium's mach-port rendezvous; the single-process
// fallback renders identically for screenshot and measurement purposes.
async function launch() {
	try {
		return await chromium.launch({ headless: true });
	} catch {
		launchMode = "single-process";
		return chromium.launch({
			headless: true,
			args: ["--no-zygote", "--single-process"],
		});
	}
}

function label(page: Page) {
	return page.locator('section[aria-label="Skill bundle"] [data-slot="text"]');
}

async function refresh(page: Page, revision: string) {
	await page.evaluate(
		(next) => (window as Fixture).bundleFixture.refresh(next),
		revision,
	);
}

async function capture(
	page: Page,
	name: string,
	targetName: string,
	width: number,
	height: number,
	theme: string,
) {
	const target = page.getByRole("button", { name: targetName, exact: true });
	await target.focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Shift+Tab");
	const measurements = await page.evaluate(() => {
		const focused = document.activeElement as HTMLElement;
		const rectangle = focused.getBoundingClientRect();
		const style = getComputedStyle(focused);
		const targets = [
			...document.querySelectorAll<HTMLElement>(
				'nav[aria-label="Bundle files"] button',
			),
		]
			.filter((element) => element.offsetParent !== null)
			.map((element) => {
				const bounds = element.getBoundingClientRect();
				return {
					name: element.getAttribute("aria-label") ?? element.textContent,
					width: bounds.width,
					height: bounds.height,
				};
			});
		return {
			viewport: { width: innerWidth, height: innerHeight },
			theme: getComputedStyle(document.documentElement).colorScheme,
			surface: getComputedStyle(document.body).backgroundColor,
			overflow: document.documentElement.scrollWidth - innerWidth,
			focus: {
				name: focused.getAttribute("aria-label") ?? focused.textContent,
				visible: focused.matches(":focus-visible"),
				outlineStyle: style.outlineStyle,
				outlineWidth: style.outlineWidth,
				shadow: style.boxShadow,
				width: rectangle.width,
				height: rectangle.height,
			},
			targets,
		};
	});
	assert.deepEqual(measurements.viewport, { width, height });
	assert.equal(measurements.theme, theme);
	assert(measurements.overflow <= 1, JSON.stringify(measurements));
	assert(measurements.focus.visible, JSON.stringify(measurements));
	assert(
		measurements.focus.outlineStyle !== "none" ||
			measurements.focus.shadow !== "none",
		"focus has visible styling",
	);
	if (width < 640)
		for (const target of measurements.targets)
			assert(target.width >= 44 && target.height >= 44, JSON.stringify(target));
	await page.evaluate(() => scrollTo(0, 0));
	const bytes = await page.screenshot({ path: `${evidence}/${name}.png` });
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	assert.equal(view.getUint32(16), width);
	assert.equal(view.getUint32(20), height);
	report.push({
		label: name,
		...measurements,
		screenshot: { width: view.getUint32(16), height: view.getUint32(20) },
	});
}

try {
	for (const theme of ["light", "dark"] as const)
		for (const size of [
			{ width: 375, height: 667 },
			{ width: 390, height: 844 },
			{ width: 1280, height: 900 },
		]) {
			// A fresh browser per combo: the single-process fallback is not
			// stable across sequential pages in a sandboxed lane.
			const browser = await launch();
			const page = await browser.newPage({
				viewport: size,
				colorScheme: theme,
				reducedMotion: "reduce",
				hasTouch: size.width < 640,
				// Single-process Chromium misapplies mobile viewport emulation.
				isMobile:
					size.width < 640 && launchMode === "default" ? true : undefined,
			});
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("console", (message) => {
				if (message.type() === "error") errors.push(message.text());
			});
			const name = `${size.width}x${size.height}-${theme}`;
			await page.goto(`${url}?theme=${theme}`);
			const canonical = page.getByRole("button", {
				name: "SKILL.md",
				exact: true,
			});
			await canonical.waitFor();
			assert.equal(await label(page).textContent(), "SKILL.md");

			const references = page.getByRole("button", {
				name: "references",
				exact: true,
			});
			assert.equal(await references.getAttribute("aria-expanded"), "true");
			await references.click();
			assert.equal(await references.getAttribute("aria-expanded"), "false");
			assert.equal(
				await page
					.getByRole("button", { name: "glossary.md", exact: true })
					.count(),
				0,
			);
			await references.click();
			assert.equal(await references.getAttribute("aria-expanded"), "true");

			// Keyboard browsing: Tab moves through the tree, Enter selects a file.
			await canonical.focus();
			await page.keyboard.press("Tab");
			assert.equal(
				await page.evaluate(
					() => (document.activeElement as HTMLElement).textContent,
				),
				"references",
			);
			await page.keyboard.press("Tab");
			await page.keyboard.press("Enter");
			assert.equal(await label(page).textContent(), "references/glossary.md");
			await page.getByText("Glossary body v1", { exact: true }).waitFor();
			await page.keyboard.press("Tab");
			await page.keyboard.press("Enter");
			assert.equal(await label(page).textContent(), checklist);
			await page.getByText("Checklist body v1", { exact: true }).waitFor();
			assert(
				await page
					.getByRole("button", { name: checklistName, exact: true })
					.isVisible(),
			);
			await capture(
				page,
				`${name}-long-label`,
				checklistName,
				size.width,
				size.height,
				theme,
			);

			await refresh(page, "refreshed");
			assert.equal(await label(page).textContent(), checklist);
			await page.getByText("Checklist body v2", { exact: true }).waitFor();

			await refresh(page, "pruned");
			assert.equal(await label(page).textContent(), "SKILL.md");
			await page
				.getByText("Canonical instructions, second revision.", {
					exact: true,
				})
				.waitFor();
			assert.equal(
				await page
					.getByRole("button", { name: checklistName, exact: true })
					.count(),
				0,
			);
			await capture(
				page,
				`${name}-recovered`,
				"SKILL.md",
				size.width,
				size.height,
				theme,
			);
			await page.close();
			await browser.close();
		}
	assert.deepEqual(errors, []);
} finally {
	await writeFile(
		`${evidence}/measurements.json`,
		JSON.stringify({ launchMode, report, errors }, null, 2),
	);
	await server.stop();
}
console.log(
	`Skill bundle selection checks passed; ${report.length} dimension-checked screenshots in ${evidence}`,
);
