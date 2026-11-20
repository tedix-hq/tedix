import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

const approvalChat = "/chat?conversation=00000060-0000-4000-8000-000000000005";
const failureChat = "/chat?conversation=00000060-0000-4000-8000-000000000006";
const screenshots = process.env.CHAT_STRUCTURED_SCREENSHOTS;
const server = await startFixtureServer();
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	if (screenshots) await mkdir(screenshots, { recursive: true });
	const context = await browser.newContext({
		viewport: { width: 375, height: 900 },
		hasTouch: true,
		permissions: ["clipboard-read", "clipboard-write"],
		colorScheme: "dark",
	});
	const page = await context.newPage();
	await page.goto(`${server.origin}${approvalChat}`);
	const approval = page.locator('[data-slot="chat-write-approval"]');
	await approval.waitFor();
	await page.evaluate(() => document.documentElement.classList.add("dark"));
	assert.match(
		await approval.innerText(),
		/^Create sheet “Opportunities - final format”/,
	);
	assert.doesNotMatch(await approval.innerText(), /\{"kind"/);
	const trigger = approval.getByRole("button", { name: /Arguments/ });
	assert.equal(await trigger.getAttribute("aria-expanded"), "false");
	assert.equal(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
		true,
		`chat stays within the 375px viewport`,
	);
	if (screenshots)
		await page.screenshot({
			path: `${screenshots}/approval-collapsed-375-dark.png`,
		});
	await trigger.click();
	const code = approval.locator('[data-slot="chat-json-code"]');
	await code.waitFor();
	assert.match(await code.innerText(), /"kind": "sheet"/);
	await approval.getByText("Shortened by the server").waitFor();
	await approval.getByRole("button", { name: "Copy JSON" }).click();
	assert.match(
		await page.evaluate(() => navigator.clipboard.readText()),
		/"title": "Opportunities - final format"/,
	);
	assert.equal(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
		true,
		`open arguments stay within the 375px viewport`,
	);
	if (screenshots)
		await page.screenshot({
			path: `${screenshots}/approval-open-375-dark.png`,
		});

	await page.goto(`${server.origin}${failureChat}`);
	const failure = page.locator('[data-slot="chat-write-failure"]');
	await failure.waitFor();
	await page.evaluate(() => document.documentElement.classList.add("dark"));
	const text = await failure.innerText();
	assert.match(
		text,
		/^Couldn't create the output: Action "tedix__create_os_output" requires approval\./,
	);
	assert.doesNotMatch(text, /"type"/);
	if (screenshots)
		await page.screenshot({
			path: `${screenshots}/failure-375-dark.png`,
		});
	console.log("Structured chat approvals and failures fit on a phone");
} finally {
	await browser?.close();
	await server.stop();
}
