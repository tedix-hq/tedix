// @vitest-environment happy-dom
/**
 * Conversations in the embed runtime: the home, history, restoring a thread
 * after a reload, switching, deleting, and what survives in sessionStorage.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import esCatalog from "@tedix/widget-i18n/es.json";
import {
	ACTIVE_THREAD_KEY,
	bootWidget,
	sessionResult,
	settle,
	teardown,
	THREADS_KEY,
	tick,
	transport,
	uuid,
	type Widget,
} from "./runtime-harness";

vi.mock("@tedix/chat-transport/embedded-client", async () => ({
	createEmbeddedClient: (await import("./runtime-harness"))
		.createFakeEmbeddedClient,
}));

afterEach(() => {
	teardown();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const ONE = uuid(1);
const TWO = uuid(2);

/** Two previous conversations remembered by reference only. */
const remembered =
	(ids = [ONE, TWO]) =>
	() =>
		sessionStorage.setItem(THREADS_KEY, JSON.stringify(ids));

/** Two previous conversations the host's history names. */
const previous = vi.fn(async () => [
	{
		id: ONE,
		title: "First chat",
		updatedAt: new Date(Date.now() - 60_000).toISOString(),
	},
	{
		id: TWO,
		title: "Second chat",
		updatedAt: new Date(Date.now() - 120_000).toISOString(),
	},
]);

async function openHistory(w: Widget) {
	w.$<HTMLButtonElement>(".tedix-history-open")!.click();
	await settle();
}

const historyRow = (w: Widget, title: string) => {
	const row = w
		.$$<HTMLButtonElement>(".tedix-history-item")
		.find((item) => item.querySelector("span")?.textContent === title);
	if (!row) throw new Error(`no history row titled ${title}`);
	return row;
};

const skeletons = (w: Widget) => w.$$(".tedix-thread .tedix-skeleton");

async function finishTurn(w: Widget, count: number, text: string) {
	const stream = await w.waitForStream(count);
	stream.frame({ kind: "done", text });
	stream.finish();
	await settle();
}

describe("the home", () => {
	it("is conversational: a welcome, suggested prompts, and recent chats, with no automatic tool calls", async () => {
		const portableTool = vi.fn();
		const w = await bootWidget({
			options: {
				product: "Acme",
				conversationStarters: ["Explain this page"],
				portableTool,
			},
		});
		await w.open();
		const home = w.$(".tedix-empty")!;
		expect(home.querySelector("h2")?.textContent).toBe(
			"How can I help you in Acme?",
		);
		const prompts = w.$('.tedix-prompts[role="group"]')!;
		expect(prompts.getAttribute("aria-label")).toBe("Suggested prompts");
		expect(
			w
				.$$<HTMLButtonElement>(".tedix-prompt")
				.map((b) => b.type + ":" + b.textContent),
		).toEqual(["button:Explain this page"]);
		expect(w.$(".tedix-recent")).not.toBeNull();
		expect(portableTool).not.toHaveBeenCalled();
		expect(w.client()?.callPortableTool).not.toHaveBeenCalled();
		expect(transport().streams).toHaveLength(0);
	});

	it("sends a suggested prompt only when it is chosen", async () => {
		const w = await bootWidget({
			options: { conversationStarters: ["  Explain this page  "] },
		});
		await w.open();
		expect(transport().streams).toHaveLength(0);
		w.$<HTMLButtonElement>(".tedix-prompt")!.click();
		const stream = await w.waitForStream();
		expect(stream.input.text).toBe("Explain this page");
	});

	it("uses locale translations for bounded starters and catalog fallbacks for an empty list", async () => {
		const starters = async (translations: unknown, extra = {}) => {
			const w = await bootWidget({
				options: {
					locale: "de-AT",
					translations,
					conversationStarters: ["Base-language prompt"],
					...extra,
				},
			});
			return w.$$(".tedix-prompt").map((node) => node.textContent);
		};
		expect(
			await starters({ "DE-de": { conversationStarters: ["Was ist offen?"] } }),
		).toEqual(["Was ist offen?"]);
		expect(await starters({ de: { conversationStarters: [] } })).toHaveLength(
			3,
		);
		expect(await starters({})).toEqual(["Base-language prompt"]);
		expect(
			await starters(
				{},
				{ conversationStarters: undefined, prompts: ["Legacy prompt"] },
			),
		).toEqual(["Legacy prompt"]);
		expect(
			await starters({
				de: { conversationStarters: Array(8).fill("x".repeat(300)) },
			}),
		).toEqual(Array(6).fill("x".repeat(240)));
	});

	it.each([
		[
			"en-US",
			[
				"What needs attention today?",
				"Summarize my recent activity",
				"Explain this page",
			],
		],
		[
			"es-MX",
			[
				"¿Qué necesita atención hoy?",
				"Resume mi actividad reciente",
				"Explícame esta pantalla",
			],
		],
	])(
		"offers generic %s suggestions regardless of the host path",
		async (locale, expected) => {
			const w = await bootWidget({
				before: () => history.replaceState(null, "", "/orders/42/invoices"),
				// The published catalog for the locale arrives with the branding.
				options: {
					locale,
					product: "Provider",
					...(locale === "es-MX" ? { catalog: esCatalog } : {}),
				},
			});
			history.replaceState(null, "", "/");
			expect(w.$$(".tedix-prompt").map((node) => node.textContent)).toEqual(
				expected,
			);
			expect(w.$(".tedix-context strong")?.textContent).toBe("Provider");
		},
	);

	it("lists the three newest other sessions as recent chats and opens history from there", async () => {
		const history = vi.fn(async () =>
			[1, 2, 3, 4].map((n) => ({
				id: uuid(n),
				title: `Chat ${n}`,
				updatedAt: new Date(Date.now() - n * 60_000).toISOString(),
			})),
		);
		const w = await bootWidget({ options: { history } });
		await w.open();
		const recent = w.$$<HTMLButtonElement>(".tedix-recent-item");
		expect(recent.map((row) => row.querySelector("span")?.textContent)).toEqual(
			["Chat 1", "Chat 2", "Chat 3"],
		);
		expect(recent[0]!.parentElement?.getAttribute("role")).toBe("listitem");
		expect(w.$(".tedix-recent")!.hidden).toBe(false);
		w.$<HTMLButtonElement>(".tedix-recent-more")!.click();
		await settle();
		expect(w.$(".tedix-history")!.hidden).toBe(false);
	});
});

