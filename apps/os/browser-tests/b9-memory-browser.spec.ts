import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { webkit, type Browser, type Locator, type Page } from "playwright";
import {
	MemoryBrowseInputSchema,
	MemoryBrowseOutputSchema,
} from "@tedix/api-contract/schemas/memory-browser";
import { ListAgentLessonsResultSchema } from "@tedix/api-contract/schemas/agent-session-lessons";
import { RationaleRecordSchema } from "@tedix/api-contract/schemas/rationale-records";

const cwd = new URL("../", import.meta.url).pathname;
const output =
	process.env.B9_MEMORY_EVIDENCE_DIR ?? "/tmp/b9-memory-browser-webkit";
await mkdir(output, { recursive: true });
const probe = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
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
	{
		cwd,
		stdout: "inherit",
		stderr: "inherit",
		detached: true,
		env: { ...process.env, VITE_LIVE_API: "0" },
	},
);
const longText = `Fictional orchard evidence. ${"The sample team checks its harvest records before planning the next delivery. ".repeat(12)}reference-${"orchard".repeat(50)}`;
const facts = MemoryBrowseOutputSchema.parse({
	facts: Array.from({ length: 43 }, (_, i) => ({
		id: `b9-fact-${i + 1}`,
		organizationId: "fictional-orchard",
		summary: `Orchard observation ${String(i + 1).padStart(2, "0")}`,
		content: longText,
		factType: "technical",
		confidence: i % 2 ? 0.6 : 0.9,
		source: "conversation://fictional-harvest",
		domainId: i % 2 ? "packing" : "growing",
		visibility: "org",
		accessCount: 2,
		usageCount: 1,
		createdAt: "2026-01-01T10:00:00.000Z",
		updatedAt: new Date(Date.UTC(2026, 0, 2, 10, 0, -i)).toISOString(),
	})),
	nextOffset: null,
}).facts;
const lessons = ListAgentLessonsResultSchema.parse({
	lessons: Array.from({ length: 23 }, (_, i) => ({
		id: `b9-rule-${i}`,
		fromCallerFeedback: true,
		text: `Orchard rule ${String(i + 1).padStart(2, "0")}: ${i === 0 ? longText : "Keep the sample harvest notes concise."}`,
		addedAt: new Date(Date.UTC(2026, 0, 2, 10, 0, -i)).toISOString(),
		learnedFrom: null,
	})),
});
const decisions = Array.from({ length: 22 }, (_, i) =>
	RationaleRecordSchema.parse({
		id: `b9-decision-${i}`,
		tediId: "fictional-grower",
		orgId: "fictional-orchard",
		action: `Orchard decision ${String(i + 1).padStart(2, "0")}`,
		rationale: longText,
		category: "harvest",
		confidence: i % 2 ? 0.6 : 0.9,
		evidence: { sample: "fictional harvest ledger" },
		outcome: null,
		outcomeStatus: i % 2 ? "pending" : "success",
		approvalRequestId: null,
		objectiveId: null,
		runId: null,
		workItemId: null,
		toolCallRefs: null,
		proofRef: null,
		createdAt: new Date(Date.UTC(2026, 0, 2, 10, 0, -i)).toISOString(),
		completedAt: null,
	}),
);
type Mode = "ready" | "pending" | "error";
type Receipt = {
	name: string;
	passed: boolean;
	error?: string;
	console: string[];
	measurements: unknown[];
};
const receipts: Receipt[] = [];
let browser: Browser | undefined;
const memory = (page: Page) =>
	page.getByRole("region", { name: "Memory browser", exact: true });
const recordAction = (page: Page, title: string) =>
	memory(page).getByRole("button", {
		name: `Open details: ${title}`,
		exact: true,
	});
