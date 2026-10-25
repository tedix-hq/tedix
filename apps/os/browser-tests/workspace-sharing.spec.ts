import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * Workspace sharing at phone and desktop widths: the Share dialog (invite,
 * removal impact with keep-user re-rooting, one-time link), the page a
 * collaborator opens, and the access-denied page that reveals nothing.
 */
const path = "/browser-tests/workspace-sharing.html";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = "AbCdEfGhIjKlMnOpQrStUv";
const server = await startFixtureServer(path);
const browser = await chromium.launch({ headless: true });
const directory =
	process.env.TEDIX_BROWSER_ARTIFACTS_DIR ?? "/tmp/tedix-workspace-sharing";
await mkdir(directory, { recursive: true });

const kai = {
	userId: "member-kai",
	email: "kai@example.test",
	name: "Kai Fictional",
	role: "build",
	addedBy: ["Robin"],
	canRemove: true,
	lastOpenedAt: null,
};
const zoe = {
	userId: "member-zoe",
	email: "zoe@example.test",
	name: "Zoe Fictional",
	role: "use",
	addedBy: ["Kai Fictional"],
	canRemove: true,
	lastOpenedAt: null,
};

type Calls = Record<string, unknown[]>;

async function mockApi(page: Page, options: { denied?: boolean } = {}) {
	const calls: Calls = {};
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const endpoint = new URL(request.url()).pathname.split("/").pop() ?? "";
		const raw =
			request.method() === "GET"
				? JSON.parse(new URL(request.url()).searchParams.get("data") ?? "{}")
				: request.postDataJSON();
		const input = raw?.json ?? raw;
		(calls[endpoint] ??= []).push(input);
		let json: unknown;
		if (endpoint === "list")
			json = {
				role: "build",
				isOwner: true,
				ownerName: "Robin Fictional",
				collaborators: [kai, zoe],
				links: [
					{
						id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
						role: "use",
						label: "Reviewers with a rather long link name",
						createdBy: { userId: "member-robin", email: null, name: "Robin" },
						createdAt: "2026-10-25T10:00:00.000Z",
						canRevoke: true,
					},
				],
			};
		else if (endpoint === "add")
			json = {
				collaborator: { ...zoe, userId: "member-lee", email: input.email },
			};
		else if (endpoint === "previewRemove" || endpoint === "remove")
			json = {
				affected: [
					{ ...kai, oldRole: "build", newRole: null },
					{ ...zoe, oldRole: "use", newRole: null },
				].map(({ userId, email, name, oldRole, newRole }) => ({
					userId,
					email,
					name,
					oldRole,
					newRole,
				})),
			};
		else if (endpoint === "createLink")
			json = {
				key: KEY,
				link: {
					id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
					role: input.role,
					label: null,
					createdBy: { userId: "member-robin", email: null, name: "Robin" },
					createdAt: "2026-10-25T11:00:00.000Z",
					canRevoke: true,
				},
			};
		else if (endpoint === "open") {
			if (options.denied) {
				await route.fulfill({
					status: 403,
					contentType: "application/json",
					body: JSON.stringify({
						json: {
							defined: false,
							code: "FORBIDDEN",
							status: 403,
							message: "You don't have access to this workspace",
						},
					}),
				});
				return;
			}
			json = {
				workspace: {
					id: WORKSPACE_ID,
					title: "Reddit research",
					ownerName: "Robin Fictional",
				},
				role: "use",
				isOwner: false,
				capability: {
					workspaceId: WORKSPACE_ID,
					appId: null,
					role: "use",
					operations: [
						"app.connect",
						"app.render",
						"metadata.read",
						"presence.read",
					],
					actingUserId: "member-zoe",
					openedAt: "2026-10-25T11:00:00.000Z",
				},
				apps: [
					{
						id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
						name: "Thread finder",
						description: "Finds threads worth answering",
						entry: null,
					},
				],
			};
		} else if (endpoint === "listShared") json = { items: [] };
		else throw new Error(`Unexpected request ${endpoint}`);
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ json }),
		});
	});
	return calls;
}

