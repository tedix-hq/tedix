import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { ActivityFeedItemSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { FocusDecisionRow } from "./focus-feed";

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
