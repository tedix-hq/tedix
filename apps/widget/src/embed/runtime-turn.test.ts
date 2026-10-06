// @vitest-environment happy-dom
/**
 * The embed runtime's turn: what a customer sees from pressing Enter to the
 * settled answer, driven through the real runtime against a fake transport.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import enCatalog from "@tedix/widget-i18n/en.json";
import {
	bootWidget,
	sessionResult,
	settle,
	teardown,
	tick,
	transport,
	type Widget,
} from "./runtime-harness";
import { WIDGET_FRAME_SANDBOX } from "./widget-frame";

vi.mock("@tedix/chat-transport/embedded-client", async () => ({
	createEmbeddedClient: (await import("./runtime-harness"))
		.createFakeEmbeddedClient,
}));

afterEach(() => {
	teardown();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const tool = (type: string, extra: Record<string, unknown> = {}) => ({
	kind: "chunk",
	body: { type, toolCallId: "call-1", toolName: "shop.list_orders", ...extra },
});

async function answering(w: Widget, text = "Where is my order?") {
	await w.open();
	await w.say(text);
	return w.waitForStream();
}

describe("a turn", () => {
	it("streams deltas through the shared reducer and renders markdown on every delta", async () => {
		const w = await bootWidget();
		const stream = await answering(w);
		expect(w.input().value).toBe("");
		expect(w.send().getAttribute("aria-label")).toBe("Stop");
		stream.frame({ kind: "delta", text: "It is **ship" });
		await settle();
		expect(w.$(".tedix-message-assistant .tedix-bubble")?.textContent).toBe(
			"It is **ship",
		);
		stream.frame({ kind: "delta", text: "ped**" });
		await settle();
		expect(
			w.$(".tedix-message-assistant .tedix-bubble strong")?.textContent,
		).toBe("shipped");
		stream.frame({ kind: "done", text: "It is **shipped**" });
		stream.finish();
		await settle();
		expect(w.messages()).toEqual([
			["user", "Where is my order?"],
			["assistant", "It is shipped"],
		]);
		expect(w.send().getAttribute("aria-label")).toBe("Send");
		expect(w.detailsOf("answer-completed")).toHaveLength(1);
	});

	it("sends the turn with its request id, current page context and only the chosen model options", async () => {
		const w = await bootWidget({
			options: {
				session: vi.fn(async () =>
					sessionResult({
						modelSelection: {
							models: [
								{ ref: "fast", label: "Fast" },
								{ ref: "deep", label: "Deep", reasoning: true },
							],
							efforts: ["low", "high"],
							defaultRef: "fast",
						},
					}),
				),
			},
		});
		document.title = "Orders";
		document.body.insertAdjacentHTML(
			"beforeend",
			"<main><h1>Open orders</h1></main>",
		);
		vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([
			{},
		] as unknown as DOMRectList);
		w.Tedix.context({
			pathname: "/orders",
			entity: { type: "order", id: "1" },
		});
		const first = await answering(w, "First");
		expect(first.input.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
		expect(first.input).not.toHaveProperty("modelRef");
		expect(first.input).not.toHaveProperty("reasoningEffort");
		expect(first.input.pageContext).toMatchObject({
			title: "Orders",
			sections: ["Open orders"],
			entity: { type: "order", id: "1" },
		});
		first.frame({ kind: "done", text: "ok" });
		first.finish();
		await settle();
		// The DOM snapshot belongs to the turn, never to the host's context.
		expect(w.Tedix.status().pageContext).not.toHaveProperty("sections");

		const model = w.$<HTMLSelectElement>(".tedix-model-select")!;
		expect(model.hidden).toBe(false);
		expect(model.options[0]?.textContent).toBe("Automatic · Fast");
		model.value = "deep";
		model.dispatchEvent(new Event("change"));
		const effort = w.$<HTMLSelectElement>(".tedix-effort-select")!;
		expect(effort.hidden).toBe(false);
		effort.value = "high";
		effort.dispatchEvent(new Event("change"));
		document.title = "Orders updated";
		document.querySelector("main h1")!.textContent = "Completed orders";
		await w.say("Second");
		const second = await w.waitForStream(2);
		expect(second.input).toMatchObject({
			text: "Second",
			modelRef: "deep",
			reasoningEffort: "high",
			pageContext: { title: "Orders updated", sections: ["Completed orders"] },
		});
		expect(second.input.clientRequestId).not.toBe(first.input.clientRequestId);
		expect(
			JSON.parse(sessionStorage.getItem("tedix:model-choice:v1:demo-shop")!),
		).toEqual({ modelRef: "deep", effort: "high" });
	});

	it("restores a remembered model choice at mount without failing the mount", async () => {
		const w = await bootWidget({
			before: () =>
				sessionStorage.setItem(
					"tedix:model-choice:v1:demo-shop",
					JSON.stringify({ modelRef: "deep", effort: "" }),
				),
			options: {
				session: vi.fn(async () =>
					sessionResult({
						modelSelection: { models: [{ ref: "deep", label: "Deep" }] },
					}),
				),
			},
		});
		expect(w.Tedix.status().mounted).toBe(true);
		const stream = await answering(w);
		expect(stream.input.modelRef).toBe("deep");
	});

	it("reports the tool phase once, in the worklog, in product language", async () => {
		const w = await bootWidget({ options: { product: "Acme" } });
		const stream = await answering(w);
		expect(w.$(".tedix-thinking-label")?.textContent).toBe("Thinking");
		stream.frame({ kind: "phase", phase: "planning" });
		stream.frame(tool("tool-input-available", { input: { status: "open" } }));
		await settle();
		const worklog = w.$<HTMLDetailsElement>(".tedix-worklog")!;
		expect(worklog.open).toBe(true);
		expect(worklog.querySelector(".tedix-worklog-label")?.textContent).toMatch(
			/^Looking in Acme · \d+s$/,
		);
		// Exactly one status line: the bubble's own line is gone, not hidden.
		expect(w.$(".tedix-thinking")).toBeNull();
		const step = worklog.querySelector<HTMLElement>(".tedix-worklog-step")!;
		expect(step.dataset.status).toBe("running");
		expect(step.textContent).toBe("Checking Acme…");
		// A person never reads a callable or a raw payload.
		expect(worklog.textContent).not.toContain("list_orders");
		expect(worklog.textContent).not.toContain("open");

		stream.frame({
			kind: "chunk",
			body: { type: "reasoning-delta", delta: "Comparing the two orders" },
		});
		stream.frame(tool("tool-output-available", { output: { total: 2 } }));
		stream.frame({ kind: "delta", text: "Two orders are open." });
		await settle();
		expect(worklog.querySelector(".tedix-worklog-thinking")?.textContent).toBe(
			"Comparing the two orders",
		);
		expect(step.dataset.status).toBe("completed");
		expect(step.textContent).toBe("✓ Checked Acme");
		stream.frame({ kind: "done", text: "Two orders are open." });
		stream.finish();
		await settle();
		expect(worklog.open).toBe(false);
		expect(worklog.querySelector(".tedix-worklog-label")?.textContent).toMatch(
			/^Worked for \d+s$/,
		);
		expect(worklog.querySelector(".tedix-worklog-thinking")).toBeNull();
		// Activities precede the answer inside the assistant turn.
		const turn = w.$(".tedix-message-assistant")!;
		expect([...turn.children].map((node) => node.className)).toEqual([
			"tedix-activities",
			"tedix-bubble",
		]);
	});

	it("keeps the elapsed suffix on every writer and the worklog header ticking through a tool phase", async () => {
		const w = await bootWidget({ options: { product: "Acme" } });
		vi.useFakeTimers({
			toFake: ["setInterval", "clearInterval", "performance"],
		});
		const stream = await answering(w);
		const label = () => w.$(".tedix-thinking-label")?.textContent;
		vi.advanceTimersByTime(1000);
		const before = label();
		expect(before).toMatch(/^Thinking · \d+s$/);
		stream.frame({ kind: "phase", phase: "preparing_context" });
		vi.advanceTimersByTime(1000);
		expect(label()).toMatch(/^Getting ready · \d+s$/);
		stream.frame(tool("tool-input-available"));
		vi.advanceTimersByTime(1000);
		const header = () =>
			w.$(".tedix-worklog-label")?.textContent?.match(/· (\d+)s$/)?.[1];
		const at = Number(header());
		vi.advanceTimersByTime(6000);
		expect(Number(header())).toBe(at + 6);
		vi.advanceTimersByTime(7000);
		expect(Number(header())).toBe(at + 13);
		expect(w.$(".tedix-thinking")).toBeNull();
		vi.useRealTimers();
		stream.frame({ kind: "done", text: "done" });
		stream.finish();
		await settle();
	});

	it("degrades a busy worklog to one count", async () => {
		const w = await bootWidget({
			options: {
				toolLabels: Object.fromEntries(
					["a", "b", "c", "d"].map((id) => [
						`shop.${id}`,
						{ invoking: `Reading ${id}`, invoked: `Read ${id}` },
					]),
				),
			},
		});
		const stream = await answering(w);
		for (const id of ["a", "b", "c", "d"])
			stream.frame({
				kind: "chunk",
				body: {
					type: "tool-output-available",
					toolCallId: id,
					toolName: `shop.${id}`,
					output: {},
				},
			});
		await settle();
		const steps = w.$$<HTMLElement>(".tedix-worklog-step");
		expect(
			steps.filter((step) => !step.hidden).map((step) => step.textContent),
		).toEqual(["4 actions"]);
	});

	it("frames MCP App projections through the sandboxed widget-frame gate and follows the host theme", async () => {
		const w = await bootWidget({
			before: () => (document.documentElement.dataset.theme = "dark"),
		});
		const stream = await answering(w);
		stream.frame(
			tool("tool-output-available", {
				output: {
					_meta: {
						ui: { resourceUri: "ui://widgets/mcp-app/shop/r/orders.html" },
					},
					structuredContent: { orders: [1] },
				},
			}),
		);
		await settle();
		const iframe = w.$<HTMLIFrameElement>(".tedix-widget-frame iframe")!;
		expect(iframe.getAttribute("sandbox")).toBe(WIDGET_FRAME_SANDBOX);
		expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
		expect(iframe.dataset.tedixMcpApp).toBe("true");
		const url = new URL(iframe.src);
		expect(url.origin).toBe("https://mcp-ui.tedix.dev");
		expect(url.pathname).toBe("/shop/r/orders");
		expect(url.searchParams.get("theme")).toBe("dark");
		expect(url.hash).toMatch(/^#data=[A-Za-z0-9_-]+$/);
		document.documentElement.dataset.theme = "light";
		await settle();
		expect(new URL(iframe.src).searchParams.get("theme")).toBe("light");
	});

	it("turns an approval request into a card the customer decides", async () => {
		const w = await bootWidget();
		const stream = await answering(w);
		stream.frame(
			tool("tool-output-available", {
				output: {
					status: "approval_requested",
					approvalRequestId: "approval-1",
					description: "Refund order 42",
				},
			}),
		);
		await settle();
		const card = w.$(".tedix-approval")!;
		expect(card.querySelector("strong")?.textContent).toBe(
			"Confirmation required",
		);
		expect(card.querySelector("p")?.textContent).toBe("Refund order 42");
		card.querySelector<HTMLButtonElement>('[data-decision="approve"]')!.click();
		await settle();
		expect(w.client()!.resolveApproval).toHaveBeenCalledWith(
			"approval-1",
			true,
		);
		expect(card.dataset.resolved).toBe("approved");
		const watcher = w.client()!.watchApprovals.mock.results[0]!.value;
		expect(watcher.wake).toHaveBeenCalledOnce();
	});

	it("binds copy buttons on rendered code and unbinds them at shutdown", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		const w = await bootWidget();
		const stream = await answering(w);
		stream.frame({ kind: "done", text: "```\nnpm test\n```" });
		stream.finish();
		await settle();
		const copy = w.$<HTMLButtonElement>("[data-md-copy]")!;
		expect(copy.getAttribute("aria-label")).toBe(enCatalog.copy_code);
		copy.click();
		await settle();
		expect(writeText).toHaveBeenCalledWith("npm test");
		const thread = w.thread();
		w.Tedix.shutdown();
		thread.querySelector<HTMLButtonElement>("[data-md-copy]")!.click();
		await settle();
		expect(writeText).toHaveBeenCalledOnce();
	});

	it("renders only same-origin host routes and https links from the answer", async () => {
		const w = await bootWidget();
		const stream = await answering(w);
		stream.frame({
			kind: "done",
			text: "[order](/orders/42) [docs](https://docs.example.com) [bad](javascript:alert(1))",
		});
		stream.finish();
		await settle();
		const links = w.$$<HTMLAnchorElement>(".tedix-message-assistant a");
		expect(links.map((link) => link.getAttribute("href"))).toEqual([
			"/orders/42",
			"https://docs.example.com/",
		]);
		expect(w.$(".tedix-message-assistant")?.textContent).toContain("bad");
	});

	it("settles locally when no terminal frame arrives and frees the composer", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const w = await bootWidget();
		await w.open();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		w.type("Anyone there?");
		w.submitForm();
		for (let i = 0; i < 20 && !transport().streams.length; i += 1)
			await vi.advanceTimersByTimeAsync(20);
		const stream = transport().streams[0]!;
		// A runtime that wedges before speaking is still bounded.
		await vi.advanceTimersByTimeAsync(149_000);
		expect(w.detailsOf("answer-failed")).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1_500);
		expect(stream.signal.aborted).toBe(true);
		expect(w.client()!.cancel).toHaveBeenCalledWith(
			stream.input.clientRequestId,
		);
		expect(w.detailsOf("answer-failed")).toHaveLength(1);
		expect(w.detailsOf("answer-completed")).toHaveLength(0);
		expect(w.Tedix.status().reliability.lastTurnOutcome).toBe("failed");
		expect(w.send().getAttribute("aria-label")).toBe("Send");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(
				"no terminal frame within the phase timeout; failed locally",
			),
		);
	});
});

describe("the composer", () => {
	it("acknowledges the submit before a host preparation and restores the draft when it is cancelled", async () => {
		let finish!: (value: null) => void;
		const prepare = vi.fn(
			() => new Promise<null>((resolve) => (finish = resolve)),
		);
		const w = await bootWidget({
			options: { prepareConversationContext: prepare },
		});
		await w.open();
		w.type("My question");
		w.submitForm();
		// Cleared and turned into Stop synchronously, before any await.
		expect(w.input().value).toBe("");
		expect(w.send().getAttribute("aria-label")).toBe("Stop");
		await tick(0);
		expect(prepare).toHaveBeenCalledWith(
			expect.objectContaining({ text: "My question", pathname: "/" }),
		);
		w.submitForm(w.send());
		await settle();
		expect(w.input().value).toBe("My question");
		expect(w.send().getAttribute("aria-label")).toBe("Send");
		finish(null);
		await settle();
		expect(transport().streams).toHaveLength(0);
		// The composer is usable again.
		w.submitForm();
		const retried = await w.waitForStream();
		expect(retried.input.text).toBe("My question");
	});

	it.each([
		["an unsupported result", { kind: "mystery" }],
		["an invalid context", { kind: "context", context: { kind: "Bad Kind" } }],
		[
			"a cross-origin handoff",
			{ kind: "handoff", url: "https://evil.example/x" },
		],
	])(
		"restores what was typed when the host preparation returns %s",
		async (_case, result) => {
			const w = await bootWidget({
				options: { prepareConversationContext: vi.fn(async () => result) },
			});
			await w.open();
			await w.say("Keep this");
			await settle();
			expect(w.input().value).toBe("Keep this");
			expect(w.$(".tedix-message-assistant")?.textContent).toBeTruthy();
			expect(transport().streams).toHaveLength(0);
			expect(location.pathname).toBe("/");
		},
	);

	it("binds a prepared host context into a fresh signed session before the first turn", async () => {
		const context = { kind: "work_item", reference: "wi-1", label: "Order 42" };
		const w = await bootWidget({
			options: {
				prepareConversationContext: vi.fn(async () => ({
					kind: "context",
					context,
				})),
			},
		});
		await w.open();
		const openedWith = w.client();
		await w.say("Continue");
		await w.waitForStream();
		expect(openedWith?.dispose).toHaveBeenCalled();
		expect(w.session).toHaveBeenLastCalledWith(
			expect.objectContaining({ hostConversationContext: context }),
		);
	});

	it("hands a prepared conversation to a same-origin host route", async () => {
		const w = await bootWidget({
			options: {
				prepareConversationContext: vi.fn(async () => ({
					kind: "handoff",
					url: "/chat/42",
				})),
			},
		});
		await w.open();
		await w.say("Open full chat");
		await settle();
		expect(location.pathname).toBe("/chat/42");
		expect(transport().streams).toHaveLength(0);
		history.replaceState(null, "", "/");
	});

	it("never clears a draft the customer is typing when the host asks programmatically", async () => {
		const w = await bootWidget();
		await w.open();
		w.type("half a sente");
		const answer = w.Tedix.ask("What is new?");
		const stream = await w.waitForStream();
		expect(stream.input.text).toBe("What is new?");
		expect(w.input().value).toBe("half a sente");
		stream.frame({ kind: "done", text: "Nothing yet" });
		stream.finish();
		await expect(answer).resolves.toBe("Nothing yet");
	});

	it("submits on Enter but not while an IME is composing or with Shift", async () => {
		const w = await bootWidget();
		await w.open();
		w.type("こんにちは");
		w.pressEnter({ isComposing: true });
		w.pressEnter({ keyCode: 229 } as KeyboardEventInit);
		w.pressEnter({ shiftKey: true });
		await settle();
		expect(transport().streams).toHaveLength(0);
		w.pressEnter();
		await w.waitForStream();
		expect(transport().streams[0]!.input.text).toBe("こんにちは");
	});

	it("refuses a second programmatic ask while a turn runs instead of dropping it", async () => {
		const w = await bootWidget();
		await answering(w);
		await expect(w.Tedix.ask("Another")).rejects.toMatchObject({
			code: "turn_in_progress",
		});
	});
});

describe("a follow-up typed while a turn is answering", () => {
	it("stops the turn when the stop control itself is pressed", async () => {
		const w = await bootWidget();
		const stream = await answering(w);
		w.submitForm(w.send());
		await settle();
		expect(stream.signal.aborted).toBe(true);
		expect(w.client()!.cancel).toHaveBeenCalledWith(
			stream.input.clientRequestId,
		);
		expect(w.detailsOf("answer-cancelled")).toHaveLength(1);
		expect(w.Tedix.status().reliability.lastTurnOutcome).toBe("cancelled");
	});

	it("queues the text instead of aborting, shows it immediately, and sends it once the turn settles", async () => {
		const w = await bootWidget();
		const stream = await answering(w, "First");
		w.type("And the second?");
		w.pressEnter();
		await settle();
		expect(stream.signal.aborted).toBe(false);
		expect(w.input().value).toBe("");
		expect(w.messages().map(([role, text]) => `${role}:${text}`)).toEqual([
			"user:First",
			expect.stringMatching(/^assistant:/),
			"user:And the second?",
		]);
		expect(transport().streams).toHaveLength(1);
		stream.frame({ kind: "done", text: "One" });
		stream.finish();
		const next = await w.waitForStream(2);
		expect(next.input.text).toBe("And the second?");
		// Its bubble was already on screen; the turn does not add a second one.
		expect(
			w.messages().filter(([, text]) => text === "And the second?"),
		).toHaveLength(1);
	});
});

describe("a turn whose exact stream could not be recovered", () => {
	it("never promotes an older answer to a newly failed identical question", async () => {
		const w = await bootWidget();
		const first = await answering(w, "What is the order status?");
		first.frame({ kind: "done", text: "Old answer: pending" });
		first.finish();
		await settle();
		await w.say("What is the order status?");
		const second = await w.waitForStream(2);
		second.fail(new Error("connection closed"));
		await settle();
		const bubbles = w.$$(".tedix-message-assistant .tedix-bubble");
		expect(bubbles.at(-1)?.textContent).not.toContain("Old answer");
		expect(bubbles.at(-1)?.querySelector("p")?.textContent).toBeTruthy();
		expect(w.client()!.readTranscript).not.toHaveBeenCalled();
		expect(w.detailsOf("answer-failed").at(-1)).toMatchObject({
			eventId: second.input.clientRequestId,
			code: expect.any(String),
		});
		expect(w.detailsOf("answer-completed")).toHaveLength(1);
		expect(w.Tedix.status().reliability.lastTurnOutcome).toBe("failed");
		expect(w.input().value).toBe("What is the order status?");
	});

	it("preserves this turn's partial answer alongside the localized failure", async () => {
		const w = await bootWidget();
		const stream = await answering(w);
		stream.frame({ kind: "delta", text: "Current partial answer" });
		await settle();
		stream.fail(new Error("connection closed"));
		await settle();
		const bubble = w.$(".tedix-message-assistant .tedix-bubble")!;
		expect(bubble.textContent).toContain("Current partial answer");
		expect(bubble.querySelectorAll("p")).toHaveLength(2);
		expect(Object.values(enCatalog)).toContain(
			bubble.querySelector("p:last-child")?.textContent,
		);
	});
});