describe("history", () => {
	it("keeps rows as native buttons inside list items, newest first, and activates the chosen one", async () => {
		const history = vi.fn(async () => [
			{
				id: TWO,
				title: "Older",
				updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
			},
			{ id: ONE, title: "Newest", updatedAt: new Date().toISOString() },
		]);
		const transcript = vi.fn(async () => [{ role: "user", content: "Newest" }]);
		const w = await bootWidget({ options: { history, transcript } });
		await w.open();
		await openHistory(w);
		const panel = w.$(".tedix-panel")!;
		expect(panel.hasAttribute("data-history")).toBe(true);
		expect(w.$(".tedix-composer-wrap")!.hidden).toBe(true);
		const rows = w.$$<HTMLButtonElement>(".tedix-history-item");
		expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual([
			"Newest",
			"New conversation",
			"Older",
		]);
		expect(rows.map((row) => row.querySelector("time")?.textContent)).toEqual([
			"Today",
			"Today",
			"Yesterday",
		]);
		for (const row of rows) {
			expect(row.type).toBe("button");
			expect(row.hasAttribute("role")).toBe(false);
			expect(row.parentElement?.getAttribute("role")).toBe("listitem");
		}
		expect(rows.map((row) => row.dataset.active)).toEqual([
			"false",
			"true",
			"false",
		]);
		rows[0]!.click();
		await settle();
		expect(transcript).toHaveBeenCalledWith({ conversationId: ONE });
		expect(panel.hasAttribute("data-history")).toBe(false);
		expect(w.messages()).toEqual([["user", "Newest"]]);
	});

	it("asks the host for a bounded page once, coalescing and caching the read", async () => {
		let release!: () => void;
		const history = vi.fn(
			() =>
				new Promise<unknown[]>((resolve) => {
					release = () => resolve([]);
				}),
		);
		const w = await bootWidget({ options: { history } });
		await w.open();
		await openHistory(w);
		// Placeholders fill the list while the host answers; never a blank panel.
		expect(w.$$(".tedix-history-list .tedix-skeleton")).toHaveLength(4);
		expect(w.$(".tedix-history-list")!.getAttribute("aria-busy")).toBe("true");
		w.$<HTMLButtonElement>(".tedix-history-back")!.click();
		await openHistory(w);
		expect(history).toHaveBeenCalledTimes(1);
		expect(history).toHaveBeenCalledWith({ limit: 12 });
		release();
		await settle();
		expect(w.$$(".tedix-history-list .tedix-skeleton")).toHaveLength(0);
		expect(w.$$(".tedix-history-item")).toHaveLength(1);
		await openHistory(w);
		expect(history).toHaveBeenCalledTimes(1);
		// The home's recent list waits with placeholders too, then fills.
		w.$<HTMLButtonElement>(".tedix-history-new")!.click();
		expect(w.$$(".tedix-recent-list .tedix-skeleton")).toHaveLength(2);
		await settle();
		expect(w.$$(".tedix-recent-list .tedix-skeleton")).toHaveLength(0);
	});

	it("persists only bounded UUID references, never titles or transcript bodies", async () => {
		const ids = Array.from({ length: 15 }, (_, n) => uuid(n + 10));
		const history = vi.fn(async () =>
			ids.map((id, n) => ({
				id,
				title: "PRIVATE",
				updatedAt: new Date(Date.now() - n * 1000).toISOString(),
			})),
		);
		const w = await bootWidget({ options: { history } });
		await w.open();
		await w.say("SECRET question");
		await finishTurn(w, 1, "SECRET answer");
		const stored = JSON.parse(sessionStorage.getItem(THREADS_KEY)!);
		expect(stored).toHaveLength(12);
		expect(stored.every((id: string) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
		expect(stored[0]).toBe(sessionStorage.getItem(ACTIVE_THREAD_KEY));
		expect(Object.values(sessionStorage).join()).not.toMatch(/PRIVATE|SECRET/);
	});

	it("reads back only well-formed, unique references", async () => {
		const w = await bootWidget({
			before: () =>
				sessionStorage.setItem(
					THREADS_KEY,
					JSON.stringify([
						ONE,
						ONE,
						{ id: TWO, title: "PRIVATE" },
						"not-a-uuid",
					]),
				),
		});
		await w.open();
		await openHistory(w);
		expect(
			w
				.$$(".tedix-history-item")
				.map((row) => row.querySelector("span")?.textContent)
				.sort(),
		).toEqual(["New conversation", "Previous conversation"]);
	});

	it("drops the pre-v2 storage keys at mount", async () => {
		await bootWidget({
			before: () => {
				sessionStorage.setItem("tedix:threads:demo-shop", '[{"title":"old"}]');
				sessionStorage.setItem("tedix:thread:demo-shop", "old");
			},
		});
		expect(sessionStorage.getItem("tedix:threads:demo-shop")).toBeNull();
		expect(sessionStorage.getItem("tedix:thread:demo-shop")).toBeNull();
	});

	it("titles a new conversation from its first message", async () => {
		const w = await bootWidget();
		await w.open();
		const question = `${"Where is order 42? ".repeat(6)}`;
		await w.say(question);
		await finishTurn(w, 1, "Shipped");
		await openHistory(w);
		expect(w.$(".tedix-history-item span")?.textContent).toBe(
			question.trim().slice(0, 72),
		);
	});

	it("keeps at most twelve conversations in memory", async () => {
		const w = await bootWidget();
		await w.open();
		for (let n = 0; n < 13; n += 1)
			w.$<HTMLButtonElement>(".tedix-new")!.click();
		await openHistory(w);
		expect(w.$$(".tedix-history-item")).toHaveLength(12);
	});
});

describe("restoring a conversation", () => {
	it("hydrates a reload reference through its own fresh signed session without resending messages", async () => {
		const w = await bootWidget({
			before: () => {
				remembered()();
				sessionStorage.setItem(ACTIVE_THREAD_KEY, ONE);
			},
		});
		transport().readTranscript.mockResolvedValue({
			messages: [
				{ role: "user", content: "Explain my page" },
				{ role: "assistant", content: "Your queue" },
			],
		});
		await w.open();
		expect(w.session).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: ONE }),
		);
		expect(transport().readTranscript).toHaveBeenCalledTimes(1);
		expect(w.messages()).toEqual([
			["user", "Explain my page"],
			["assistant", "Your queue"],
		]);
		expect(skeletons(w)).toHaveLength(0);
		expect(w.input().disabled).toBe(false);
		const reader = transport().clients.find(
			(client) => client.readTranscript.mock.calls.length,
		)!;
		expect(reader.dispose).toHaveBeenCalledOnce();
		expect(transport().streams).toHaveLength(0);
		await openHistory(w);
		historyRow(w, "Explain my page").click();
		await settle();
		expect(transport().readTranscript).toHaveBeenCalledTimes(1);
	});

	it("shows placeholder bubbles while it loads and replaces them with the transcript", async () => {
		let release!: (value: unknown) => void;
		const transcript = vi.fn(
			() => new Promise((resolve) => (release = resolve)),
		);
		const w = await bootWidget({
			options: { history: previous, transcript },
		});
		await w.open();
		await openHistory(w);
		historyRow(w, "First chat").click();
		await tick(0);
		expect(skeletons(w).map((node) => node.dataset.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		expect(w.thread().getAttribute("aria-busy")).toBe("true");
		expect(w.input().disabled).toBe(true);
		release([{ role: "user", content: "Restored" }]);
		await settle();
		expect(skeletons(w)).toHaveLength(0);
		expect(w.messages()).toEqual([["user", "Restored"]]);
		expect(w.thread().hasAttribute("aria-busy")).toBe(false);
	});

	it.each(["rejected", "empty"])(
		"blocks continuation after %s history and offers an explicit new conversation",
		async (kind) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const w = await bootWidget({ options: { history: previous } });
			transport().readTranscript.mockImplementation(async () => {
				if (kind === "rejected")
					throw Object.assign(new Error("Denied"), { code: "forbidden" });
				return { messages: [] };
			});
			await w.open();
			await openHistory(w);
			historyRow(w, "First chat").click();
			await settle();
			expect(skeletons(w)).toHaveLength(0);
			expect(w.thread().hasAttribute("aria-busy")).toBe(false);
			expect(w.input().disabled).toBe(true);
			expect(w.send().disabled).toBe(true);
			expect(w.$('.tedix-empty[role="alert"]')?.textContent).toContain(
				"I couldn't load this conversation.",
			);
			expect(error).toHaveBeenCalledWith(
				kind === "rejected"
					? `[tedix widget] conversation ${ONE}: transcript restore failed (forbidden): Denied`
					: `[tedix widget] conversation ${ONE}: transcript restore failed (restore_failed): Conversation unavailable`,
			);
			await expect(w.Tedix.ask("Continue")).rejects.toMatchObject({
				code: "conversation_unavailable",
			});
			const restart = w
				.$$<HTMLButtonElement>('.tedix-empty[role="alert"] button')
				.find((button) => button.textContent === "New conversation")!;
			restart.click();
			await settle();
			expect(w.input().disabled).toBe(false);
			expect(w.$(".tedix-prompts")).not.toBeNull();
		},
	);

	it("keeps a failed reference retryable and hydrates it exactly once after recovery", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const w = await bootWidget({ options: { history: previous } });
		transport()
			.readTranscript.mockRejectedValueOnce(new Error("Offline"))
			.mockResolvedValueOnce({
				messages: [{ role: "user", content: "Recovered" }],
			});
		await w.open();
		await openHistory(w);
		historyRow(w, "First chat").click();
		await settle();
		w.$$<HTMLButtonElement>('.tedix-empty[role="alert"] button')
			.find((button) => button.textContent === "Try again")!
			.click();
		await settle();
		expect(w.messages()).toEqual([["user", "Recovered"]]);
		expect(w.input().disabled).toBe(false);
		await openHistory(w);
		historyRow(w, "Recovered").click();
		await settle();
		expect(transport().readTranscript).toHaveBeenCalledTimes(2);
	});

	it("bounds the restore: a transcript that never settles gives way to the recovery state", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const w = await bootWidget({
			options: {
				history: previous,
				transcript: vi.fn(() => new Promise(() => {})),
			},
		});
		await w.open();
		await openHistory(w);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		historyRow(w, "First chat").click();
		await vi.advanceTimersByTimeAsync(19_999);
		expect(skeletons(w)).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(skeletons(w)).toHaveLength(0);
		expect(w.$('.tedix-empty[role="alert"]')).not.toBeNull();
		expect(error).toHaveBeenCalledWith(
			`[tedix widget] conversation ${ONE}: transcript restore failed (transcript_timeout): Transcript restore exceeded 20000ms`,
		);
	});

	it("clears the bound once a restore settles", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const w = await bootWidget({
			options: {
				history: previous,
				transcript: vi.fn(async () => [{ role: "user", content: "Fast" }]),
			},
		});
		await w.open();
		await openHistory(w);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		historyRow(w, "First chat").click();
		await vi.advanceTimersByTimeAsync(25_000);
		expect(w.messages()).toEqual([["user", "Fast"]]);
		expect(error).not.toHaveBeenCalled();
	});

	it("does not strand placeholders or render a stale transcript when a newer conversation takes the thread", async () => {
		let release!: (value: unknown) => void;
		const w = await bootWidget({
			options: {
				history: previous,
				transcript: vi.fn(() => new Promise((resolve) => (release = resolve))),
			},
		});
		await w.open();
		await openHistory(w);
		historyRow(w, "First chat").click();
		await tick(0);
		expect(skeletons(w)).toHaveLength(3);
		w.$<HTMLButtonElement>(".tedix-new")!.click();
		release([{ role: "user", content: "Stale" }]);
		await settle();
		expect(w.messages()).toEqual([]);
		expect(skeletons(w)).toHaveLength(0);
		expect(w.$(".tedix-prompts")).not.toBeNull();
	});

	it("ignores stale transcript results when the customer switches conversations during hydration", async () => {
		const reads = new Map<string, (value: unknown) => void>();
		const transcript = vi.fn(
			({ conversationId }: { conversationId: string }) =>
				conversationId === ONE
					? new Promise((resolve) => reads.set(ONE, resolve))
					: Promise.resolve([{ role: "user", content: "Second" }]),
		);
		const w = await bootWidget({ options: { history: previous, transcript } });
		await w.open();
		await openHistory(w);
		historyRow(w, "First chat").click();
		await tick(0);
		await openHistory(w);
		historyRow(w, "Second chat").click();
		await settle();
		reads.get(ONE)?.([{ role: "user", content: "Stale private content" }]);
		await settle();
		expect(w.messages()).toEqual([["user", "Second"]]);
		expect(w.input().disabled).toBe(false);
	});

	it("retains a host transcript's metadata without using the default runtime", async () => {
		const transcript = vi.fn(async () => [
			{
				role: "assistant",
				content: "Host answer",
				metadata: {
					_meta: {
						ui: { resourceUri: "ui://widgets/mcp-app/shop/r/orders.html" },
					},
				},
			},
		]);
		const w = await bootWidget({ options: { history: previous, transcript } });
		await w.open();
		await openHistory(w);
		historyRow(w, "First chat").click();
		await settle();
		expect(transcript).toHaveBeenCalledWith({ conversationId: ONE });
		expect(transport().readTranscript).not.toHaveBeenCalled();
		expect(w.messages()).toEqual([["assistant", "Host answer"]]);
		expect(w.$(".tedix-message-assistant iframe")).not.toBeNull();
	});

	it("waits out a restore in flight instead of refusing the ask", async () => {
		let release!: (value: unknown) => void;
		const w = await bootWidget({
			before: () => {
				remembered()();
				sessionStorage.setItem(ACTIVE_THREAD_KEY, ONE);
			},
			options: {
				transcript: vi.fn(() => new Promise((resolve) => (release = resolve))),
			},
		});
		w.$<HTMLButtonElement>(".tedix-launcher")!.click();
		await tick(0);
		const answer = w.Tedix.ask("Follow up");
		await settle();
		expect(transport().streams).toHaveLength(0);
		release([{ role: "user", content: "Earlier" }]);
		const stream = await w.waitForStream();
		expect(stream.input.text).toBe("Follow up");
		stream.frame({ kind: "done", text: "Answered" });
		stream.finish();
		await expect(answer).resolves.toBe("Answered");
		expect(w.messages().map(([, text]) => text)).toEqual([
			"Earlier",
			"Follow up",
			"Answered",
		]);
	});

	it("refuses a send while the conversation is still loading instead of dropping it silently", async () => {
		const w = await bootWidget({
			options: {
				history: previous,
				transcript: vi.fn(() => new Promise(() => {})),
			},
		});
		await w.open();
		await openHistory(w);
		historyRow(w, "First chat").click();
		await tick(0);
		w.type("Too early");
		w.submitForm();
		await settle();
		expect(transport().streams).toHaveLength(0);
		expect(w.$$(".tedix-message-assistant")).toHaveLength(1);
	});
});