async function shown(locator: Locator) {
	await locator.waitFor({ state: "visible" });
}
async function pageCount(page: Page, number: number, count: number) {
	await shown(
		memory(page).getByText(new RegExp(`^Page ${number} · ${count} memories`)),
	);
	assert.equal(await memory(page).locator("tbody tr").count(), count);
}
async function choose(page: Page, label: string, choice: string) {
	await memory(page)
		.getByRole("combobox", { name: label, exact: true })
		.click();
	await page.getByRole("option", { name: choice, exact: true }).click();
}
async function capture(page: Page, receipt: Receipt, state: string) {
	const path = `${output}/${receipt.name}-${state}.png`;
	const bytes = await page.screenshot({ path, fullPage: true });
	// PNG IHDR dimensions verify the actual artifact, independent of requested viewport.
	const width = bytes.readUInt32BE(16),
		height = bytes.readUInt32BE(20);
	assert.equal(width, page.viewportSize()!.width);
	assert(height >= page.viewportSize()!.height);
	receipt.measurements.push({ state, screenshot: path, width, height });
}
async function geometry(page: Page, receipt: Receipt, phone: boolean) {
	const dimensions = await page.evaluate(() => ({
		width: innerWidth,
		height: innerHeight,
		scroll: document.documentElement.scrollWidth,
		body: document.body.scrollWidth,
		mode: document.documentElement.dataset.mode,
		dark: document.documentElement.classList.contains("dark"),
	}));
	receipt.measurements.push(dimensions);
	assert.equal(dimensions.width, page.viewportSize()!.width);
	assert.equal(dimensions.height, page.viewportSize()!.height);
	assert(
		dimensions.scroll <= dimensions.width + 1 &&
			dimensions.body <= dimensions.width + 1,
		"Page overflows horizontally",
	);
	if (phone) {
		const targets = await memory(page)
			.locator(
				'button:visible, input[data-slot="input"]:visible, [role="combobox"]:visible, tbody tr',
			)
			.evaluateAll((nodes) =>
				nodes.map((node) => {
					const bounds = node.getBoundingClientRect();
					return {
						label: node.getAttribute("aria-label") ?? node.textContent,
						width: bounds.width,
						height: bounds.height,
					};
				}),
			);
		receipt.measurements.push({ targets });
		assert(targets.length > 10);
		assert.deepEqual(
			targets.filter((target) => target.width < 44 || target.height < 44),
			[],
			"Phone browsing targets must be at least 44px",
		);
	}
}
async function fixture(page: Page, receipt: Receipt) {
	let mode: Mode = "ready";
	let release: (() => void) | undefined;
	let requests = 0;
	const inputs: ReturnType<typeof MemoryBrowseInputSchema.parse>[] = [];
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== origin) {
			receipt.console.push(
				`blocked external request: ${url.origin}${url.pathname}`,
			);
			return route.abort();
		}
		const endpoint = url.pathname.replace("/api/rpc/", "");
		const json = (value: unknown) => route.fulfill({ json: { json: value } });
		if (endpoint === "memoryGraph/browse") {
			const input = MemoryBrowseInputSchema.parse(
				route.request().method() === "GET"
					? JSON.parse(url.searchParams.get("data") ?? "{}").json
					: route.request().postDataJSON()?.json,
			);
			inputs.push(input);
			requests++;
			if (mode === "pending")
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			if (mode === "error")
				return route.fulfill({
					status: 503,
					body: "Fictional memory read unavailable",
				});
			let rows = facts.filter(
				(fact) =>
					(!input.search ||
						`${fact.summary} ${fact.content}`
							.toLowerCase()
							.includes(input.search.toLowerCase())) &&
					(!input.domainId || fact.domainId === input.domainId) &&
					(input.minConfidence === undefined ||
						fact.confidence >= input.minConfidence),
			);
			if (input.orderBy === "confidence")
				rows = rows.toSorted(
					(a, b) =>
						b.confidence - a.confidence ||
						b.updatedAt!.localeCompare(a.updatedAt!),
				);
			return json(
				MemoryBrowseOutputSchema.parse({
					facts: rows.slice(input.offset, input.offset + input.limit),
					nextOffset:
						input.offset + input.limit < rows.length
							? input.offset + input.limit
							: null,
				}),
			);
		}
		if (endpoint === "memoryGraph/listDomains")
			return json({
				domains: ["growing", "packing"].map((id) => ({
					id,
					name: id === "growing" ? "Growing" : "Packing",
					organizationId: "fictional-orchard",
					description: null,
					parentDomainId: null,
					factCount: 22,
					createdAt: null,
				})),
			});
		if (
			endpoint === "agentTurnTriage/listLessons" ||
			endpoint === "rationaleRecords/list"
		) {
			const input =
				route.request().method() === "GET"
					? JSON.parse(url.searchParams.get("data") ?? "{}").json
					: route.request().postDataJSON()?.json;
			assert.equal(input.limit, 100, "Recent inventory must stay bounded");
			return json(
				endpoint === "agentTurnTriage/listLessons"
					? lessons
					: {
							data: decisions,
							pagination: { limit: 100, offset: 0, total: 22, hasMore: false },
						},
			);
		}
		if (
			/^memoryGraph\//.test(endpoint) &&
			!["memoryGraph/health", "memoryGraph/healthFindings"].includes(endpoint)
		) {
			throw new Error(`Unexpected Memory operation: ${endpoint}`);
		}
		return route.continue();
	});
	return {
		setMode(next: Mode) {
			mode = next;
			release?.();
			release = undefined;
		},
		get requests() {
			return requests;
		},
		inputs,
	};
}

