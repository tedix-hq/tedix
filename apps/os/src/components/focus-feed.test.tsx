import { act, useRef } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { ActivityFeedItemSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { FocusDecisionRow, useFocusFeedShortcuts } from "./focus-feed";

vi.mock("@/lib/api", () => ({
	osApi: {
		attention: {
			getDeckCard: vi.fn().mockResolvedValue({ presentation: null }),
		},
	},
}));
vi.mock("@/lib/webmcp/use-app-webmcp-tools", () => ({
	useAppWebMcpTools: vi.fn(),
}));

it("bounds the fallback and discloses the unchanged source, including repeated paragraphs", async () => {
	const sentence =
		"Confirm who staffs the booth? " + "Check the staffing plan. ".repeat(30);
	const explanation =
		"The request is pending. ".repeat(100) + "Exact final source line.";
	const item = {
		...ActivityFeedItemSchema.parse({
			id: "decision:fictional-booth",
			actor: "Cedar",
			sentence,
			explanation,
			source: "/work/interactions/fictional-booth",
			projectId: null,
			workItemId: null,
			tediId: null,
			kind: "decision",
			classId: "event.booth",
			importance: "high",
			at: "2026-10-17T12:00:00Z",
			dueAt: null,
			needsAction: true,
			stalled: false,
			done: false,
			reactions: [],
		}),
		score: 1,
		unseen: true,
		deadline: false,
		factors: {},
	};
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<FocusDecisionRow item={item} actor="Cedar" />
				</QueryClientProvider>,
			),
		);
		expect(
			host.querySelector(".focus-story")!.textContent!.length,
		).toBeLessThanOrEqual(160);
		expect(host.querySelector(".focus-story")!.textContent).toContain(
			"Confirm who staffs the booth?",
		);
		expect(
			host.querySelector(".focus-face-fallback")!.textContent!.length,
		).toBeLessThanOrEqual(280);
		expect(host.textContent).not.toContain("Exact final source line.");
		const details = [...host.querySelectorAll("button")].find(
			(b) => b.textContent === "Details",
		)!;
		await act(async () => details.click());
		expect(
			[...host.querySelectorAll(".focus-source-text")].map(
				(n) => n.textContent,
			),
		).toEqual([sentence, explanation]);
		expect(
			[...host.querySelectorAll("a")]
				.find((a) => a.textContent === "Original request")
				?.getAttribute("href"),
		).toBe(item.source);
	} finally {
		await act(async () => root.unmount());
		host.remove();
		client.clear();
	}
});

it.each(["If yes: If yes,", "If yes: If yes:"])(
	"shows the generated consequence prefix once: %s",
	async (prefix) => {
		const item = {
			...ActivityFeedItemSchema.parse({
				id: "decision:fictional-booth",
				actor: "Cedar",
				sentence: "Staff the booth?",
				explanation: "Source request",
				source: "/work/interactions/fictional-booth",
				projectId: null,
				workItemId: null,
				tediId: null,
				kind: "decision",
				classId: "event.booth",
				importance: "high",
				at: "2026-10-17T12:00:00Z",
				dueAt: null,
				needsAction: true,
				stalled: false,
				done: false,
				reactions: [],
				presentation: {
					version: 2,
					title: "Staff the booth?",
					context: "The booth needs a host.",
					body: "If yes, your answer is saved.",
					recommendation: "Check availability first.",
				},
				faceText: `Staff the booth?\nThe booth needs a host.\n${prefix} your answer is saved.`,
			}),
			score: 1,
			unseen: true,
			deadline: false,
			factors: {},
		};
		const client = new QueryClient();
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<FocusDecisionRow item={item} actor="Cedar" />
					</QueryClientProvider>,
				),
			);
			expect(host.querySelector(".fd-face-enter")!.textContent).toBe(
				"The booth needs a host.\nIf yes: your answer is saved.",
			);
		} finally {
			await act(async () => root.unmount());
			host.remove();
			client.clear();
		}
	},
);

