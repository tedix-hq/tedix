import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	DecisionContextRail,
	DecisionContextSection,
	DecisionContextToolbar,
} from "./decision-context-rail";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
});

async function mountRail() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const client = new QueryClient({
		defaultOptions: { queries: { enabled: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<DecisionContextRail>
					<DecisionContextSection
						sectionId="why"
						title="Why this"
						trigger
						defaultOpen
					>
						<p>Because the workshop is waiting.</p>
					</DecisionContextSection>
					<DecisionContextSection sectionId="source" title="Source" trigger>
						<p>Sent by Morgan.</p>
					</DecisionContextSection>
				</DecisionContextRail>
			</QueryClientProvider>,
		),
	);
}

function trigger(label: string) {
	const button = [...host.querySelectorAll("button")].find(
		(item) => item.textContent === label,
	);
	expect(button).toBeDefined();
	return button!;
}

async function click(label: string) {
	await act(async () => trigger(label).click());
}

const popup = () =>
	document.querySelector<HTMLElement>("[data-decision-context]")!;

describe("decision context rail sections", () => {
	it("opens the sheet on the section and closes it on a second click", async () => {
		await mountRail();
		expect(trigger("Why this").getAttribute("aria-expanded")).toBe("false");
		expect(popup().hasAttribute("hidden")).toBe(true);
		await click("Why this");
		expect(trigger("Why this").getAttribute("aria-expanded")).toBe("true");
		expect(popup().hasAttribute("hidden")).toBe(false);
		expect(trigger("Why this").getAttribute("aria-controls")).toBe(
			document.querySelector('[data-context-section="why"]')!.id,
		);
		await click("Why this");
		expect(trigger("Why this").getAttribute("aria-expanded")).toBe("false");
		expect(popup().hasAttribute("hidden")).toBe(true);
	});

	it("switches sections without closing the rail", async () => {
		await mountRail();
		await click("Why this");
		await click("Source");
		expect(popup().hasAttribute("hidden")).toBe(false);
		expect(trigger("Why this").getAttribute("aria-expanded")).toBe("false");
		expect(trigger("Source").getAttribute("aria-expanded")).toBe("true");
		expect(
			document
				.querySelector('[data-context-section="source"]')!
				.querySelector("button")!
				.getAttribute("aria-expanded"),
		).toBe("true");
		await click("Source");
		expect(popup().hasAttribute("hidden")).toBe(true);
	});

	it("closes the sheet on a second tap on a phone viewport", async () => {
		const original = window.matchMedia;
		window.matchMedia = ((query: string) => ({
			matches: query.includes("max-width: 639px"),
			media: query,
			onchange: null,
			addListener() {},
			removeListener() {},
			dispatchEvent: () => true,
			addEventListener() {},
			removeEventListener() {},
		})) as typeof window.matchMedia;
		try {
			await mountRail();
			await click("Why this");
			expect(popup().hasAttribute("hidden")).toBe(false);
			await click("Why this");
			expect(popup().hasAttribute("hidden")).toBe(true);
		} finally {
			window.matchMedia = original;
		}
	});

	it("uses the same Kumo sheet without an inline rail on desktop widths", async () => {
		await mountRail();
		expect(host.querySelector("aside.fd-context-rail")).toBeNull();
		expect(popup().getAttribute("role")).toBe("dialog");
		expect(popup().hasAttribute("hidden")).toBe(true);
		await click("Why this");
		expect(popup().hasAttribute("hidden")).toBe(false);
		expect(trigger("Why this").getAttribute("aria-expanded")).toBe("true");
		await click("Why this");
		expect(popup().hasAttribute("hidden")).toBe(true);
		expect(trigger("Why this").getAttribute("aria-expanded")).toBe("false");
	});
});

describe("mobile Decision Deck filters", () => {
	it("exposes the Filters disclosure state and its popup on open and close", async () => {
		const original = window.matchMedia;
		window.matchMedia = ((query: string) => ({
			matches: query.includes("max-width: 639px"),
			media: query,
			onchange: null,
			addListener() {},
			removeListener() {},
			dispatchEvent: () => true,
			addEventListener() {},
			removeEventListener() {},
		})) as typeof window.matchMedia;
		try {
			host = document.createElement("div");
			document.body.append(host);
			root = createRoot(host);
			const client = new QueryClient({
				defaultOptions: { queries: { enabled: false } },
			});
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<DecisionContextRail>
							<DecisionContextToolbar
								filters={<button type="button">Only urgent</button>}
							/>
						</DecisionContextRail>
					</QueryClientProvider>,
				),
			);
			const filters = host.querySelector<HTMLButtonElement>(
				'button[aria-label="Filters"]',
			)!;
			expect(filters).not.toBeNull();
			expect(filters.getAttribute("aria-expanded")).toBe("false");
			expect(filters.getAttribute("aria-haspopup")).toBe("dialog");
			await act(async () => filters.click());
			expect(filters.getAttribute("aria-expanded")).toBe("true");
			const controls = filters.getAttribute("aria-controls");
			expect(controls).toBeTruthy();
			const popup = document.getElementById(controls!);
			expect(popup?.textContent).toContain("Only urgent");
			await act(async () => filters.click());
			expect(filters.getAttribute("aria-expanded")).toBe("false");
		} finally {
			window.matchMedia = original;
		}
	});
});