try {
	await waitForFixtureServer(origin, { server });
	browser = await webkit.launch({ headless: true });
	for (const viewport of [
		{ width: 375, height: 667 },
		{ width: 390, height: 844 },
		{ width: 1280, height: 900 },
	]) {
		for (const theme of ["light", "dark"] as const) {
			for (const scenario of [
				"browse",
				"detail",
				"recovery",
				"stale",
			] as const) {
				const receipt: Receipt = {
					name: `${viewport.width}x${viewport.height}-${theme}-${scenario}`,
					passed: false,
					console: [],
					measurements: [],
				};
				receipts.push(receipt);
				const context = await browser.newContext({
					viewport,
					colorScheme: theme,
					reducedMotion: "reduce",
					isMobile: viewport.width < 600,
					hasTouch: viewport.width < 600,
					serviceWorkers: "block",
				});
				const page = await context.newPage();
				page.setDefaultTimeout(10_000);
				page.on("console", (entry) =>
					receipt.console.push(`${entry.type()}: ${entry.text()}`),
				);
				page.on("pageerror", (error) =>
					receipt.console.push(`pageerror: ${error.message}`),
				);
				const control = await fixture(page, receipt);
				try {
					if (scenario === "recovery") control.setMode("pending");
					await page.goto(`${origin}/brain`);
					await shown(memory(page));
					assert.equal(
						await page.locator("html").getAttribute("data-mode"),
						theme,
					);
					assert.equal(
						await page
							.locator("html")
							.evaluate((node) => node.classList.contains("dark")),
						theme === "dark",
					);
					if (scenario === "recovery") {
						await shown(memory(page).locator('[data-slot="skeleton"]').first());
						assert.equal(
							await memory(page)
								.getByText("No memories to show", { exact: true })
								.count(),
							0,
						);
						await capture(page, receipt, "cold-pending");
						control.setMode("error");
						await shown(
							memory(page).getByText("What we know is unavailable", {
								exact: true,
							}),
						);
						assert.equal(
							await memory(page)
								.getByText("No memories to show", { exact: true })
								.count(),
							0,
						);
						await capture(page, receipt, "cold-error");
						control.setMode("ready");
						await memory(page)
							.getByRole("button", { name: "Retry", exact: true })
							.click();
						await pageCount(page, 1, 20);
						assert(
							control.requests >= 4,
							"Cold retries and explicit Retry must reach the intercepted read",
						);
					} else {
						await pageCount(page, 1, 20);
						if (scenario === "browse") {
							await geometry(page, receipt, viewport.width < 600);
							assert(
								await memory(page)
									.getByRole("button", { name: "Previous page", exact: true })
									.isDisabled(),
							);
							await memory(page)
								.getByRole("button", { name: "Next page", exact: true })
								.click();
							await pageCount(page, 2, 20);
							await memory(page)
								.getByRole("button", { name: "Next page", exact: true })
								.click();
							await pageCount(page, 3, 3);
							assert(
								await memory(page)
									.getByRole("button", { name: "Next page", exact: true })
									.isDisabled(),
							);
							await memory(page)
								.getByRole("button", { name: "Previous page", exact: true })
								.click();
							await pageCount(page, 2, 20);
							await memory(page)
								.getByRole("textbox", {
									name: "Search what we know",
									exact: true,
								})
								.fill("Orchard observation 43");
							await pageCount(page, 1, 1);
							await shown(recordAction(page, "Orchard observation 43"));
							await memory(page)
								.getByRole("textbox", {
									name: "Search what we know",
									exact: true,
								})
								.fill("no-match-fictional");
							await shown(
								memory(page).getByText(
									"Try another search or clear the filters.",
									{ exact: true },
								),
							);
							await pageCount(page, 1, 0);
							await memory(page)
								.getByRole("button", { name: "Clear filters", exact: true })
								.click();
							await pageCount(page, 1, 20);
							await choose(page, "Domain", "Growing");
							await choose(page, "Confidence", "80% or higher");
							await choose(page, "Sort memories", "Confidence: highest");
							await memory(page)
								.getByRole("textbox", {
									name: "Search what we know",
									exact: true,
								})
								.fill("Orchard observation");
							await pageCount(page, 1, 20);
							await memory(page)
								.getByRole("tab", { name: "Rules", exact: true })
								.click();
							await pageCount(page, 1, 20);
							await shown(
								memory(page).getByText(
									"Search and sort the latest 100 records. Open a memory for full text and evidence.",
									{ exact: true },
								),
							);
							assert(
								await memory(page)
									.getByRole("combobox", { name: "Confidence", exact: true })
									.isDisabled(),
							);
							assert.equal(
								await memory(page)
									.getByRole("textbox", { name: "Search rules", exact: true })
									.inputValue(),
								"",
							);
							assert.match(
								await memory(page).innerText(),
								/of 23 in this recent window/,
							);
							const params = new URL(page.url()).searchParams;
							for (const key of ["q", "domain", "source", "detail"])
								assert.equal(params.get(key) ?? "", "");
							assert.equal(params.get("confidence") ?? "all", "all");
							assert.equal(params.get("sort") ?? "updated", "updated");
							await memory(page)
								.getByRole("button", { name: "Next page", exact: true })
								.click();
							await pageCount(page, 2, 3);
							assert(
								await memory(page)
									.getByRole("button", { name: "Next page", exact: true })
									.isDisabled(),
							);
							await memory(page)
								.getByRole("tab", { name: "Decisions", exact: true })
								.click();
							await pageCount(page, 1, 20);
							await choose(page, "Outcome", "pending");
							await pageCount(page, 1, 11);
							await memory(page)
								.getByRole("tab", { name: "What we know", exact: true })
								.click();
							await pageCount(page, 1, 20);
							assert(
								control.inputs.some(
									(input) => input.offset === 40 && input.limit === 20,
								),
							);
							assert(
								control.inputs.some(
									(input) =>
										input.domainId === "growing" && input.minConfidence === 0.8,
								),
							);
						} else if (scenario === "detail") {
							const trigger = recordAction(page, "Orchard observation 01");
							const recordRow = trigger.locator("xpath=ancestor::tr");
							assert.equal(await recordRow.getAttribute("tabindex"), null);
							assert.equal(await recordRow.getAttribute("role"), "row");
							await trigger.focus();
							await page.keyboard.press("Enter");
							const dialog = page.getByRole("dialog", {
								name: "Memory details",
								exact: true,
							});
							await shown(dialog);
							const body = dialog.getByText(longText, { exact: true });
							await shown(body);
							const text = await body.evaluate((node) => {
								const r = node.getBoundingClientRect();
								const s = getComputedStyle(node);
								return {
									width: r.width,
									height: r.height,
									scroll: node.scrollWidth,
									font: parseFloat(s.fontSize),
									overflow: s.textOverflow,
								};
							});
							receipt.measurements.push({ longText: text });
							assert(
								text.font >= 14 &&
									text.height > 100 &&
									text.scroll <= text.width + 1 &&
									text.overflow !== "ellipsis",
								"Full long text must wrap readably",
							);
							await capture(page, receipt, "detail");
							const close = dialog.getByRole("button", {
								name: "Close",
								exact: true,
							});
							const bounds = await close.boundingBox();
							receipt.measurements.push({ close: bounds });
							if (viewport.width < 600)
								assert(
									bounds && bounds.width >= 44 && bounds.height >= 44,
									"Phone detail close target must be 44px",
								);
							await close.click();
							receipt.measurements.push({
								step: "close clicked",
								url: page.url(),
							});
							await dialog.waitFor({ state: "hidden" });
							assert(
								await trigger.evaluate(
									(node) => node === document.activeElement,
								),
								"Closing details must return focus to the opening action",
							);
							await page.keyboard.press("Space");
							await shown(dialog);
							await page.waitForFunction(() =>
								document
									.querySelector('[role="dialog"]')
									?.contains(document.activeElement),
							);
							receipt.measurements.push({
								step: "reopened with Space",
								url: page.url(),
							});
							await page.keyboard.press("Escape");
							await dialog.waitFor({ state: "hidden" });
							assert(
								await trigger.evaluate(
									(node) => node === document.activeElement,
								),
								"Escape must return focus to the opening action",
							);
						} else {
							const previous = control.requests;
							await page.clock.install();
							await page.clock.fastForward(31_000);
							control.setMode("pending");
							const refreshing = page.waitForRequest((request) =>
								request.url().includes("memoryGraph/browse"),
							);
							await page.evaluate(() =>
								window.dispatchEvent(new Event("focus")),
							);
							await refreshing;
							for (let i = 0; i < 100 && control.requests <= previous; i++)
								await Bun.sleep(10);
							assert(
								control.requests > previous,
								"Focus must start a stale Memory read",
							);
							await shown(recordAction(page, "Orchard observation 01"));
							await capture(page, receipt, "stale-pending");
							control.setMode("error");
							await page.clock.resume();
							await shown(
								memory(page).getByRole("button", {
									name: "Retry",
									exact: true,
								}),
							);
							await capture(page, receipt, "stale-error");
							assert(
								await recordAction(page, "Orchard observation 01").isVisible(),
								"Stale refresh failure must preserve previously loaded content",
							);
							control.setMode("ready");
							await memory(page)
								.getByRole("button", { name: "Retry", exact: true })
								.click();
							await pageCount(page, 1, 20);
						}
					}
					await capture(page, receipt, "final");
					receipt.passed = true;
				} catch (error) {
					receipt.error = String(error);
					await capture(page, receipt, "failure").catch(() => {});
				} finally {
					control.setMode("ready");
					await context.close();
				}
				console.log(
					`${receipt.passed ? "PASS" : "FAIL"} ${receipt.name}${receipt.error ? `: ${receipt.error}` : ""}`,
				);
				await writeFile(
					`${output}/receipts.json`,
					JSON.stringify(
						{ engine: "webkit", version: browser.version(), origin, receipts },
						null,
						2,
					),
				);
			}
		}
	}
	assert.equal(
		receipts.filter((receipt) => !receipt.passed).length,
		0,
		`Memory browser regressions failed; see ${output}/receipts.json`,
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
