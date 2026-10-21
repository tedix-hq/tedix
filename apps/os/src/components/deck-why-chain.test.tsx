import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DeckWhyChain } from "./deck-why-chain";
import { osQuery } from "@/lib/os-query-options";
import {
	GITHUB_CARD_ID,
	GITHUB_DECISION_CONTEXT,
	decisionGraphFixture,
} from "../../dev/decision-graph-fixture";

const { getContext } = vi.hoisted(() => ({ getContext: vi.fn() }));
vi.mock("@/lib/api", () => ({ osApi: { decisionGraph: { getContext } } }));

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;
afterEach(async () => {
	await act(async () => root?.unmount());
	client?.clear();
	host?.remove();
	vi.resetAllMocks();
});

async function mount(cardId = GITHUB_CARD_ID) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<DeckWhyChain cardId={cardId} />
			</QueryClientProvider>,
		),
	);
}

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

it("uses the generated card query and expands the server's explanation into record links", async () => {
	getContext.mockResolvedValue(GITHUB_DECISION_CONTEXT);
	await mount();
	await settle();
	expect(getContext.mock.calls[0]?.[0]).toEqual({
		cardId: GITHUB_CARD_ID,
		maxHops: 4,
	});
	expect(
		client.getQueryData(
			osQuery.decisionGraph.getContext.queryOptions({
				input: { cardId: GITHUB_CARD_ID, maxHops: 4 },
			}).queryKey,
		),
	).toEqual(GITHUB_DECISION_CONTEXT);
	const trigger = host.querySelector("button")!;
	expect(trigger.textContent).toBe(GITHUB_DECISION_CONTEXT.explanation);
	expect(trigger.getAttribute("aria-expanded")).toBe("false");
	expect(host.querySelector("ol")).toBeNull();
	await act(async () => trigger.click());
	expect(trigger.getAttribute("aria-expanded")).toBe("true");
	const links = [...host.querySelectorAll("ol a")];
	expect(links).toHaveLength(5);
	expect(links.map((link) => link.getAttribute("href"))).toEqual([
		"/work/items/d5000000-0000-4000-8000-000000000002",
		"/work/items/d5000000-0000-4000-8000-000000000002",
		"/outputs/d5000000-0000-4000-8000-000000000003",
		`/work/interactions/${GITHUB_CARD_ID}`,
		"/work/items/d5000000-0000-4000-8000-000000000002",
	]);
	expect(host.textContent).toContain(
		"Your earlier decision: Rotate leftover credentials",
	);
	await act(async () => trigger.click());
	expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("shows an empty result as prose without a disclosure", async () => {
	getContext.mockResolvedValue(decisionGraphFixture("empty"));
	await mount("empty");
	await settle();
	expect(host.textContent).toBe("No earlier decision or linked Work found.");
	expect(host.querySelector("button")).toBeNull();
});

it("distinguishes loading and failed reads from an empty chain, then retries", async () => {
	let reject!: (error: Error) => void;
	getContext.mockImplementationOnce(
		() =>
			new Promise((_, fail) => {
				reject = fail;
			}),
	);
	await mount();
	expect(host.textContent).toBe("Loading linked decisions…");
	await act(async () => reject(new Error("Unavailable")));
	await settle();
	expect(host.textContent).toContain("Couldn’t load linked decisions.");
	expect(host.textContent).not.toContain("No earlier decision");
	getContext.mockResolvedValue(GITHUB_DECISION_CONTEXT);
	await act(async () => host.querySelector("button")!.click());
	await settle();
	expect(host.textContent).toContain(GITHUB_DECISION_CONTEXT.explanation);
});

it("keeps unsafe evidence references out of links and encodes record ids", async () => {
	const data = structuredClone(GITHUB_DECISION_CONTEXT);
	data.context.chain[1]!.edge.evidenceRef = "javascript:alert(1)";
	data.context.chain[2]!.node.id = "report/with?query#fragment";
	getContext.mockResolvedValue(data);
	await mount();
	await settle();
	await act(async () => host.querySelector("button")!.click());
	expect(host.querySelectorAll('[href^="javascript:"]')).toHaveLength(0);
	expect(
		host.querySelector('a[href="/outputs/report%2Fwith%3Fquery%23fragment"]'),
	).not.toBeNull();
});

it("changes query identity with the card and resets the expanded chain", async () => {
	getContext.mockResolvedValue(GITHUB_DECISION_CONTEXT);
	await mount();
	await settle();
	await act(async () => host.querySelector("button")!.click());
	getContext.mockResolvedValue({
		...GITHUB_DECISION_CONTEXT,
		context: { ...GITHUB_DECISION_CONTEXT.context, cardId: "next" },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<DeckWhyChain cardId="next" />
			</QueryClientProvider>,
		),
	);
	await settle();
	expect(getContext.mock.calls.at(-1)?.[0]).toEqual({
		cardId: "next",
		maxHops: 4,
	});
	expect(host.querySelector("button")!.getAttribute("aria-expanded")).toBe(
		"false",
	);
});
