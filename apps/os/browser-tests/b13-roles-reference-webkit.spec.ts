import {
	ASSIGNABLE_ROLES,
	describeRolePermissions,
	PERMISSION_GROUPS,
	ROLE_METADATA,
} from "@tedix/auth/rbac";
import {
	CAPABILITY_SCOPE_METADATA,
	CAPABILITY_SCOPES,
} from "@tedix/mcp-shared/auth/scopes";
import assert from "node:assert/strict";
import { devices, webkit, type Locator, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

/*
 * The Roles reference on iPhone Safari (WebKit) and desktop: phones get one
 * summary per role whose permission groups are disclosures, desktop gets the
 * tables. Every role, permission and scope in the canonical metadata must be
 * reachable, people-only scopes must say so, and nothing may overflow.
 */
const fixturePath = "/browser-tests/b13-roles-reference-webkit.html";
const server = await startFixtureServer(fixturePath);

const groupsFor = (role: (typeof ASSIGNABLE_ROLES)[number]) =>
	PERMISSION_GROUPS.filter((group) =>
		describeRolePermissions(role).some((entry) => entry.group === group),
	);

async function assertNoOverflow(page: Page, label: string) {
	const overflow = await page.evaluate(() => ({
		page: document.documentElement.scrollWidth - innerWidth,
		clipped: [...document.querySelectorAll<HTMLElement>("section *")]
			.filter((node) => {
				const box = node.getBoundingClientRect();
				return box.width > 0 && box.right > innerWidth + 0.5;
			})
			.map((node) => node.textContent?.slice(0, 40)),
	}));
	assert.equal(overflow.page, 0, `${label}: page scrolls horizontally`);
	assert.deepEqual(overflow.clipped, [], `${label}: content past the viewport`);
}

/** Moves focus with Tab alone until it lands on `target`. */
async function tabTo(page: Page, target: Locator, label: string) {
	for (let step = 0; step < 200; step++) {
		if (await target.evaluate((node) => node === document.activeElement))
			return;
		await page.keyboard.press("Tab");
	}
	assert.fail(`${label}: not reachable with Tab`);
}

async function checkPhone(page: Page, label: string) {
	assert(
		await page
			.getByRole("region", { name: "Organization role permissions" })
			.isHidden(),
		`${label}: the role table is hidden on phones`,
	);
	const roles = page.locator(
		'[aria-label="Organization role summaries"] > section',
	);
	assert.equal(await roles.count(), ASSIGNABLE_ROLES.length, `${label}: roles`);

	for (const [index, role] of ASSIGNABLE_ROLES.entries()) {
		const section = roles.nth(index);
		assert.equal(
			await section.getAttribute("aria-label"),
			`${ROLE_METADATA[role].label} role`,
		);
		const triggers = section.locator("button[aria-expanded]");
		const groups = groupsFor(role);
		assert.equal(
			await triggers.count(),
			groups.length,
			`${label}: ${role} groups`,
		);
		for (const [groupIndex] of groups.entries()) {
			const trigger = triggers.nth(groupIndex);
			const box = (await trigger.boundingBox())!;
			assert(
				box.height >= 44,
				`${label}: ${role} trigger ${box.height}px tall`,
			);
			assert.equal(await trigger.getAttribute("aria-expanded"), "false");
			// Alternate keyboard and touch so both operate every role.
			if (groupIndex % 2 === 0) {
				await tabTo(page, trigger, `${label}: ${role} trigger`);
				assert(
					await trigger.evaluate((node) => node.matches(":focus-visible")),
					`${label}: ${role} trigger shows keyboard focus`,
				);
				await page.keyboard.press("Enter");
			} else {
				await trigger.tap();
			}
			assert.equal(
				await trigger.getAttribute("aria-expanded"),
				"true",
				`${label}: ${role} disclosure ${groupIndex} opens`,
			);
		}
		// Completeness: with every group open the role shows each permission once.
		const badges = await section
			.locator('[title*=" — "]')
			.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));
		assert.deepEqual(
			badges.sort(),
			describeRolePermissions(role)
				.map((entry) => `${entry.permission} — ${entry.description}`)
				.sort(),
			`${label}: ${role} permissions`,
		);
		await tabTo(page, triggers.first(), `${label}: ${role} first trigger`);
		await page.keyboard.press("Space");
		assert.equal(await triggers.first().getAttribute("aria-expanded"), "false");
	}

	const scopes = page.locator(
		'[aria-label="MCP capability scope summaries"] > section',
	);
	assert.equal(
		await scopes.count(),
		CAPABILITY_SCOPES.length,
		`${label}: scopes`,
	);
	for (const [index, scope] of CAPABILITY_SCOPES.entries()) {
		const text = await scopes.nth(index).innerText();
		const meta = CAPABILITY_SCOPE_METADATA[scope];
		assert(text.includes(scope), `${label}: ${scope} named`);
		assert(
			text.includes(meta.humanOnly ? "People only" : "People and tedis"),
			`${label}: ${scope} boundary`,
		);
	}
}

async function checkDesktop(page: Page, label: string) {
	assert(
		await page.locator('[aria-label="Organization role summaries"]').isHidden(),
		`${label}: phone summaries are hidden on desktop`,
	);
	const roleRows = page.locator(
		'table[aria-label="Organization role permissions"] tbody tr',
	);
	assert.equal(await roleRows.count(), ASSIGNABLE_ROLES.length);
	for (const [index, role] of ASSIGNABLE_ROLES.entries()) {
		const badges = await roleRows.nth(index).locator('[title*=" — "]').count();
		assert.equal(
			badges,
			describeRolePermissions(role).length,
			`${label}: ${role} permissions`,
		);
	}
	const scopeRows = page.locator(
		'table[aria-label="MCP capability scopes"] tbody tr',
	);
	assert.equal(await scopeRows.count(), CAPABILITY_SCOPES.length);
	const peopleOnly = CAPABILITY_SCOPES.filter(
		(scope) => CAPABILITY_SCOPE_METADATA[scope].humanOnly,
	).length;
	assert.equal(
		await scopeRows.getByText("People only", { exact: true }).count(),
		peopleOnly,
		`${label}: people-only scopes`,
	);
}

const browser = await webkit.launch({ headless: true });
try {
	for (const [size, options] of [
		["375x667", devices["iPhone 8"]],
		["390x844", devices["iPhone 13"]],
		["1280x900", { viewport: { width: 1280, height: 900 } }],
	] as const) {
		for (const theme of ["light", "dark"] as const) {
			const label = `${size} ${theme}`;
			const context = await browser.newContext({
				...options,
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("console", (message) => {
				if (message.type() === "error") errors.push(message.text());
			});
			await page.goto(`${server.origin}${fixturePath}?theme=${theme}`);
			await page
				.getByText(ROLE_METADATA.owner.label, { exact: true })
				.locator("visible=true")
				.first()
				.waitFor();
			if (size === "1280x900") await checkDesktop(page, label);
			else await checkPhone(page, label);
			await assertNoOverflow(page, label);
			assert.deepEqual(errors, [], `${label}: page errors`);
			console.log(`PASS roles reference ${label}`);
			await context.close();
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
