// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createStateStore, JSONUIProvider, Renderer } from "@json-render/react";
import { validateSpec, resolvePropValue } from "@json-render/core";
import { tedixCatalog } from "./catalog";
import type { Spec } from "@json-render/core";
import { describe, expect, it, vi } from "vite-plus/test";
import asset from "@tedix/api-contract/assets/attention-app-views.v2.json";
import {
	AttentionDisplayCardSchema,
	type AttentionDisplayCard,
} from "@tedix/api-contract/schemas/attention";
import { tedixRegistry } from "./registry";
import { runToolAction } from "./call-tool-action";

const types = [
	"question",
	"input",
	"handoff",
	"coordination",
	"decision",
	"exception",
	"outcome",
	"adr",
	"tool-write approval",
	"delegation approval",
	"critical approval",
	"Inbox opportunity",
	"Social opportunity",
	"personal FYI",
	"personal proposal",
	"outbound",
	"support",
	"free-text question",
];
function card(kind: string): AttentionDisplayCard {
	const restricted = [
		"handoff",
		"tool-write approval",
		"delegation approval",
		"critical approval",
		"outbound",
		"support",
		"personal FYI",
	].includes(kind);
	return AttentionDisplayCardSchema.parse({
		id: kind,
		kind,
		ask: `Review ${kind}?`,
		context: "Your colleague needs your choice today.",
		confidence: null,
		ifYes: "Records the supplied choice.",
		why: "The source asks for your decision.",
		stakes: "Due today",
		provenance: kind.startsWith("personal")
			? "Instinct · personal agent"
			: "Sample assistant",
		evidenceUrl: "https://example.test/evidence",
		dueAt: "2026-10-20T12:00:00Z",
		source: "https://tedix.os.tedix.dev/work?view=deck#card=sample",
		draft: ["outbound", "support", "Social opportunity"].includes(kind)
			? "Hello\n\nFull draft <script>alert(1)</script>"
			: null,
		recipient: "reader@example.test",
		subject: "Sample draft",
		options: [{ id: "yes", label: "Approve", consequence: "Records approval" }],
		actions: restricted
			? []
			: [
					{
						id: "answer",
						label: "Send answer",
						arguments: {
							decision: { kind: "interaction", decision: { body: "" } },
						},
						textPath: "/cards/0/answer",
						textArgumentPath: "/decision/decision/body",
						statusPath: "/cards/0/status",
					},
				],
		answer: "",
		needsText: !restricted,
		status: null,
	});
}
const deckSpec = asset.views["attention/showDeck"].layoutSpec as Spec;
const feedSpec = asset.views["attention/showFeed"].layoutSpec as Spec;
function view(
	spec: Spec,
	data: Record<string, unknown>,
	call = vi.fn().mockResolvedValue({}),
) {
	const store = createStateStore(data);
	return {
		store,
		node: (
			<JSONUIProvider
				registry={tedixRegistry}
				store={store}
				handlers={{
					call_tool: (params) => runToolAction(params, store, call),
					open_url: vi.fn(),
				}}
			>
				<Renderer spec={spec} registry={tedixRegistry} />
			</JSONUIProvider>
		),
	};
}