it("keeps shortcuts with their focused interaction and invokes each owned action once", async () => {
	const action = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	function Fixture() {
		const feed = useRef<HTMLDivElement>(null);
		useFocusFeedShortcuts(feed);
		return (
			<>
				<button data-shell>Shell</button>
				<div ref={feed} tabIndex={0} data-feed>
					<button>Feed filter</button>
					{["first", "second"].map((id) => (
						<div key={id} data-focus-row={id} tabIndex={-1}>
							<a
								href="#source"
								onClick={(e) => {
									e.preventDefault();
									action(id, "open");
								}}
							>
								Source
							</a>
							{["Pin", "Hide", "Not important"].map((name) => (
								<button
									key={name}
									aria-label={name}
									onClick={() => action(id, name)}
								>
									{name}
								</button>
							))}
							<input aria-label="Edit" />
							<div contentEditable suppressContentEditableWarning tabIndex={0}>
								Draft
							</div>
							<div role="listbox" tabIndex={0}>
								<div role="option" aria-selected={false}>
									Option
								</div>
							</div>
						</div>
					))}
					{createPortal(
						<div role="dialog" tabIndex={-1}>
							<button>Dialog control</button>
						</div>,
						document.body,
					)}
					{createPortal(
						<div role="menu">
							<div role="menuitem" tabIndex={0}>
								Pin
							</div>
						</div>,
						document.body,
					)}
				</div>
			</>
		);
	}
	const press = async (key: string, init: KeyboardEventInit = {}) => {
		const event = new KeyboardEvent("keydown", {
			key,
			bubbles: true,
			cancelable: true,
			...init,
		});
		await act(async () => {
			document.activeElement!.dispatchEvent(event);
		});
		return event.defaultPrevented;
	};
	try {
		await act(async () => root.render(<Fixture />));
		const feed = host.querySelector<HTMLElement>("[data-feed]")!;
		const rows = [...host.querySelectorAll<HTMLElement>("[data-focus-row]")];
		const foreign = [
			host.querySelector<HTMLElement>("[data-shell]")!,
			feed.querySelector<HTMLElement>("button")!,
			...rows[0]!.querySelectorAll<HTMLElement>(
				"a,button,input,[contenteditable],[role=listbox]",
			),
			document.querySelector<HTMLElement>("[role=dialog]")!,
			document.querySelector<HTMLElement>("[role=dialog] button")!,
			document.querySelector<HTMLElement>("[role=menuitem]")!,
		];
		for (const control of foreign) {
			control.focus();
			for (const key of ["j", "k", "o", "p", "h", "n"]) {
				expect(await press(key)).toBe(false);
				expect(document.activeElement).toBe(control);
			}
		}
		expect(action).not.toHaveBeenCalled();
		feed.focus();
		for (const key of ["o", "p", "h", "n"])
			expect(await press(key)).toBe(false);
		expect(action).not.toHaveBeenCalled();
		expect(await press("j")).toBe(true);
		expect(document.activeElement).toBe(rows[0]);
		await press("j");
		expect(document.activeElement).toBe(rows[1]);
		await press("k");
		expect(document.activeElement).toBe(rows[0]);
		for (const [key, name] of [
			["o", "open"],
			["p", "Pin"],
			["h", "Hide"],
			["n", "Not important"],
		]) {
			action.mockClear();
			expect(await press(key!)).toBe(true);
			expect(action.mock.calls).toEqual([["first", name]]);
			await press(key!, { repeat: true });
			expect(action).toHaveBeenCalledTimes(1);
		}
		for (const init of [
			{ ctrlKey: true },
			{ altKey: true },
			{ metaKey: true },
			{ shiftKey: true },
			{ isComposing: true },
		]) {
			expect(await press("p", init)).toBe(false);
		}
		const consumed = (event: KeyboardEvent) => event.preventDefault();
		rows[0]!.addEventListener("keydown", consumed);
		action.mockClear();
		await press("p");
		expect(action).not.toHaveBeenCalled();
		rows[0]!.removeEventListener("keydown", consumed);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});
