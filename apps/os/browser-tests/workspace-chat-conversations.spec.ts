import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer(
	"/browser-tests/workspace-chat-conversations.html",
);
const browser = await chromium.launch({ headless: true });
const hoursAgo = (hours: number) =>
	new Date(Date.now() - hours * 3_600_000).toISOString();
try {
	for (const width of [375, 1280]) {
		for (const theme of ["light", "dark"]) {
			const page = await browser.newPage({
				viewport: { width, height: 844 },
				reducedMotion: "reduce",
			});
			try {
				page.setDefaultTimeout(10_000);
				const sent: Record<string, unknown>[] = [];
				let seq = 10;
				let launchTitle = "Plan the launch";
				let launchDeleted = false;
				await page.routeWebSocket(
					"**/workspace/fictional-workspace/chat",
					(socket) => {
						const event = (body: Record<string, unknown>) =>
							socket.send(
								JSON.stringify({
									seq: ++seq,
									at: new Date().toISOString(),
									...body,
								}),
							);
						socket.onMessage((raw) => {
							const frame = JSON.parse(String(raw));
							if (frame.type === "subscribe") {
								socket.send(
									JSON.stringify({
										type: "hello",
										waiting: [],
										serverTime: new Date().toISOString(),
										cursor: seq,
										conversations: [
											{
												id: "c1",
												title: launchTitle,
												updatedAt: hoursAgo(0.1),
												lastTurnAt: hoursAgo(0.1),
												pendingApprovals: 1,
											},
											{
												id: "c2",
												title: "Draft the budget for the whole of next year",
												updatedAt: hoursAgo(24 * 30),
												lastTurnAt: hoursAgo(24 * 30),
												running: true,
											},
										].filter((row) => row.id !== "c1" || !launchDeleted),
										archived: [
											{
												id: "c3",
												title: "Old notes",
												updatedAt: hoursAgo(24 * 40),
												lastTurnAt: hoursAgo(24 * 40),
												archivedAt: hoursAgo(24),
											},
										],
									}),
								);
								socket.send(
									JSON.stringify({
										type: "caught_up",
										conversationId: frame.conversationId,
									}),
								);
								return;
							}
							sent.push(frame);
							if (frame.type === "rename_conversation") {
								// A later chat on this page connects to the new name.
								launchTitle = frame.title;
								event({
									type: "conversation.updated",
									conversationId: frame.conversationId,
									title: frame.title,
								});
							}
							if (frame.type === "archive_conversation")
								event({
									type: "conversation.updated",
									conversationId: frame.conversationId,
									archivedAt: frame.archived ? new Date().toISOString() : null,
								});
							if (frame.type === "delete_conversation") {
								launchDeleted = true;
								socket.send(
									JSON.stringify({
										type: "conversation.deleted",
										conversationId: frame.conversationId,
										cursor: seq,
									}),
								);
							}
						});
					},
				);
				await page.goto(
					`${server.origin}/browser-tests/workspace-chat-conversations.html?theme=${theme}`,
				);
				const label = `${width} ${theme}`;
				const today = page.getByRole("region", { name: "Today" });
				await today.getByText("Plan the launch").waitFor();
				await today.getByText("Needs approval").waitFor();
				await page
					.getByRole("region", { name: "Earlier", exact: true })
					.getByRole("img", { name: "Working" })
					.waitFor();
				assert.equal(await page.getByText("Old notes").count(), 0);

				// Rename from the row menu: the field keeps the focus after the menu closes.
				await page
					.getByRole("button", { name: "Actions for Plan the launch" })
					.click();
				await page.getByRole("menuitem", { name: "Rename" }).click();
				const name = page.getByRole("textbox", { name: "Conversation name" });
				await name.waitFor();
				await page.waitForTimeout(300);
				assert(
					await name.evaluate((node) => node === document.activeElement),
					`${label}: the name field lost the focus`,
				);
				await page.keyboard.type("Launch plan");
				await page.keyboard.press("Enter");
				await today.getByText("Launch plan", { exact: true }).waitFor();
				assert.deepEqual(sent.at(-1), {
					type: "rename_conversation",
					conversationId: "c1",
					title: "Launch plan",
				});

				// Archive, find it under Archived, restore it.
				await page
					.getByRole("button", { name: "Actions for Launch plan" })
					.click();
				await page.getByRole("menuitem", { name: "Archive" }).click();
				await page.getByRole("button", { name: "Archived (2)" }).click();
				await page.getByText("Old notes").waitFor();
				await page
					.getByRole("button", { name: "Actions for Launch plan" })
					.click();
				await page.getByRole("menuitem", { name: "Restore" }).click();
				await page.getByRole("button", { name: "Conversations" }).click();
				await today.getByText("Launch plan", { exact: true }).waitFor();

				// A conversation that is working cannot be deleted from the menu.
				await page
					.getByRole("button", { name: /^Actions for Draft the budget/ })
					.click();
				assert.equal(
					await page
						.getByRole("menuitem", { name: "Delete" })
						.getAttribute("aria-disabled"),
					"true",
				);
				await page.keyboard.press("Escape");

				// Rename the open conversation from its title in the header.
				await today.getByText("Launch plan", { exact: true }).click();
				await page.getByRole("button", { name: "Launch plan" }).click();
				await name.waitFor();
				await page.keyboard.type("Launch");
				await page.keyboard.press("Enter");
				await page
					.getByRole("button", { name: "Launch", exact: true })
					.waitFor();
				assert.deepEqual(sent.at(-1), {
					type: "rename_conversation",
					conversationId: "c1",
					title: "Launch",
				});

				// Delete asks first, then the chat returns to the list without it.
				await page.getByRole("button", { name: "All conversations" }).click();
				await page.getByRole("button", { name: "Actions for Launch" }).click();
				await page.getByRole("menuitem", { name: "Delete" }).click();
				const dialog = page.getByRole("alertdialog");
				assert.match(await dialog.innerText(), /This cannot be undone\./);
				await dialog.getByRole("button", { name: "Delete" }).click();
				await page
					.getByRole("button", { name: /^Actions for Draft the budget/ })
					.waitFor();
				assert.equal(
					await page.getByText("Launch", { exact: true }).count(),
					0,
				);
				assert.deepEqual(sent.at(-1), {
					type: "delete_conversation",
					conversationId: "c1",
				});
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
					`${label}: horizontal overflow`,
				);
			} finally {
				await page.close();
			}
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
console.log(
	"Workspace conversation rename, archive, restore and delete passed.",
);