describe("versioned attention layout family", () => {
	it.each(Object.values(asset.views))(
		"has a valid structural spec: $layoutId",
		({ layoutSpec }) => {
			expect(validateSpec(layoutSpec as Spec).valid).toBe(true);
		},
	);

	it.each(Object.values(asset.views))(
		"uses typed catalog props: $layoutId",
		({ layoutSpec }) => {
			const fixture = card("question");
			const state = {
				cards: [fixture],
				needsYou: [fixture],
				updates: [],
				notice: "",
				empty: false,
			};
			for (const [key, element] of Object.entries(layoutSpec.elements)) {
				const action = key === "action";
				const props = resolvePropValue(element.props, {
					stateModel: state,
					repeatItem: action ? fixture.actions[0] : fixture,
					repeatBasePath: action ? "/cards/0/actions/0" : "/cards/0",
				});
				const definition =
					tedixCatalog.data.components[
						element.type as keyof typeof tedixCatalog.data.components
					];
				expect(definition.props.safeParse(props), key).toMatchObject({
					success: true,
				});
			}
		},
	);
	it.each(types)("renders %s through the same Deck spec", (kind) => {
		const fixture = card(kind);
		const html = renderToStaticMarkup(
			view(deckSpec, { cards: [fixture], empty: false, notice: "" }).node,
		);
		expect(html).toContain(`Review ${kind}?`);
		expect(html).toContain("If yes");
		expect(html).toContain("Confidence not assessed");
		const rendered = document.createElement("div");
		rendered.innerHTML = html;
		const face = rendered.querySelector("article")!;
		expect(face.querySelector("details")?.hasAttribute("open")).toBe(false);
		for (const detail of face.querySelectorAll("details")) detail.remove();
		expect((face.textContent?.match(/\S+/gu) ?? []).length).toBeLessThanOrEqual(
			60,
		);
		expect(face.textContent).not.toContain("Full draft");
		expect(html).toContain("Evidence");
		if (fixture.draft) {
			expect(html).toContain("Full draft &lt;script&gt;");
			expect(html).not.toContain("<script>");
		}
		if (!fixture.actions.length) expect(html).not.toContain("Send answer");
		expect(html).toMatchSnapshot();
	});
	it("shows what the card asks with Overdue and Drafted, not sent badges", () => {
		const html = renderToStaticMarkup(
			view(deckSpec, {
				cards: [
					{
						...card("outbound"),
						askKind: "send",
						askLabel: "Send",
						overdue: true,
						draftedNotSent: true,
					},
					{ ...card("question"), askKind: "answer", askLabel: "Answer" },
				],
				empty: false,
				notice: "",
			}).node,
		);
		const rendered = document.createElement("div");
		rendered.innerHTML = html;
		const [send, answer] = rendered.querySelectorAll("article");
		expect(send!.textContent).toContain("Send");
		expect(send!.textContent).toContain("Overdue");
		expect(send!.textContent).toContain("Drafted, not sent");
		expect(answer!.textContent).toContain("Answer");
		expect(answer!.textContent).not.toContain("Overdue");
	});
	it("groups Feed needs and updates and preserves provenance", () => {
		const html = renderToStaticMarkup(
			view(feedSpec, {
				needsYou: [card("question")],
				updates: [card("personal FYI")],
				empty: false,
				notice: "Partial inventory",
			}).node,
		);
		expect(html).toContain("Needs you");
		expect(html).toContain("Updates");
		expect(html).toContain("Instinct");
		expect(html).toContain("Partial inventory");
	});
	it("binds a real answer, qualifies the sibling tool, rolls back rejection and retries", async () => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		const call = vi
			.fn()
			.mockRejectedValueOnce(new Error("Stale version"))
			.mockResolvedValueOnce({});
		const fixture = card("question");
		fixture.answer = "Keep the revised draft.";
		const { node, store } = view(
			deckSpec,
			{
				cards: [fixture],
				empty: false,
				notice: "",
				ui: { toolPrefix: "orchard__tedix__" },
			},
			call,
		);
		const rootNode = document.createElement("div");
		document.body.appendChild(rootNode);
		const root = createRoot(rootNode);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await act(async () => root.render(node));
			const button = () =>
				Array.from(rootNode.querySelectorAll("button")).find(
					(b) => b.textContent === "Send answer",
				)!;
			await act(async () =>
				button().dispatchEvent(new MouseEvent("click", { bubbles: true })),
			);

			expect(call).toHaveBeenCalledWith("orchard__tedix__decide_deck_card", {
				decision: {
					kind: "interaction",
					decision: { body: "Keep the revised draft." },
				},
			});
			expect(
				(store.getSnapshot().cards as AttentionDisplayCard[])[0]!.status,
			).toBeNull();
			await act(async () =>
				button().dispatchEvent(new MouseEvent("click", { bubbles: true })),
			);
			expect(rootNode.textContent).toContain("Saved.");
			expect(button().closest("fieldset")?.disabled).toBe(true);
			await act(async () =>
				button().dispatchEvent(new MouseEvent("click", { bubbles: true })),
			);
			expect(call).toHaveBeenCalledTimes(2);
		} finally {
			await act(async () => root.unmount());
			rootNode.remove();
			errors.mockRestore();
		}
	});
	it("blocks empty input and duplicate calls while pending, then rolls back protocol errors", async () => {
		const fixture = card("question");
		const store = createStateStore({ cards: [fixture] });
		const call = vi.fn();
		const params = { ...fixture.actions[0], tool: "decide_deck_card" };
		await expect(runToolAction(params, store, call)).rejects.toThrow(
			"Write your answer",
		);
		expect(call).not.toHaveBeenCalled();
		store.set("/cards/0/answer", "A real answer");
		let resolve!: (value: unknown) => void;
		call.mockReturnValueOnce(
			new Promise((r) => {
				resolve = r;
			}),
		);
		const pending = runToolAction(params, store, call);
		await runToolAction(params, store, call);
		expect(call).toHaveBeenCalledTimes(1);
		resolve({ isError: true });
		await expect(pending).rejects.toThrow("could not be saved");
		expect(
			(store.getSnapshot().cards as AttentionDisplayCard[])[0]!.status,
		).toBeNull();
	});
});
