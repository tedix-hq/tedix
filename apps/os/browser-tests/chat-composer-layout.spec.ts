import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

// The composer footer must hold every control on one row at any pane width
// from 280px up: no control may overlap another, leave the row, or paint its
// label over its own icon. It sizes from its own width (a container query),
// so the workspace side chat and a phone get the same compact row.
const workspacePath =
	"/workspace/00000030-0000-4000-8000-000000000001?pane=chat";
const surfaces = [
	{ name: "chat page", path: "/chat" },
	{ name: "workspace chat", path: workspacePath },
] as const;
const shots = process.env.CHAT_COMPOSER_LAYOUT_SHOTS;
const server = await startFixtureServer("/chat");
const browser = await chromium.launch({ headless: true });

type Box = {
	name: string;
	left: number;
	right: number;
	top: number;
	bottom: number;
};

/** Every layout defect in the composer footer, as readable strings. */
async function footerDefects(page: Page) {
	return page.locator(".chat-composer-actions").evaluate((row) => {
		const defects: string[] = [];
		const rect = (el: Element) => el.getBoundingClientRect();
		// A collapsed label stays as a 1px screen-reader name; it is not drawn.
		const visible = (el: Element) => {
			const box = rect(el);
			return box.width > 1 && box.height > 1;
		};
		const nameOf = (el: Element) =>
			el.getAttribute("aria-label") ||
			el.textContent?.trim() ||
			el.className.toString();
		const rowBox = rect(row);
		const form = row.closest("form")!;
		if (form.scrollWidth > form.clientWidth + 1)
			defects.push(
				`composer scrolls sideways (${form.scrollWidth} > ${form.clientWidth})`,
			);
		const controls = Array.from(
			row.querySelectorAll("button, [role='label']"),
		).filter(
			(el) =>
				visible(el) &&
				!el.parentElement?.closest("button, [role='label']") &&
				getComputedStyle(el).visibility !== "hidden",
		);
		const boxes: Box[] = controls.map((el) => {
			const box = rect(el);
			return {
				name: nameOf(el),
				left: box.left,
				right: box.right,
				top: box.top,
				bottom: box.bottom,
			};
		});
		for (const box of boxes) {
			if (box.left < rowBox.left - 0.5 || box.right > rowBox.right + 0.5)
				defects.push(`"${box.name}" leaves the row`);
		}
		for (let i = 0; i < boxes.length; i++)
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i]!;
				const b = boxes[j]!;
				const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
				const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
				if (x > 0.5 && y > 0.5)
					defects.push(`"${a.name}" overlaps "${b.name}"`);
			}
		for (const button of controls.filter((el) => el.tagName === "BUTTON")) {
			const box = rect(button);
			const parts = Array.from(button.querySelectorAll("svg, span")).filter(
				(el) =>
					visible(el) &&
					(el.tagName === "svg" ||
						(el.children.length === 0 && Boolean(el.textContent?.trim()))),
			);
			for (const part of parts) {
				const inner = rect(part);
				if (inner.left < box.left - 0.5 || inner.right > box.right + 0.5)
					defects.push(`"${nameOf(button)}" content spills out of the button`);
			}
			const icons = parts.filter((el) => el.tagName === "svg");
			const labels = parts.filter((el) => el.tagName !== "svg");
			for (const icon of icons)
				for (const label of labels) {
					const a = rect(icon);
					const b = rect(label);
					if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5)
						defects.push(`"${nameOf(button)}" draws its label over its icon`);
				}
			if (button.getAttribute("type") === "submit" && box.width < 28)
				defects.push(`send button shrank to ${box.width}px`);
		}
		return defects;
	});
}

async function openComposer(page: Page, path: string) {
	await page.goto(`${server.origin}${path}`);
	await page.locator(".chat-composer-actions").waitFor();
	await page
		.getByRole("button", { name: "Send message", exact: true })
		.waitFor();
}

try {
	for (const theme of ["light", "dark"] as const) {
		for (const width of [320, 375, 560, 1280]) {
			const phone = width < 640;
			const context = await browser.newContext({
				viewport: { width, height: 844 },
				colorScheme: theme,
				isMobile: phone,
				hasTouch: phone,
			});
			const page = await context.newPage();
			for (const surface of surfaces) {
				const label = `${surface.name} ${width}px ${theme}`;
				await openComposer(page, surface.path);
				const defects = await footerDefects(page);
				assert.deepEqual(defects, [], label);
				if (surface.path === workspacePath) {
					const upload = page.getByRole("button", {
						name: "Upload file",
						exact: true,
					});
					assert(
						await upload.isVisible(),
						`${label}: Upload file is reachable`,
					);
					if (!phone) {
						// Icon-only beside the editor, so the name shows on hover.
						await upload.hover();
						await page
							.locator("[data-base-ui-portal]")
							.getByText("Upload file", { exact: true })
							.waitFor();
						await page.mouse.move(0, 0);
					}
				}
				if (shots) {
					await mkdir(shots, { recursive: true });
					await page.locator('[data-slot="chat-composer"]').screenshot({
						path: `${shots}/${surface.name.replace(" ", "-")}-${width}-${theme}.png`,
					});
				}
			}
			await context.close();
		}
	}

	// Pane widths the viewport alone never produces: a desktop window with the
	// chat squeezed or widened beside an editor. Resize the chat column itself.
	const page = await browser.newPage({
		viewport: { width: 1280, height: 844 },
	});
	for (const surface of surfaces) {
		await openComposer(page, surface.path);
		for (let pane = 280; pane <= 800; pane += 24) {
			await page.locator('[data-slot="chat-composer"]').evaluate((form, px) => {
				const host = form.parentElement as HTMLElement;
				host.style.width = `${px}px`;
				host.style.minWidth = `${px}px`;
				host.style.maxWidth = `${px}px`;
				host.style.flex = "none";
			}, pane);
			const defects = await footerDefects(page);
			assert.deepEqual(defects, [], `${surface.name} at a ${pane}px pane`);
		}
	}
	console.log("chat composer layout ok");
} finally {
	await browser.close();
	await server.stop();
}