describe("deleting a conversation", () => {
	it("re-persists so a removed thread cannot come back, and clears the active pointer", async () => {
		const deleteConversation = vi.fn(async () => ({ ok: true }));
		const w = await bootWidget({
			before: () => {
				remembered()();
				sessionStorage.setItem(ACTIVE_THREAD_KEY, TWO);
			},
			options: {
				deleteConversation,
				transcript: vi.fn(async () => [{ role: "user", content: "Kept" }]),
			},
		});
		await w.open();
		await w.Tedix.deleteConversation(ONE);
		expect(deleteConversation).toHaveBeenCalledWith({ conversationId: ONE });
		expect(JSON.parse(sessionStorage.getItem(THREADS_KEY)!)).toEqual([TWO]);
		await w.Tedix.deleteConversation(TWO);
		expect(JSON.parse(sessionStorage.getItem(THREADS_KEY)!)).toEqual([]);
		expect(sessionStorage.getItem(ACTIVE_THREAD_KEY)).toBeNull();
		expect(
			w.detailsOf("conversationDeleted").map((d) => d.conversationId),
		).toEqual([ONE, TWO]);
	});

	it("is refused without a host provider or during a turn", async () => {
		const w = await bootWidget();
		await expect(w.Tedix.deleteConversation(ONE)).rejects.toThrow(
			"Conversation deletion is not configured by this host",
		);
	});
});

