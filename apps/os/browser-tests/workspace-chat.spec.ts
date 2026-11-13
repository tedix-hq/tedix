import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";
import {
	controlSelector,
	describeControl,
	focusClipAudit,
} from "./focus-clip-page";

const server = await startFixtureServer("/browser-tests/workspace-chat.html");
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280]) {
		for (const theme of ["light", "dark"]) {
			const page = await browser.newPage({
				viewport: { width, height: 844 },
				reducedMotion: "reduce",
			});
			try {
				const sent: Record<string, unknown>[] = [];
				await page.routeWebSocket(
					"**/workspace/fictional-workspace/chat",
					(socket) => {
						socket.onMessage((raw) => {
							const frame = JSON.parse(String(raw));
							if (frame.type === "subscribe") {
								socket.send(
									JSON.stringify({
										type: "hello",
										cursor: 0,
										serverTime: new Date().toISOString(),
										conversations: [],
										models: [
											{
												id: "azure-openai/configured",
												label: "Configured Workspace Model",
											},
										],
									}),
								);
								socket.send(
									JSON.stringify({ type: "caught_up", conversationId: "c1" }),
								);
							} else if (frame.type === "send_turn") {
								sent.push(frame);
								if (sent.length === 1) {
									socket.send(
										JSON.stringify({
											type: "error",
											code: "failed",
											message:
												"The selected file is unavailable. Remove it and try again.",
											clientTurnId: frame.clientTurnId,
										}),
									);
									return;
								}
								const base = {
									at: new Date().toISOString(),
									conversationId: "c1",
									turnId: frame.clientTurnId,
								};
								for (const event of [
									{
										type: "turn.started",
										seq: 1,
										text: frame.text,
										attachments: [
											{
												outputId: "native-doc",
												title: "Planning notes",
												revision: 2,
												revisionId: "r2",
											},
										],
										authorId: "person",
										authorKind: "person",
									},
									{
										type: "turn.model",
										seq: 2,
										model: "provider-model-snapshot",
									},
									{
										type: "assistant.done",
										seq: 3,
										messageId: frame.clientTurnId,
										text: "Here is your answer.",
										model: "provider-model-snapshot",
										usage: {
											inputTokens: 120,
											outputTokens: 20,
											cachedInputTokens: 40,
											partial: true,
											costCents: 2,
										},
									},
									{
										type: "turn.finished",
										seq: 4,
										status: "done",
										durationMs: 2000,
									},
								])
									socket.send(JSON.stringify({ ...base, ...event }));
								socket.send(
									JSON.stringify({
										type: "turn.accepted",
										clientTurnId: frame.clientTurnId,
										turnId: frame.clientTurnId,
										conversationId: "c1",
									}),
								);
							}
						});
					},
				);
				await page.goto(
					`${server.origin}/browser-tests/workspace-chat.html?theme=${theme}`,
				);
				const picker = page.getByRole("combobox", {
					name: "Model",
				});
				await picker.waitFor();
				await picker.click();
				const option = page.getByRole("option", {
					name: "Configured Workspace Model",
				});
				await option.waitFor();
				assert.equal(await page.getByRole("option").count(), 1);
				await option.click();
				await page
					.getByRole("button", { name: "Add files", exact: true })
					.click();
				const file = page.getByRole("button", {
					name: "Planning notes",
					exact: true,
				});
				await file.waitFor();
				await page.keyboard.press("Shift");
				const clipped = await page.evaluate(`(() => {
${describeControl}
${controlSelector}
${focusClipAudit}
return focusClipAudit();
})()`);
				assert.deepEqual(
					clipped,
					[],
					`${width} ${theme}: resource picker focus rings fit`,
				);
				await file.click();
				await page
					.getByRole("button", { name: "Remove Planning notes", exact: true })
					.waitFor();
				await page
					.getByRole("textbox", { name: "Message the workspace" })
					.fill("Show usage");
				await page.getByRole("button", { name: "Send", exact: true }).click();
				await page
					.getByRole("alert")
					.getByText(/selected file is unavailable/)
					.waitFor();
				assert.equal(
					await page
						.getByRole("textbox", { name: "Message the workspace" })
						.inputValue(),
					"Show usage",
				);
				await page
					.getByRole("button", { name: "Remove Planning notes", exact: true })
					.waitFor();
				await page.getByRole("button", { name: "Send", exact: true }).click();
				// A finished answer has no line under it; its time holds the details.
				await page.getByText("Here is your answer.").waitFor();
				assert.equal(
					await page.locator(".workspace-chat-turn-footer").count(),
					0,
				);
				assert.equal(await page.getByText(/unavailable/i).count(), 0);
				const time = page.getByTestId("workspace-chat-turn-time");
				assert.equal(
					await time.evaluate((node) => getComputedStyle(node).opacity),
					"0",
				);
				await time.focus();
				await page.waitForFunction(
					() =>
						getComputedStyle(
							document.querySelector("[data-testid=workspace-chat-turn-time]")!,
						).opacity === "1",
				);
				await time.hover();
				const footer = page.getByRole("tooltip");
				await footer.getByText(/provider-model-snapshot/).waitFor();
				assert.equal(sent.length, 2);
				assert.equal(
					await page
						.getByRole("textbox", { name: "Message the workspace" })
						.inputValue(),
					"",
				);
				assert.equal(
					await page
						.getByRole("button", { name: "Remove Planning notes", exact: true })
						.count(),
					0,
				);
				assert.equal(sent[0]?.modelId, "azure-openai/configured");
				assert.deepEqual(sent[0]?.attachments, [{ outputId: "native-doc" }]);
				await page
					.getByRole("link", { name: "Planning notes", exact: true })
					.waitFor();
				assert.match(
					await page
						.getByRole("list", { name: "Message files", exact: true })
						.innerText(),
					/Revision 2/,
				);
				assert.match(
					await footer.innerText(),
					/Took 2s\s+provider-model-snapshot\s+120 input · 20 output tokens · 40 cached input · partial usage/,
				);
				assert(!/[€$]/.test(await footer.innerText()));
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
					`${width} ${theme}: horizontal overflow`,
				);
				const box = await picker.boundingBox();
				assert(box && box.x >= 0 && box.x + box.width <= width);
			} finally {
				await page.close();
			}
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
console.log("Workspace chat model, usage, cost and responsive layout passed.");
