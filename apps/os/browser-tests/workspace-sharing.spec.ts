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
const PUBLIC_TOKEN = "PublicTokenPublicTokenPublicToken12";
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
	canChangeRole: true,
	lastOpenedAt: null,
};
const zoe = {
	userId: "member-zoe",
	email: "zoe@example.test",
	name: "Zoe Fictional",
	role: "use",
	addedBy: ["Kai Fictional"],
	canRemove: true,
	canChangeRole: true,
	lastOpenedAt: null,
};

type Calls = Record<string, unknown[]>;

async function mockApi(
	page: Page,
	options: {
		denied?: boolean;
		runtime?: "use" | "build";
		clientDenied?: boolean;
	} = {},
) {
	const calls: Calls = {};
	const publicLinks: unknown[] = [];
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const pathname = new URL(request.url()).pathname;
		const publicShares = pathname.includes("/osShares/");
		const endpoint =
			(publicShares ? "public:" : "") + (pathname.split("/").pop() ?? "");
		const raw =
			request.method() === "GET"
				? JSON.parse(new URL(request.url()).searchParams.get("data") ?? "{}")
				: request.postDataJSON();
		const input = raw?.json ?? raw;
		(calls[endpoint] ??= []).push(input);
		let json: unknown;
		if (pathname.includes("/osAppRuntime/")) {
			assert(!JSON.stringify(input).includes("shareKey"));
			const session = {
				session: "host-only-capability",
				expiresAt: Math.floor(Date.now() / 1000) + 300,
				role: options.runtime,
				revisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			};
			if (endpoint === "client") {
				if (options.clientDenied)
					return route.fulfill({
						status: 403,
						json: { json: { code: "FORBIDDEN", message: "App unavailable" } },
					});
				json = {
					...session,
					revision: 1,
					settings: { label: "Shared content" },
					grants: [{ slot: "sheet", operations: ["outputs.read"] }],
					client: `
const context = await tedix.call('context');
const content = await tedix.call('outputs.read', {slot:'sheet'});
document.getElementById('app').innerHTML = '<p id="role"></p><p id="content"></p><button>Run app</button><p role="status"></p>';
document.getElementById('role').textContent = context.role;
document.getElementById('content').textContent = context.settings.label + ': ' + content.blocks[0].text;
document.querySelector('button').onclick = async () => { const result = await tedix.call('app.call', {method:'count',args:[]}); document.querySelector('[role=status]').textContent = 'Count: ' + result.count; };
`,
				};
			} else if (endpoint === "readOutput") {
				assert.equal(input.session, session.session);
				assert.equal(input.slot, "sheet");
				json = {
					kind: "document",
					blocks: [{ type: "paragraph", text: "Granted document" }],
				};
			} else if (endpoint === "open") json = session;
			else if (endpoint === "call") {
				assert.equal(input.session, session.session);
				assert.equal(input.method, "count");
				json = { result: { count: 1 } };
			} else throw new Error(`Unexpected runtime endpoint ${endpoint}`);
			return route.fulfill({ json: { json } });
		}
		assert(
			!pathname.includes("/osWorkspaces/"),
			`Org-scoped read: ${pathname}`,
		);
		if (endpoint === "public:list") json = { items: publicLinks };
		else if (endpoint === "public:create") {
			const share = {
				id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
				organizationId: "org-fictional",
				resourceType: "workspace",
				resourceId: WORKSPACE_ID,
				role: input.role,
				revisionMode: "living",
				pinnedRevisionId: null,
				note: null,
				policyMaxRole: null,
				policyReason: null,
				policyRestrictedAt: null,
				createdByKind: "user",
				createdById: "member-robin",
				createdAt: "2026-10-25T11:00:00.000Z",
				expiresAt: null,
				revokedAt: null,
			};
			publicLinks.push(share);
			json = { share, token: PUBLIC_TOKEN };
		} else if (endpoint === "list")
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
						canEdit: true,
					},
				],
			};
		else if (endpoint === "setRole") json = { affected: [] };
		else if (endpoint === "updateLink")
			json = {
				link: {
					id: input.linkId,
					role: input.role,
					label: input.label,
					createdBy: { userId: "member-robin", email: null, name: "Robin" },
					createdAt: "2026-10-25T10:00:00.000Z",
					canRevoke: true,
					canEdit: true,
				},
				affected: [],
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
					canEdit: true,
				},
			};
		else if (endpoint === "access") {
			if (options.denied)
				return route.fulfill({
					status: 403,
					json: { json: { code: "FORBIDDEN", message: "Access changed" } },
				});
			json = { role: options.runtime ?? "use" };
		} else if (endpoint === "open") {
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
				role: options.runtime ?? "use",
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
						entry: options.runtime ? "tedix:runtime/v1" : null,
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

async function expectCall(calls: Calls, endpoint: string, expected: unknown) {
	for (let attempt = 0; attempt < 50 && !calls[endpoint]; attempt++)
		await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(calls[endpoint]?.[0], expected);
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
	{
		const page = await browser.newPage({
			viewport: { width: 1280, height: 900 },
		});
		const permissions: { runtime: "build" | "use"; denied: boolean } = {
			runtime: "build",
			denied: false,
		};
		const calls = await mockApi(page, permissions);
		await page.goto(`${server.origin}${path}?view=workspace`);
		await page.locator("[data-live-workspace]").waitFor();
		permissions.runtime = "use";
		const downgradeAt = performance.now();
		await page
			.getByText("Can use", { exact: true })
			.waitFor({ timeout: 6_000 });
		assert.equal(await page.locator("[data-live-workspace]").count(), 0);
		await page.locator("[data-app-runtime-frame]").waitFor();
		const downgradeMs = Math.round(performance.now() - downgradeAt);
		permissions.denied = true;
		const removalAt = performance.now();
		await page.locator("[data-access-denied]").waitFor({ timeout: 6_000 });
		assert.equal(await page.locator("[data-app-runtime-frame]").count(), 0);
		assert(!(await page.textContent("body"))?.includes("Reddit research"));
		assert.equal(calls.open?.length, 1);
		const removalMs = Math.round(performance.now() - removalAt);
		await page.screenshot({
			path: `${directory}/live-access-revoked.png`,
			fullPage: true,
		});
		console.log(
			`PASS open workspace downgrade ${downgradeMs}ms, removal ${removalMs}ms; no reload`,
		);
		await page.close();
		cases++;
	}
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
				await dialog
					.getByRole("button", { name: "Invite", exact: true })
					.click();
				await page.waitForFunction(
					() =>
						(document.querySelector("input[type=email]") as HTMLInputElement)
							.value === "",
				);
				assert.deepEqual(calls.add?.[0], {
					workspaceId: WORKSPACE_ID,
					email: "lee@example.test",
					role: "use",
				});

				// Owners change a person's role in place from their row.
				await dialog
					.getByRole("combobox", { name: "Role for Zoe Fictional" })
					.click();
				await page.getByRole("option", { name: "Can build" }).click();
				await dialog
					.getByRole("combobox", { name: "Role for Kai Fictional" })
					.waitFor();
				await expectCall(calls, "setRole", {
					workspaceId: WORKSPACE_ID,
					userId: "member-zoe",
					role: "build",
				});

				// A link's settings change without minting or showing its URL.
				await dialog
					.getByRole("button", {
						name: "Options for Reviewers with a rather long link name",
					})
					.click();
				await page.getByRole("menuitem", { name: "Edit settings" }).click();
				const settings = dialog.locator("[data-link-settings]");
				await settings.getByLabel("Link name").fill("Reviewers");
				await assertFits(page, width, `link settings ${width} ${theme}`);
				await page.screenshot({
					path: `${directory}/dialog-link-settings-${width}-${theme}.png`,
					fullPage: true,
				});
				await settings.getByRole("button", { name: "Save" }).click();
				await settings.waitFor({ state: "detached" });
				await expectCall(calls, "updateLink", {
					workspaceId: WORKSPACE_ID,
					linkId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
					role: "use",
					label: "Reviewers",
				});
				assert.equal(await dialog.locator("[data-fresh-link]").count(), 0);
				assert.equal(calls.copyLink, undefined);

				await dialog
					.getByRole("button", { name: "Options for Kai Fictional" })
					.click();
				await page
					.getByRole("menuitem", { name: "Remove Kai Fictional" })
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

				// General access is one dropdown: a sign-in link at a role, or the
				// no-sign-in link. Each new link is shown once, with Copy link.
				const access = dialog.getByRole("combobox", {
					name: "General access",
				});
				assert.equal(
					(await access.textContent())?.trim(),
					"Anyone with the link can use",
					"the existing link sets the shown access",
				);
				await access.click();
				await page
					.getByRole("option", { name: "Anyone with the link can build" })
					.click();
				const fresh = dialog.locator("[data-fresh-link]");
				await fresh.waitFor();
				const text = await fresh.textContent();
				assert(
					text?.includes(`/shared/workspace/${WORKSPACE_ID}#share=${KEY}`),
					text ?? "",
				);
				await fresh.getByRole("button", { name: "Copy link" }).waitFor();
				assert.deepEqual(calls.createLink?.[0], {
					workspaceId: WORKSPACE_ID,
					role: "build",
				});
				assert.equal(await page.getByRole("dialog").count(), 1);
				assert.equal(await page.locator(".kumo-popover-popup").count(), 0);
				await assertFits(page, width, `link ${width} ${theme}`);

				await access.click();
				await page
					.getByRole("option", {
						name: "Anyone with the link can view, no sign-in",
					})
					.click();
				const publicUrl = dialog.locator("[data-public-url]");
				await publicUrl.waitFor();
				assert(
					(await publicUrl.textContent())?.includes(
						`/shared#token=${PUBLIC_TOKEN}`,
					),
				);
				await publicUrl.getByRole("button", { name: "Copy link" }).waitFor();
				assert.equal(await dialog.locator("[data-fresh-link]").count(), 0);
				assert.deepEqual(calls["public:create"]?.[0], {
					resourceType: "workspace",
					resourceId: WORKSPACE_ID,
					role: "use",
					revisionMode: "living",
				});
				assert.equal(
					(await access.textContent())?.trim(),
					"Anyone with the link can view, no sign-in",
				);
				await assertFits(page, width, `public ${width} ${theme}`);
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
			for (const role of ["use", "build"] as const) {
				const page = await browser.newPage({ viewport, colorScheme: theme });
				const calls = await mockApi(page, { runtime: role });
				await page.goto(`${server.origin}${path}?theme=${theme}&view=page`);
				const app = page
					.frameLocator('iframe[title="Thread finder"]')
					.frameLocator("iframe");
				await app.getByText(role, { exact: true }).waitFor();
				await app
					.getByText("Shared content: Granted document", { exact: true })
					.waitFor();
				await app.getByRole("button", { name: "Run app" }).click();
				await app.getByRole("status").filter({ hasText: "Count: 1" }).waitFor();
				assert.equal(calls.client?.length, 1);
				assert.equal(calls.readOutput?.length, 1);
				assert.equal(calls.call?.length, 1);
				assert.equal(
					await page.getByRole("button", { name: "Open workspace" }).count(),
					role === "build" ? 1 : 0,
				);
				await assertFits(page, width, `runtime ${role} ${width} ${theme}`);
				await page.screenshot({
					path: `${directory}/runtime-${role}-${width}-${theme}.png`,
					fullPage: true,
				});
				await page.close();
				cases++;
			}
			{
				const page = await browser.newPage({ viewport, colorScheme: theme });
				await mockApi(page, { runtime: "use", clientDenied: true });
				await page.goto(`${server.origin}${path}?theme=${theme}&view=page`);
				await page.getByText("This app is unavailable").waitFor();
				assert.equal(await page.locator("[data-app-runtime-frame]").count(), 0);
				await assertFits(page, width, `runtime denied ${width} ${theme}`);
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
