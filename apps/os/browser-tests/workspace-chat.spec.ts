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
	for (const [width, theme] of [
		[375, "dark"],
		[1280, "light"],
	] as const) {
		const page = await browser.newPage({
			viewport: { width, height: 844 },
			reducedMotion: "reduce",
		});
		try {
			const sent: Record<string, unknown>[] = [];
			const decisions: Record<string, unknown>[] = [];
			/** Sends a frame to the open chat, as the workspace would. */
			let push: (frame: Record<string, unknown>) => void = () => {};
			await page.routeWebSocket(
				"**/workspace/fictional-workspace/chat",
				(socket) => {
					push = (frame) => socket.send(JSON.stringify(frame));
					socket.onMessage((raw) => {
						const frame = JSON.parse(String(raw));
						if (frame.type === "decide_approvals") {
							decisions.push(frame);
							// The first change lands, the second fails, the third is left.
							push({
								type: "approval.decided",
								seq: 20,
								at: new Date().toISOString(),
								conversationId: "c2",
								approvalId: frame.approvalIds[0],
								decision: "approve",
								by: "person",
							});
							push({
								type: "approval.decided",
								seq: 21,
								at: new Date().toISOString(),
								conversationId: "c2",
								approvalId: frame.approvalIds[1],
								decision: "approve",
								by: "person",
							});
							push({
								type: "approvals.decided",
								runId: frame.runId,
								decision: "approve",
								total: 3,
								done: 1,
								alreadyDecided: 0,
								stopped: {
									approvalId: frame.approvalIds[1],
									reason: "failed",
									error: "The document changed since this was proposed",
								},
							});
						} else if (frame.type === "subscribe") {
							socket.send(
								JSON.stringify({
									type: "hello",
									waiting: [],
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
							const firstSeq = sent.length === 2 ? 1 : 50;
							const base = {
								at: new Date().toISOString(),
								conversationId: "c1",
								turnId: frame.clientTurnId,
							};
							for (const event of [
								{
									type: "turn.started",
									seq: firstSeq,
									text: frame.text,
									attachments: [
										{
											outputId: "native-doc",
											title: "Planning notes",
											revision: 2,
											revisionId: "r2",
										},
									],
									authorId: "person-subject",
									authorKind: "person",
								},
								{
									type: "turn.model",
									seq: firstSeq + 1,
									model: "provider-model-snapshot",
								},
								{
									type: "assistant.done",
									seq: firstSeq + 2,
									messageId: frame.clientTurnId,
									text: "Here is your answer.",
									model: "provider-model-snapshot",
									usage: {
										inputTokens: 120,
										outputTokens: 20,
										cachedInputTokens: 40,
										partial: true,
									},
								},
								{
									type: "turn.finished",
									seq: firstSeq + 3,
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
			const agentPicker = page.getByRole("combobox", {
				name: "Replying agent",
			});
			await agentPicker.click();
			await page
				.getByRole("option", { name: "Personal Tedi", exact: true })
				.waitFor();
			assert.equal(
				await page.getByRole("option", { name: "Other Person’s Tedi" }).count(),
				0,
			);
			await page.getByRole("option", { name: "Operations Tedi" }).click();
			assert.match(await agentPicker.innerText(), /Operations Tedi/);
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
			const turn = page.getByTestId("workspace-chat-turn");
			await turn.getByText("Ada Member", { exact: true }).waitFor();
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
			assert.equal(sent[0]?.tediId, "tedi-ops");
			assert.equal(sent[1]?.tediId, "tedi-ops");
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

			// Two other chats ask for changes: the tray lists them above the
			// composer, grouped by file and marked as asked elsewhere.
			for (const [index, request] of [
				{ approvalId: "w1", conversationId: "c2", file: "Budget" },
				{ approvalId: "w2", conversationId: "c2", file: "Budget" },
				{ approvalId: "w3", conversationId: "c3", file: "Launch notes" },
			].entries())
				push({
					type: "approval.requested",
					seq: 10 + index,
					at: new Date().toISOString(),
					conversationId: request.conversationId,
					turnId: `t-${request.approvalId}`,
					stepId: `s-${request.approvalId}`,
					approvalId: request.approvalId,
					title: "Editing document blocks",
					reason: "approval_pending",
					target: { id: `out-${request.file}`, title: request.file },
				});
			const tray = page.getByTestId("workspace-chat-tray");
			await tray.getByText("Waiting for you (3)").waitFor();
			await tray.getByText("Asked in other chats").waitFor();
			await tray.getByText("2 requests · Asked in another chat").waitFor();
			await tray
				.getByRole("button", { name: "Approve all for Budget", exact: true })
				.waitFor();
			await tray
				.getByRole("button", { name: /Budget/, expanded: false })
				.click();
			await tray
				.getByRole("button", { name: /Budget/, expanded: true })
				.waitFor();
			await page.keyboard.press("Shift");
			assert.deepEqual(
				await page.evaluate(`(() => {
${describeControl}
${controlSelector}
${focusClipAudit}
return focusClipAudit();
})()`),
				[],
				`${width} ${theme}: tray focus rings fit`,
			);
			const trayBox = await tray.boundingBox();
			assert(trayBox, "tray is laid out");
			for (const control of await tray.getByRole("button").all()) {
				const at = await control.boundingBox();
				assert(
					at &&
						at.x >= trayBox.x - 1 &&
						at.x + at.width <= trayBox.x + trayBox.width + 1,
					`${width} ${theme}: a tray button leaves the tray`,
				);
			}
			const composer = await page
				.getByRole("textbox", { name: "Message the workspace" })
				.boundingBox();
			assert(
				composer && trayBox.y + trayBox.height <= composer.y,
				`${width} ${theme}: the tray sits above the composer`,
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`${width} ${theme}: horizontal overflow with the tray`,
			);
			// Approving everything goes oldest first and stops at the failure.
			await tray
				.getByRole("button", { name: "Approve all", exact: true })
				.click();
			await tray
				.getByRole("alert")
				.getByText(
					"Approved 1 of 3. “Editing document blocks: Budget” could not be applied: The document changed since this was proposed. The rest are still waiting.",
				)
				.waitFor();
			assert.deepEqual(decisions[0]?.approvalIds, ["w1", "w2", "w3"]);
			assert.equal(decisions[0]?.decision, "approve");
			await tray.getByText("Waiting for you (1)").waitFor();
			await tray.getByRole("button", { name: "Dismiss", exact: true }).click();
			assert.equal(await tray.getByRole("alert").count(), 0);
			// The agent asks for an account: one card with one link, inside the page.
			push({
				type: "connection.requested",
				seq: 40,
				at: new Date().toISOString(),
				conversationId: "c1",
				turnId: sent.at(-1)?.clientTurnId,
				requestId: "connect-1",
				resourceId: "calendar",
				resourceName: "Team calendar with a long descriptive name",
				providerId: "example-calendar",
				service: "Example Calendar",
				connectionScope: "personal",
				reason: "To check the dates of the open challenges.",
			});
			const connect = page.getByTestId("workspace-chat-connect");
			await connect.getByText("Connect Example Calendar").waitFor();
			await connect
				.getByText("To check the dates of the open challenges.")
				.waitFor();
			const connectLink = connect.getByTestId("workspace-chat-connect-link");
			assert.equal(
				await connectLink.getAttribute("href"),
				"/account/connections?connect=example-calendar",
			);
			await connectLink.scrollIntoViewIfNeeded();
			await page.keyboard.press("Shift");
			assert.deepEqual(
				await page.evaluate(`(() => {
${describeControl}
${controlSelector}
${focusClipAudit}
return focusClipAudit();
})()`),
				[],
				`${width} ${theme}: the Connect card's focus ring fits`,
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`${width} ${theme}: horizontal overflow with a Connect card`,
			);
			const message = page.getByRole("textbox", {
				name: "Message the workspace",
			});
			await message.fill("@Pers");
			await page
				.getByRole("group", { name: "Mention a tedi" })
				.getByRole("button", { name: "Personal Tedi" })
				.waitFor();
			await message.fill("@Personal Tedi Please review the notes");
			await message.press("Enter");
			await page
				.getByText("@Personal Tedi Please review the notes", { exact: true })
				.waitFor();
			assert.equal(sent[2]?.tediId, "tedi-personal");
			push({
				type: "turn.started",
				seq: 54,
				at: new Date().toISOString(),
				conversationId: "c1",
				turnId: "agent-started",
				text: "I brought the planning notes.",
				authorId: "tedi-ops",
				authorKind: "tedi",
			});
			const agentMessage = page.getByTestId("workspace-chat-turn").filter({
				hasText: "I brought the planning notes.",
			});
			await agentMessage
				.getByText("Operations Tedi", { exact: true })
				.waitFor();
			assert.equal(
				await agentMessage.locator('[data-entity-kind="tedi"]').count(),
				1,
			);
		} finally {
			await page.close();
		}
	}
	const runPage = await browser.newPage();
	try {
		await runPage.routeWebSocket(
			"**/workspace/fictional-workspace/chat",
			(socket) => {
				socket.onMessage((raw) => {
					if (JSON.parse(String(raw)).type !== "subscribe") return;
					const send = (value: unknown) => socket.send(JSON.stringify(value));
					const at = new Date().toISOString();
					const turn = { at, conversationId: "c1", turnId: "coding-turn" };
					send({
						type: "hello",
						waiting: [],
						cursor: 0,
						serverTime: at,
						conversations: [],
					});
					send({
						...turn,
						type: "turn.started",
						seq: 1,
						text: "Fix the paging",
						authorId: "person-subject",
						authorKind: "person",
					});
					send({
						...turn,
						type: "step.finished",
						seq: 2,
						stepId: "start-run",
						tool: "work.startRun",
						status: "ok",
						durationMs: 10,
						result: JSON.stringify({
							kind: "agent_run",
							workItemId: "fixture-run-task",
							title: "Fix the paging",
							executor: "codex",
							url: "/work/items/fixture-run-task",
						}),
					});
					send({ ...turn, type: "turn.finished", seq: 3, status: "done" });
					send({ type: "caught_up", conversationId: "c1" });
				});
			},
		);
		await runPage.goto(server.origin + "/browser-tests/workspace-chat.html");
		const card = runPage.locator('[data-slot="agent-run-card"]');
		await card.getByText("Reading the project files").waitFor();
		await runPage.reload();
		await card.getByText("Reading the project files").waitFor();
		assert.equal(await card.count(), 1);
		assert.equal(
			await card.getByRole("link", { name: "Open task" }).getAttribute("href"),
			"/work/items/fixture-run-task",
		);
	} finally {
		await runPage.close();
	}
} finally {
	await browser.close();
	await server.stop();
}
console.log("Workspace chat model, usage, cost and responsive layout passed.");