describe("tedi selection", () => {
	it("pins session renewal to the conversation's worker and rejects an ignored selection", async () => {
		const selection = (selectedTediId: string) =>
			// Short-lived, so every turn renews the signed session.
			sessionResult({
				expiresAt: Date.now() + 10_000,
				tediSelection: {
					selectedTediId,
					tedis: [
						{ id: "worker-a", name: "A" },
						{ id: "worker-b", name: "B" },
					],
				},
			});
		const session = vi.fn(async (_request: Record<string, unknown>) =>
			selection("worker-a"),
		);
		const w = await bootWidget({ options: { session } });
		await w.open();
		const select = w.$<HTMLSelectElement>(".tedix-tedi-select")!;
		expect(select.hidden).toBe(false);
		expect([...select.options].map((option) => option.textContent)).toEqual([
			"A",
			"B",
		]);
		await w.say("Hello");
		await finishTurn(w, 1, "Hi");
		await w.say("Again");
		await finishTurn(w, 2, "Hi again");
		expect(session).toHaveBeenLastCalledWith(
			expect.objectContaining({ selectedTediId: "worker-a" }),
		);
		// A renewal that comes back bound to a different worker is refused.
		session.mockResolvedValueOnce(selection("worker-b"));
		await w.say("Third");
		await settle();
		expect(transport().streams).toHaveLength(2);
		expect(w.$$(".tedix-message-assistant").at(-1)?.textContent).toBeTruthy();
		expect(select.value).toBe("worker-a");

		// Switching workers starts a new conversation bound to the choice; a
		// session that ignores the choice surfaces a recovery message.
		session.mockResolvedValueOnce(selection("worker-a"));
		select.value = "worker-b";
		select.dispatchEvent(new Event("change"));
		await settle();
		expect(session).toHaveBeenLastCalledWith(
			expect.objectContaining({ selectedTediId: "worker-b" }),
		);
		expect(w.$(".tedix-session-recovery span")?.textContent).toBe(
			"Could not switch tedi. Try again.",
		);
		expect(w.$(".tedix-session-recovery")!.hidden).toBe(false);
	});
});

describe("a host-owned workspace conversation", () => {
	it("hands the continuation to the host with an idempotency key instead of streaming", async () => {
		const continueConversation = vi.fn(async () => ({
			kind: "handoff",
			url: "/workspaces/w-1/chat",
		}));
		const w = await bootWidget({
			options: {
				continueConversation,
				history: vi.fn(async () => [
					{
						id: ONE,
						title: "Workspace chat",
						workspaceId: "w-1",
						updatedAt: new Date().toISOString(),
					},
				]),
				transcript: vi.fn(async () => [{ role: "user", content: "Before" }]),
			},
		});
		await w.open();
		await openHistory(w);
		historyRow(w, "Workspace chat").click();
		await settle();
		await w.say("Keep going");
		await settle();
		expect(continueConversation).toHaveBeenCalledWith({
			conversationId: ONE,
			idempotencyKey: expect.stringMatching(
				new RegExp(`^widget:${ONE}:[0-9a-f-]{36}$`),
			),
			text: "Keep going",
			workspaceId: "w-1",
		});
		expect(location.pathname).toBe("/workspaces/w-1/chat");
		expect(transport().streams).toHaveLength(0);
		history.replaceState(null, "", "/");
	});
});
