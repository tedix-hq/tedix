// @vitest-environment happy-dom
/**
 * Page tools in the embed runtime: the host page's own actions offered to the
 * chat for one turn, run here when the model asks, with an activity row, Undo
 * where the page supports it, and an inline confirm before any submit.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	bootWidget,
	settle,
	teardown,
	transport,
	type Widget,
} from "./runtime-harness";

vi.mock("@tedix/chat-transport/embedded-client", async () => ({
	createEmbeddedClient: (await import("./runtime-harness"))
		.createFakeEmbeddedClient,
}));

afterEach(() => {
	teardown();
	vi.restoreAllMocks();
});

const ok = (data: Record<string, unknown>) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data) }],
	structuredContent: data,
});

function deckPage() {
	const card = { answer: "", staged: null as string | null, submitted: "" };
	const tools = [
		{
			name: "set_decision_card_answer",
			description: "Fill the answer on the card on screen.",
			inputSchema: {
				type: "object",
				properties: { cardId: { type: "string" }, text: { type: "string" } },
				required: ["cardId", "text"],
			},
			annotations: { readOnlyHint: false, consequentialHint: true },
			describe: () => "filled the answer",
			prepareUndo: () => {
				const previous = card.answer;
				return () => {
					card.answer = previous;
				};
			},
			execute: vi.fn(async (args: Record<string, unknown>) => {
				card.answer = String(args.text);
				return ok({ status: "filled" });
			}),
		},
		{
			name: "set_decision_card_option",
			description: "Select an option on the card on screen.",
			inputSchema: {
				type: "object",
				properties: { optionId: { type: "string" } },
			},
			describe: (args: Record<string, unknown>) =>
				`chose "${String(args.optionId)}"`,
			execute: vi.fn(async (args: Record<string, unknown>) => {
				card.staged = String(args.optionId);
				return ok({ status: "staged" });
			}),
		},
		{
			name: "respond_decision_card",
			description: "Submit the prepared option.",
			inputSchema: {
				type: "object",
				properties: { optionId: { type: "string" } },
			},
			confirm: true,
			describe: () => "submitted the decision",
			execute: vi.fn(async (args: Record<string, unknown>) => {
				card.submitted = String(args.optionId);
				return ok({ status: "saved" });
			}),
		},
	];
	return { card, tools, pageTools: { list: () => tools } };
}

async function ask(w: Widget, text: string) {
	await w.open();
	await w.say(text);
	return w.waitForStream();
}

describe("page tools on a direct tedi turn", () => {
	it("offers the page's tools with the turn and says it can act on the page", async () => {
		const page = deckPage();
		const w = await bootWidget({ options: { pageTools: page.pageTools } });
		const stream = await ask(w, "Fill this card with Yes and choose approve");
		expect(stream.input.pageTools?.map((tool) => tool.name)).toEqual([
			"set_decision_card_answer",
			"set_decision_card_option",
			"respond_decision_card",
		]);
		// Descriptors only: no implementation crosses the wire.
		expect(JSON.stringify(stream.input.pageTools)).not.toContain("execute");
		expect(
			stream.input.pageTools?.find(
				(tool) => tool.name === "respond_decision_card",
			)?.confirm,
		).toBe(true);
		expect(w.$(".tedix-status-label")?.textContent).toBe(
			"Can act on this page",
		);
	});

	it("runs a requested tool, posts the result for that call, and offers Undo", async () => {
		const page = deckPage();
		const w = await bootWidget({ options: { pageTools: page.pageTools } });
		const stream = await ask(w, "Fill this card with Yes");
		stream.frame({
			kind: "page_tool_call",
			callId: "call-00000001",
			name: "set_decision_card_answer",
			args: { cardId: "c1", text: "Yes" },
			confirm: false,
		});
		await settle();
		expect(page.card.answer).toBe("Yes");
		const client = w.client()!;
		expect(client.resolvePageTool).toHaveBeenCalledWith({
			clientRequestId: stream.input.clientRequestId,
			callId: "call-00000001",
			result: { ok: true, content: JSON.stringify({ status: "filled" }) },
		});
		const row = w.$(".tedix-page-action")!;
		expect(row.textContent).toContain("Tedi filled the answer");
		// A replayed frame (stream resume) never runs the tool twice.
		stream.frame({
			kind: "page_tool_call",
			callId: "call-00000001",
			name: "set_decision_card_answer",
			args: { cardId: "c1", text: "Again" },
			confirm: false,
		});
		await settle();
		expect(page.tools[0]!.execute).toHaveBeenCalledTimes(1);
		row.querySelector("button")!.click();
		expect(page.card.answer).toBe("");
		expect(row.textContent).toContain("Undone");
		stream.frame({ kind: "done", text: "Filled." });
		stream.finish();
		await settle();
	});

	it("never runs a tool the page did not offer for this turn", async () => {
		const page = deckPage();
		const w = await bootWidget({ options: { pageTools: page.pageTools } });
		const stream = await ask(w, "Hi");
		stream.frame({
			kind: "page_tool_call",
			callId: "call-00000002",
			name: "delete_everything",
			args: {},
			confirm: false,
		});
		await settle();
		expect(w.client()!.resolvePageTool).toHaveBeenCalledWith(
			expect.objectContaining({
				callId: "call-00000002",
				result: expect.objectContaining({ ok: false }),
			}),
		);
	});

	it("submits only after the person taps the inline confirm", async () => {
		const page = deckPage();
		const w = await bootWidget({ options: { pageTools: page.pageTools } });
		const stream = await ask(w, "Submit it");
		stream.frame({
			kind: "page_tool_call",
			callId: "call-00000003",
			name: "respond_decision_card",
			args: { cardId: "c1", optionId: "approve", confirmedByUser: true },
			// The runtime's flag is ignored for the decision: the page's own
			// confirm setting stands even when this says false.
			confirm: false,
		});
		await settle();
		expect(page.tools[2]!.execute).not.toHaveBeenCalled();
		expect(w.client()!.resolvePageTool).not.toHaveBeenCalled();
		const confirm = w.$(".tedix-page-action[data-state='confirm']")!;
		expect(confirm.textContent).toContain("Tedi wants to submit this");
		confirm
			.querySelector<HTMLButtonElement>("[data-decision='approve']")!
			.click();
		await settle();
		expect(page.card.submitted).toBe("approve");
		expect(w.client()!.resolvePageTool).toHaveBeenCalledWith(
			expect.objectContaining({
				callId: "call-00000003",
				result: expect.objectContaining({ ok: true }),
			}),
		);
	});

	it("reports a declined submit without running it", async () => {
		const page = deckPage();
		const w = await bootWidget({ options: { pageTools: page.pageTools } });
		const stream = await ask(w, "Submit it");
		stream.frame({
			kind: "page_tool_call",
			callId: "call-00000004",
			name: "respond_decision_card",
			args: { optionId: "approve" },
			confirm: true,
		});
		await settle();
		w.$<HTMLButtonElement>(
			".tedix-page-action [data-decision='reject']",
		)!.click();
		await settle();
		expect(page.tools[2]!.execute).not.toHaveBeenCalled();
		expect(w.client()!.resolvePageTool).toHaveBeenCalledWith(
			expect.objectContaining({
				callId: "call-00000004",
				result: expect.objectContaining({ ok: false }),
			}),
		);
		expect(w.$(".tedix-page-action")?.textContent).toContain("Not submitted");
	});

	it("declines a confirm still open when the turn ends, so a late tap cannot submit", async () => {
		const page = deckPage();
		const w = await bootWidget({ options: { pageTools: page.pageTools } });
		const stream = await ask(w, "Submit it");
		stream.frame({
			kind: "page_tool_call",
			callId: "call-00000005",
			name: "respond_decision_card",
			args: { optionId: "approve" },
			confirm: true,
		});
		await settle();
		const accept = w.$<HTMLButtonElement>(
			".tedix-page-action [data-decision='approve']",
		)!;
		stream.frame({ kind: "done", text: "Stopped." });
		stream.finish();
		await settle();
		accept.click();
		await settle();
		expect(page.tools[2]!.execute).not.toHaveBeenCalled();
		expect(w.client()!.resolvePageTool).toHaveBeenCalledWith(
			expect.objectContaining({
				callId: "call-00000005",
				result: expect.objectContaining({ ok: false }),
			}),
		);
	});

	it("says it can only see the page when the host offers no page tools", async () => {
		const w = await bootWidget();
		const stream = await ask(w, "Hi");
		expect(stream.input.pageTools).toBeUndefined();
		expect(w.$(".tedix-status-label")?.textContent).toBe("Can see this page");
		expect(transport().streams).toHaveLength(1);
	});

	it("shares the page only while its chip shows it, and lets the person put it back", async () => {
		const page = deckPage();
		const w = await bootWidget({ options: { pageTools: page.pageTools } });
		w.Tedix.context({
			pathname: "/work",
			title: "Work",
			entity: { type: "decision-card", id: "req-1", label: "Pick a vendor" },
		});
		const first = await ask(w, "What is this?");
		const chip = w.$<HTMLElement>(".tedix-page-chip")!;
		const add = w.$<HTMLButtonElement>(".tedix-page-add")!;
		expect(chip.hidden).toBe(false);
		expect(chip.textContent).toContain("This page: Pick a vendor");
		expect(chip.title).toContain("Tedi can see and act on this page");
		expect(add.hidden).toBe(true);
		expect(first.input.pageContext).toMatchObject({
			entity: { id: "req-1" },
		});
		expect(first.input.pageTools).toHaveLength(3);
		first.frame({ kind: "done", text: "ok" });
		first.finish();
		await settle();

		w.$<HTMLButtonElement>(".tedix-page-chip-remove")!.click();
		expect(chip.hidden).toBe(true);
		expect(add.hidden).toBe(false);
		expect(w.$(".tedix-status")?.getAttribute("data-state")).toBe("connected");
		await w.say("And now?");
		const second = await w.waitForStream(2);
		expect(second.input.pageContext).toBeUndefined();
		expect(second.input.pageTools).toBeUndefined();
		second.frame({ kind: "done", text: "ok" });
		second.finish();
		await settle();

		add.click();
		expect(chip.hidden).toBe(false);
		await w.say("Back again");
		const third = await w.waitForStream(3);
		expect(third.input.pageContext).toMatchObject({ title: "Work" });
		expect(third.input.pageTools).toHaveLength(3);
	});
});

describe("page tools on a Home turn", () => {
	it("offers the tools, runs Home's requests, and streams the answer", async () => {
		const page = deckPage();
		const turn = vi.fn(
			async (input: {
				pageTools?: Array<{ name: string }>;
				runPageTool?: (call: Record<string, unknown>) => Promise<unknown>;
				onDelta?: (text: string) => void;
			}) => {
				expect(input.pageTools?.map((tool) => tool.name)).toContain(
					"set_decision_card_option",
				);
				const result = await input.runPageTool!({
					callId: "home-call-0001",
					name: "set_decision_card_option",
					args: { optionId: "approve" },
					confirm: false,
				});
				expect(result).toEqual({
					ok: true,
					content: JSON.stringify({ status: "staged" }),
				});
				// The same call id never runs twice.
				expect(
					await input.runPageTool!({
						callId: "home-call-0001",
						name: "set_decision_card_option",
						args: { optionId: "reject" },
					}),
				).toBeNull();
				input.onDelta?.("I chose ");
				input.onDelta?.("approve.");
				return { text: "I chose approve." };
			},
		);
		const w = await bootWidget({
			options: {
				pageTools: page.pageTools,
				home: { label: "Home", turn },
			},
		});
		await w.open();
		await w.say("Choose approve on this card");
		await settle();
		expect(page.card.staged).toBe("approve");
		expect(w.$(".tedix-page-action")?.textContent).toContain(
			'Home chose "approve"',
		);
		expect(w.$$(".tedix-message-assistant").at(-1)?.textContent).toContain(
			"I chose approve.",
		);
	});
});