async function assertFits(page: Page, width: number, label: string) {
	const metrics = await page.evaluate(() => ({
		overflow: document.documentElement.scrollWidth - innerWidth,
		dialog: (() => {
			const dialog = document.querySelector('[role="dialog"]');
			if (!dialog) return null;
			const { x, width } = dialog.getBoundingClientRect();
			return { x, right: x + width };
		})(),
	}));
	assert(metrics.overflow <= 1, `${label}: ${JSON.stringify(metrics)}`);
	if (metrics.dialog)
		assert(
			metrics.dialog.x >= 0 && metrics.dialog.right <= width + 1,
			`${label}: ${JSON.stringify(metrics)}`,
		);
}

const started = performance.now();
let cases = 0;
try {
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 1280]) {
			const viewport = { width, height: 900 };
			// The Share dialog.
			{
				const page = await browser.newPage({ viewport, colorScheme: theme });
				const calls = await mockApi(page);
				await page.goto(`${server.origin}${path}?theme=${theme}`);
				const dialog = page.getByRole("dialog");
				await dialog.getByText("Share Reddit research").waitFor();
				await dialog.getByText("Kai Fictional", { exact: true }).waitFor();
				await assertFits(page, width, `dialog ${width} ${theme}`);

				await dialog.getByLabel("Email address").fill("lee@example.test");
				await dialog.getByRole("button", { name: "Invite" }).click();
				await page.waitForFunction(() =>
					[...document.querySelectorAll("input")].every((i) => i.value === ""),
				);
				assert.deepEqual(calls.add?.[0], {
					workspaceId: WORKSPACE_ID,
					email: "lee@example.test",
					role: "use",
				});

				await dialog
					.getByRole("button", { name: "Remove Kai Fictional" })
					.click();
				const confirm = dialog.locator("[data-removal-confirm]");
				await confirm.getByText("This also removes Zoe Fictional.").waitFor();
				await confirm.getByText("Keep Zoe Fictional at can use").click();
				await assertFits(page, width, `confirm ${width} ${theme}`);
				await page.screenshot({
					path: `${directory}/dialog-confirm-${width}-${theme}.png`,
					fullPage: true,
				});
				await confirm
					.getByRole("button", { name: "Remove", exact: true })
					.click();
				await confirm.waitFor({ state: "detached" });
				assert.deepEqual(calls.remove?.[0], {
					workspaceId: WORKSPACE_ID,
					target: { kind: "user", userId: "member-kai" },
					keepUserIds: ["member-zoe"],
				});

				await dialog.getByRole("button", { name: "Create link" }).click();
				const fresh = dialog.locator("[data-fresh-link]");
				await fresh.waitFor();
				const text = await fresh.textContent();
				assert(
					text?.includes(`/shared/workspace/${WORKSPACE_ID}#share=${KEY}`),
					text ?? "",
				);
				await assertFits(page, width, `link ${width} ${theme}`);
				await page.screenshot({
					path: `${directory}/dialog-${width}-${theme}.png`,
					fullPage: true,
				});
				await page.close();
				cases++;
			}
			// The collaborator's page, with the key stripped from the address bar.
			{
				const page = await browser.newPage({ viewport, colorScheme: theme });
				const calls = await mockApi(page);
				await page.goto(
					`${server.origin}${path}?theme=${theme}&view=page#share=${KEY}`,
				);
				await page.getByRole("heading", { name: "Reddit research" }).waitFor();
				await page.getByText("Can use").waitFor();
				await page.getByText("Thread finder").waitFor();
				assert.equal(
					await page.getByRole("button", { name: "Open workspace" }).count(),
					0,
				);
				assert.deepEqual(calls.open?.[0], {
					workspaceId: WORKSPACE_ID,
					shareKey: KEY,
				});
				assert.equal(new URL(page.url()).hash, "");
				await assertFits(page, width, `page ${width} ${theme}`);
				await page.screenshot({
					path: `${directory}/page-${width}-${theme}.png`,
					fullPage: true,
				});
				await page.close();
				cases++;
			}
			// Access denied names nothing about the workspace.
			{
				const page = await browser.newPage({ viewport, colorScheme: theme });
				await mockApi(page, { denied: true });
				await page.goto(`${server.origin}${path}?theme=${theme}&view=page`);
				await page.getByText("You don't have access").waitFor();
				const body = (await page.textContent("body")) ?? "";
				assert(!body.includes("Reddit research"), body);
				assert(!body.includes("Robin"), body);
				await assertFits(page, width, `denied ${width} ${theme}`);
				await page.close();
				cases++;
			}
			console.log(`PASS workspace sharing ${width}px ${theme}`);
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
console.log(
	`${cases} sharing cases in ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
