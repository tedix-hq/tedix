import {
	CardRevisionSchema,
	CardStyleRuleSchema,
} from "@tedix/api-contract/schemas/card-revisions";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Locator } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/browser-tests/card-revisions.html");
const { origin } = server;
const screenshotDirectory = process.env.CARD_REVISIONS_SCREENSHOT_DIR;
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
async function checkDisclosure(trigger: Locator, width: number) {
	await trigger.scrollIntoViewIfNeeded();
	const box = await trigger.boundingBox();
	assert(box);
	assert(
		box.height >= (width === 390 ? 44 : 32),
		`Disclosure height: ${box.height}px at ${width}px`,
	);
	assert(box.width >= 44);
	const containerWidth = await trigger.evaluate(
		(element) => element.parentElement!.getBoundingClientRect().width,
	);
	assert(Math.abs(box.width - containerWidth) < 1, "Disclosure fills its row");
	await trigger.click({ position: { x: box.width - 4, y: box.height - 4 } });
	assert.equal(await trigger.getAttribute("aria-expanded"), "true");
	await trigger.press("Space");
	assert.equal(await trigger.getAttribute("aria-expanded"), "false");
	await trigger.press("Enter");
	assert.equal(await trigger.getAttribute("aria-expanded"), "true");
}
try {
	for (const width of [1280, 390])
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: width === 390 ? 844 : 1000 },
				colorScheme: theme,
				hasTouch: width === 390,
				isMobile: width === 390,
				reducedMotion: "reduce",
			});
			let version = 2;
			const original =
				"Hi Morgan,\n\nI would like to share a detailed overview of the use case and discuss the next steps.\n\nBest, Robin";
			const revised =
				"Hi Morgan,\n\nHere is the use case we discussed. Would a short call next week work?\n\nBest, Robin";
			const requestId = "44444444-4444-4444-8444-444444444444";
			const revisions = [original, revised].map((body, index) =>
				CardRevisionSchema.parse({
					id: `11111111-1111-4111-8111-11111111111${index}`,
					orgId: "org",
					requestId,
					revision: index + 1,
					body,
					cause: index ? "agent_rewrite" : "initial",
					actorType: "tedi",
					actorId: "author",
					actorSessionId: null,
					instruction: index
						? "Make the introduction shorter and warmer."
						: null,
					responseId: null,
					summary: index ? "Shortened the introduction." : null,
					createdAt: "2026-10-19T20:00:00.000Z",
				}),
			);
			let styleRules: ReturnType<typeof CardStyleRuleSchema.parse>[] = [];
			let remembered = 0;
			let pending: {
				responseId: string;
				instruction: string;
				requestedAt: string;
			} | null = null;
			await page.route("**/api/rpc/workInteractions/**", async (route) => {
				const endpoint = new URL(route.request().url()).pathname
					.split("/")
					.at(-1);
				const data =
					route.request().method() === "GET"
						? JSON.parse(
								new URL(route.request().url()).searchParams.get("data") ?? "{}",
							)
						: route.request().postDataJSON();
				const input = data?.json ?? data;
				let json: unknown;
				if (endpoint === "cardHistory")
					json = { revisions, pending, styleRules, nextBeforeRevision: null };
				else if (endpoint === "get")
					json = {
						request: {
							id: requestId,
							version,
							metadata: { cardContent: revisions.at(-1)!.body },
						},
					};
				else if (endpoint === "requestCardChanges") {
					assert.equal(input.instruction, "Use a friendlier closing.");
					assert.deepEqual(input.chips, ["Warmer"]);
					assert.equal(input.anchors.length, 2);
					assert.equal(input.anchors[0].quote, "Hi Morgan,");
					assert.equal(input.anchors[0].chip, "Shorter");
					assert.equal(input.anchors[1].note, "Keep the greeting");
					assert.equal(input.anchors[0].field, "draft");
					pending = {
						responseId: "22222222-2222-4222-8222-222222222222",
						instruction: input.instruction,
						requestedAt: new Date().toISOString(),
					};
					version++;
					json = { id: requestId, version };
				} else if (endpoint === "rememberCardStyle") {
					remembered++;
					assert.equal(input.expectedRevision, 2);
					styleRules = [
						CardStyleRuleSchema.parse({
							id: crypto.randomUUID(),
							text: "For all email drafts: use a short introduction. Style only; preserve facts and authorization.",
							contentKind: "email",
							sourceRequestId: requestId,
							sourceRevision: 2,
							proposalId: crypto.randomUUID(),
							status: "active",
						}),
					];
					json = styleRules[0];
				} else if (endpoint === "reviewCardStyleRule") {
					const rule = styleRules[0]!;
					json = {
						...rule,
						status: input.decision === "not_true" ? "rejected" : "active",
					};
					if (input.decision === "not_true") styleRules = [];
				} else if (endpoint === "reviseCard") {
					version++;
					if (!input.restoreRevision) {
						assert.equal(input.keptHunks.length, 1);
						assert.equal(input.keptHunks[0].fromRevision, 2);
						assert.notEqual(input.body, revised);
					}
					revisions.push({
						...revisions[0]!,
						id: crypto.randomUUID(),
						revision: revisions.length + 1,
						body: input.body ?? original,
						proposal: input.proposal ?? null,
						cause: input.restoreRevision ? "restore" : "human_edit",
						keptHunks: input.keptHunks ?? null,
						parentRevision: input.restoreRevision ?? revisions.length,
						summary: input.summary ?? null,
						instruction: "Make the introduction shorter and warmer.",
					});
					json = revisions.at(-1);
				} else return route.abort();
				await route.fulfill({
					contentType: "application/json",
					body: JSON.stringify({ json }),
				});
			});
			await page.goto(`${origin}/browser-tests/card-revisions.html`);
			await page.evaluate((mode) => {
				document.documentElement.classList.toggle("dark", mode === "dark");
				document.documentElement.dataset.theme = mode;
			}, theme);
			await page
				.getByRole("button", { name: "Details", exact: true })
				.first()
				.waitFor();
			assert.equal(
				await page
					.getByRole("button", { name: "Ask for changes", exact: true })
					.isVisible(),
				false,
			);
			await page
				.getByRole("button", { name: "Details", exact: true })
				.first()
				.click();
			await page
				.getByRole("button", { name: "Ask for changes", exact: true })
				.waitFor();
			assert.equal(
				await page
					.getByText("Shortened the introduction.", { exact: true })
					.isVisible(),
				false,
			);
			await checkDisclosure(
				page.getByText("What changed", { exact: true }),
				width,
			);
			const credential = page.getByRole("region", {
				name: "Replace the Firecrawl key for the radar?",
				includeHidden: true,
			});
			assert.equal(await credential.locator("textarea").count(), 0);
			assert.equal(
				await credential
					.locator('a[href="/account/connections"]')
					.getAttribute("href"),
				"/account/connections",
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			);
			await page
				.getByText("Shortened the introduction.", { exact: true })
				.waitFor();
			await page
				.getByRole("button", { name: "Show clean", exact: true })
				.click();
			assert.equal(
				await page.getByLabel("Revision diff").textContent(),
				revised,
			);
			await page
				.getByRole("button", { name: "Show changes", exact: true })
				.click();
			assert.equal(remembered, 0);
			await page
				.getByRole("button", { name: "Yes, for all emails", exact: true })
				.click();
			await page
				.getByRole("button", { name: /^Keep original change/ })
				.first()
				.click();
			await page
				.getByText("Version 3", { exact: true })
				.filter({ visible: true })
				.first()
				.waitFor();
			await page.getByText("(Original kept)", { exact: true }).waitFor();
			assert.equal(
				await page
					.getByRole("button", { name: "Yes, for all emails", exact: true })
					.count(),
				0,
			);
			if (screenshotDirectory)
				await page.screenshot({
					path: `${screenshotDirectory}/card-revisions-${width}-${theme}.png`,
					fullPage: true,
					animations: "disabled",
				});

			await page.getByRole("button", { name: "Versions", exact: true }).click();
			await page.getByRole("button", { name: "Keep", exact: true }).click();
			await checkDisclosure(
				page.getByText("Version history", { exact: true }),
				width,
			);
			await page
				.getByRole("spinbutton", { name: "Compare from version" })
				.fill("1");
			await page
				.getByRole("spinbutton", { name: "Compare to version" })
				.fill("2");
			const comparison = page.getByLabel("Version comparison");
			assert.equal(
				await comparison.locator("p").first().textContent(),
				original,
			);
			assert.equal(await comparison.locator("p").last().textContent(), revised);
			if (screenshotDirectory)
				await page.screenshot({
					path: `${screenshotDirectory}/deck-feedback-${width}-${theme}-versions.png`,
					fullPage: true,
					animations: "disabled",
				});
			await page.getByRole("button", { name: "Not true", exact: true }).click();
			await page
				.getByRole("button", { name: "Not true", exact: true })
				.waitFor({ state: "detached" });
			assert.equal(remembered, 1);
			await page
				.getByRole("button", { name: "Restore version 1", exact: true })
				.click();
			await page
				.getByRole("button", { name: "Close decision context", exact: true })
				.click();
			if (width === 390)
				await page
					.getByRole("dialog", { name: "Decision context", exact: true })
					.waitFor({ state: "hidden" });
			await page
				.getByRole("button", { name: "Details", exact: true })
				.first()
				.click();
			await page
				.getByText("Version 4", { exact: true })
				.filter({ visible: true })
				.first()
				.waitFor();
			await page
				.getByRole("button", { name: "Close decision context", exact: true })
				.click();
			if (width === 390)
				await page
					.getByRole("dialog", { name: "Decision context", exact: true })
					.waitFor({ state: "hidden" });
			const card = page.getByRole("region", {
				name: "Send Morgan the use-case email?",
			});
			await card.focus();
			await page.keyboard.press("c");
			await page.waitForFunction(
				() =>
					document.activeElement?.getAttribute("aria-label") ===
					"What should change?",
			);
			await page
				.getByRole("button", { name: "Close decision context", exact: true })
				.click();
			if (width === 390)
				await page
					.getByRole("dialog", { name: "Decision context", exact: true })
					.waitFor({ state: "hidden" });
			const selectGreeting = async () => {
				await page
					.locator("[data-card-feedback-content]")
					.first()
					.evaluate((content) => {
						if (document.activeElement instanceof HTMLElement)
							document.activeElement.blur();
						const node = document
							.createTreeWalker(content, NodeFilter.SHOW_TEXT)
							.nextNode()!;
						const range = document.createRange();
						range.setStart(node, 0);
						range.setEnd(node, 10);
						window.getSelection()!.removeAllRanges();
						window.getSelection()!.addRange(range);
						if (!matchMedia("(pointer: coarse)").matches)
							content.dispatchEvent(
								new MouseEvent("mouseup", { bubbles: true }),
							);
					});
			};
			await selectGreeting();
			const pill = page.getByRole("dialog", {
				name: "Comment on selected text",
			});
			if (screenshotDirectory)
				await page.screenshot({
					path: `${screenshotDirectory}/deck-feedback-${width}-${theme}-selection.png`,
					fullPage: true,
					animations: "disabled",
				});
			await pill.getByRole("button", { name: "Shorter", exact: true }).click();
			await page
				.getByRole("button", { name: "Close decision context", exact: true })
				.click();
			if (width === 390)
				await page
					.getByRole("dialog", { name: "Decision context", exact: true })
					.waitFor({ state: "hidden" });
			await selectGreeting();
			await pill
				.getByRole("textbox", { name: "Comment on selection" })
				.fill("Keep the greeting");
			await pill
				.getByRole("button", { name: "Add comment", exact: true })
				.click();
			assert.equal(
				await page.getByLabel("Comments to send").locator("li").count(),
				2,
			);
			await page
				.getByLabel("Suggested changes")
				.getByRole("button", { name: "Warmer", exact: true })
				.click();
			if (screenshotDirectory)
				await page.screenshot({
					path: `${screenshotDirectory}/deck-feedback-${width}-${theme}-batch.png`,
					fullPage: true,
					animations: "disabled",
				});
			await page
				.getByRole("textbox", { name: "What should change?" })
				.fill("Use a friendlier closing.");
			await page
				.getByRole("button", { name: "Send to Draft author", exact: true })
				.click();
			await page.getByRole("status").filter({ hasText: "Revising…" }).waitFor();
			await page.waitForFunction(() =>
				[...document.querySelectorAll("button")].some(
					(button) => button.textContent?.trim() === "Send" && button.disabled,
				),
			);
			assert(
				await page
					.getByRole("button", {
						name: "Send",
						exact: true,
						includeHidden: true,
					})
					.isDisabled(),
			);
			if (screenshotDirectory)
				await page.screenshot({
					path: `${screenshotDirectory}/card-revisions-${width}-${theme}-revising.png`,
					fullPage: true,
					animations: "disabled",
				});
			pending = null;
			const plan = {
				key: "fictional-plan",
				item: { title: "Prepare the report", sourceIntentId: "report" },
				children: [{ title: "Check the sources", sourceIntentId: "review" }],
				start: {
					kind: "delegate" as const,
					brief: "Prepare a report for human review.",
				},
			};
			revisions.splice(2);
			revisions[0] = {
				...revisions[0]!,
				body: "Prepare the report",
				proposal: plan,
			};
			revisions[1] = {
				...revisions[1]!,
				summary: "Shortened the report and review titles.",
				body: "Draft a report",
				proposal: {
					...plan,
					item: { ...plan.item, title: "Draft a report" },
					children: [{ ...plan.children[0]!, title: "Verify every source" }],
				},
			};
			await page
				.getByRole("button", { name: "Close decision context", exact: true })
				.click();
			await page.goto(`${origin}/browser-tests/card-revisions.html?plan=1`);
			await page
				.getByRole("button", { name: "Details", exact: true })
				.first()
				.click();
			await page.getByText("What changed", { exact: true }).click();
			await page
				.getByRole("button", { name: "Keep original change 1", exact: true })
				.click();
			await page
				.getByText("Version 3", { exact: true })
				.filter({ visible: true })
				.first()
				.waitFor();
			assert.equal(
				revisions.at(-1)!.proposal?.item.title,
				"Prepare the report",
			);
			assert.equal(
				revisions.at(-1)!.proposal?.children[0]?.title,
				"Verify every source",
			);
			assert.deepEqual(revisions.at(-1)!.proposal?.start, plan.start);
			assert.equal(revisions.at(-1)!.cause, "human_edit");
			if (screenshotDirectory) {
				await page.evaluate((mode) => {
					document.documentElement.classList.toggle("dark", mode === "dark");
					document.documentElement.dataset.theme = mode;
				}, theme);
				await page.screenshot({
					path: `${screenshotDirectory}/deck-feedback-${width}-${theme}-plan-keep.png`,
					fullPage: true,
					animations: "disabled",
				});
			}
			await page.close();
		}
	console.log(
		"Card revisions: history, diff, restore, pending state, credential action and 1280/390 light/dark passed.",
	);
} finally {
	await browser.close();
	await server.stop();
}
