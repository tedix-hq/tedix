/**
 * Work operation pages, mounted: each page's composition (width, sections,
 * one form, responsive form surfaces) and its schema-backed mutation forms.
 * Reads resolve from a fake API keyed by procedure path.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { workInteractionsSearch } from "@/lib/work-route-search";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
	calls: [] as Array<{ path: string; input: unknown }>,
	reads: {} as Record<string, unknown>,
}));
vi.mock("@/lib/api", () => {
	const client = (path: string[]): unknown =>
		new Proxy(
			(input: unknown) => {
				const key = path.join(".");
				api.calls.push({ path: key, input });
				return Promise.resolve(
					key in api.reads
						? api.reads[key]
						: { data: [], nextCursor: null, pagination: { total: 0 } },
				);
			},
			{
				get: (_target, name) =>
					typeof name === "string" ? client([...path, name]) : undefined,
			},
		);
	return { osApi: client([]) };
});
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({
		to,
		params: _params,
		children,
		...rest
	}: {
		to: string;
		params?: unknown;
		children?: ReactNode;
	}) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
}));

const { WorkCasesPage } = await import("./work-cases-pages");
const { WorkActorOwnerContext } = await import("./work-actor-avatar");
const { WorkCasePage } = await import("./work-cases-pages");
const { WorkApprovalsPage } = await import("./work-approvals-page");
const { WorkInteractionsPage, WorkInteractionPage } =
	await import("./work-interactions-pages");
const { WorkClustersPage } = await import("./work-clusters-page");
const { WorkAdmissionPage } = await import("./work-admission-page");
const { WorkCapacityPage } = await import("./work-capacity-page");
const { Page } = await import("@/components/kumo/page");

afterEach(() => {
	api.calls.length = 0;
	api.reads = {};
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

const OWNER = "8f14e45f-ceea-4f1b-9b6f-0a4e4d5c0a11";

/** Emulate a phone (`max-width: 767px`) or a desktop viewport. */
function viewport(mobile: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: mobile && query.includes("max-width: 767px"),
		media: query,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
		onchange: null,
		dispatchEvent: () => false,
	}));
}

async function mount(element: ReactNode) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			mutations: { retry: false },
		},
	});
	const host = document.createElement("div");
	const rootRoute = createRootRoute();
	const route = createRoute({
		getParentRoute: () => rootRoute,
		path: "/work/interactions",
		validateSearch: workInteractionsSearch,
		component: () => element,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([route]),
		history: createMemoryHistory({ initialEntries: ["/work/interactions"] }),
	});
	await router.load();
	document.body.append(host);
	await act(async () =>
		createRoot(host).render(
			<QueryClientProvider client={client}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		),
	);
	await settle();
	const field = (label: string) => {
		const labelElement = [...host.querySelectorAll("label")].find((candidate) =>
			candidate.textContent?.trim().startsWith(label),
		);
		if (!labelElement) {
			const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
				`input[aria-label="${label}"],textarea[aria-label="${label}"]`,
			);
			if (input) return input;
			throw new Error(`no field labelled ${label}`);
		}
		return host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
			`#${CSS.escape(labelElement.htmlFor)}`,
		)!;
	};
	const type = async (label: string, value: string) => {
		const input = field(label);
		const prototype =
			input instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
		await act(async () => {
			Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
				input,
				value,
			);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	};
	const submit = async (buttonText: string) => {
		const button = [...host.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.trim() === buttonText,
		);
		if (!button) throw new Error(`no submit button ${buttonText}`);
		await act(async () => {
			if (button.form) button.form.requestSubmit();
			else button.click();
		});
		await settle();
	};
	return { host, client, type, submit };
}

async function settle() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

const pageClass = (width: "lg" | "xl") =>
	new DOMParser().parseFromString(
		renderToStaticMarkup(<Page width={width} />),
		"text/html",
	).body.firstElementChild?.className;
const mutations = (path: string) =>
	api.calls.filter((call) => call.path === path).map((call) => call.input);

describe("Work streams", () => {
	const asOwner = (element: ReactNode) => (
		<WorkActorOwnerContext.Provider value={OWNER}>
			{element}
		</WorkActorOwnerContext.Provider>
	);

	it("lists work streams first and reveals creation on demand", async () => {
		viewport(false);
		api.reads["workItems.listCases"] = {
			data: [
				{
					id: "case-1",
					title: "Refund backlog",
					kind: "operations",
					stage: "executing",
					accountableOwnerType: "user",
					accountableOwnerId: OWNER,
					targetResolutionAt: null,
				},
			],
			nextCursor: null,
		};
		const page = await mount(asOwner(<WorkCasesPage />));
		const root = page.host.querySelector('[data-slot="page"]')!;
		expect(root.className).toBe(pageClass("xl"));
		expect(page.host.querySelector("h1")?.textContent).toBe("Work streams");
		const list = page.host.querySelector('section[aria-label="Work streams"]')!;
		const create = [...page.host.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "New work stream",
		)!;
		expect(create.closest('[data-slot="page-actions"]')).not.toBeNull();
		expect(create.getAttribute("aria-expanded")).toBe("false");
		expect(page.host.querySelector("#open-case-form")).toBeNull();
		await act(async () => create.click());
		const form = page.host.querySelector("#open-case-form")!;
		expect(create.getAttribute("aria-expanded")).toBe("true");
		expect(
			form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// A tappable mobile list beside the uncompressed desktop table.
		const mobile = page.host.querySelector('ul[aria-label="Work streams"]')!;
		expect(mobile.classList.contains("sm:hidden")).toBe(true);
		expect(mobile.querySelector("[data-mobile-case-row]")).not.toBeNull();
		expect(mobile.querySelector("[data-mobile-case-owner]")).not.toBeNull();
		expect(
			page.host
				.querySelector("table")
				?.closest(".hidden")
				?.classList.contains("sm:block"),
		).toBe(true);
		// Plain stage names, no raw owner ids and no empty due-date column.
		expect(page.host.textContent).toContain("In progress");
		expect(page.host.innerHTML).not.toContain(OWNER);
		expect(page.host.innerHTML).not.toContain(OWNER.slice(0, 8));
		expect(page.host.textContent).not.toContain("Horizon");
		expect(page.host.textContent).not.toContain("Not committed");
		expect(
			[...page.host.querySelectorAll("th")].map((th) => th.textContent),
		).toEqual(["Work stream", "Stage", "Owner"]);

		await page.submit("Create");
		expect(mutations("workItems.createCase")).toEqual([]);
		expect(page.host.textContent).toContain("Give the work stream a name.");
		await page.type("Name", "  Refund backlog  ");
		await page.submit("Create");
		expect(mutations("workItems.createCase")[0]).toMatchObject({
			title: "Refund backlog",
			accountableOwnerType: "user",
			accountableOwnerId: OWNER,
		});
	});

	it("opens the form on phones and returns them to the list", async () => {
		viewport(true);
		const page = await mount(asOwner(<WorkCasesPage />));
		const create = [...page.host.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "New work stream",
		)!;
		expect(page.host.querySelector("#open-case-form")).toBeNull();
		await act(async () => create.click());
		expect(page.host.querySelector("#open-case-form")).not.toBeNull();
		await page.type("Name", "Refund backlog");
		await page.submit("Create");
		expect(page.host.querySelector("#open-case-form")).toBeNull();
	});

	it("shows a due date only when one is set, fully visible on a 390px phone", async () => {
		viewport(true);
		api.reads["workItems.listCases"] = {
			data: [
				{
					id: "case-1",
					title: "Refund backlog",
					kind: "operations",
					stage: "planning",
					accountableOwnerType: "user",
					accountableOwnerId: OWNER,
					targetResolutionAt: "2031-12-30",
				},
				{
					id: "case-2",
					title: "Supplier audit",
					kind: "other",
					stage: "closed",
					accountableOwnerType: "user",
					accountableOwnerId: OWNER,
					targetResolutionAt: null,
				},
			],
			nextCursor: null,
		};
		const page = await mount(<WorkCasesPage />);
		const due = page.host.querySelectorAll("[data-mobile-case-due]");
		expect(due).toHaveLength(1);
		expect(due[0]!.textContent).toBe("Due Dec 30, 2031");
		expect(due[0]!.className).not.toContain("whitespace-nowrap");
		expect(due[0]!.className).not.toContain("truncate");
		expect(due[0]!.className).toContain("tabular-nums");
		// The desktop table keeps an uncompressed Due column once any row has one.
		const cell = [...page.host.querySelectorAll("table td")].find((element) =>
			element.textContent?.includes("Dec 30, 2031"),
		);
		expect(cell).toBeDefined();
		expect(page.host.textContent).not.toContain("Not committed");
	});
});

const runtimeApproval = (id: string) => ({
	id,
	description: `Deploy ${id}`,
	expiresAt: "2026-10-01T00:00:00.000Z",
	payload: {},
	review: {
		operatorQuestion: "Ship it?",
		intent: "deploy",
		summary: "One Worker deploy",
		evidenceRefs: [],
		timeout: null,
		decisionMode: "approve_or_reject",
	},
});

describe("Work approvals", () => {
	it("keeps waiting actions separate from approvals to start work", async () => {
		viewport(false);
		api.reads["tediApprovals.list"] = {
			data: Array.from({ length: 26 }, (_, index) =>
				runtimeApproval(`approval-${index}`),
			),
		};
		api.reads["workApprovals.listInbox"] = {
			data: [
				{
					proposal: {
						id: "proposal-1",
						workItemId: "item-1",
						action: "admit",
						authorityKey: "work.admit",
						version: 2,
						expiresAt: "2026-10-01T00:00:00.000Z",
						requestRationale: "Needed for the launch",
						proposal: {},
					},
					effectiveStatus: "pending",
					canDecide: true,
					workItem: { id: "item-1", title: "Verify export" },
				},
			],
			nextCursor: null,
		};
		const page = await mount(<WorkApprovalsPage />);
		const text = page.host.textContent ?? "";
		expect(text).not.toContain("Approve exact request");
		expect(page.host.querySelector('[data-slot="page"]')!.className).toBe(
			pageClass("xl"),
		);

		// An ordered review holds at most 25 exact requests.
		const add = () =>
			[...page.host.querySelectorAll<HTMLButtonElement>("button")].filter(
				(button) => button.textContent?.trim() === "Add to ordered review",
			);
		for (let index = 0; index < 25; index += 1)
			await act(async () => add()[0]!.click());
		expect(add()).toHaveLength(1);
		expect(add()[0]!.disabled).toBe(true);
		const reviews = [
			...page.host.querySelectorAll<HTMLButtonElement>("button"),
		].filter((button) => button.textContent?.trim() === "Review exact request");
		expect(reviews.length).toBeGreaterThan(0);

		// Decisions come before the one, separate request form.
		const decisions = page.host.querySelector(
			'[aria-label="Pending decisions"]',
		)!;
		const forms = page.host.querySelectorAll("form");
		expect(forms).toHaveLength(1);
		expect(
			decisions.compareDocumentPosition(forms[0]!) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		const runtime = page.host.querySelector(
			'[aria-labelledby="runtime-approvals-title"]',
		)!;
		const admission = page.host.querySelector(
			'[aria-labelledby="work-admission-title"]',
		)!;
		expect(
			runtime.compareDocumentPosition(admission) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("opens the exact-request review from a single runtime decision", async () => {
		viewport(false);
		api.reads["tediApprovals.list"] = { data: [runtimeApproval("approval-1")] };
		api.reads["tediApprovals.getReviewManifest"] = {
			manifestHash: "hash-1",
			actions: [],
		};
		const page = await mount(<WorkApprovalsPage />);
		// The card names the request in words; its id stays in the diagnostics.
		const card = page.host.querySelector(
			'[aria-labelledby="runtime-approvals-title"] li',
		)!;
		const diagnostics = card.querySelector(
			"[data-slot='collapsible-content'], pre",
		);
		expect(
			(card.textContent ?? "").replace(diagnostics?.textContent ?? "", ""),
		).not.toContain("approval-1");
		const review = [
			...page.host.querySelectorAll<HTMLButtonElement>("button"),
		].find((button) => button.textContent?.trim() === "Review exact request")!;
		await act(async () => review.click());
		await settle();
		expect(
			page.host.querySelector('[aria-label="Review selected exact requests"]'),
		).not.toBeNull();
	});
});

describe("Work interactions", () => {
	it("shows assigned requests first and reveals the request form on demand", async () => {
		viewport(false);
		const page = await mount(<WorkInteractionsPage />);
		expect(page.host.querySelector('[data-slot="page"]')!.className).toBe(
			pageClass("xl"),
		);
		const views = page.host.querySelector('[aria-label="Message view"]');
		expect(views?.textContent).toContain("Requested by me");
		const queue = page.host.querySelector(
			'[aria-labelledby="interaction-queue-title"]',
		)!;
		const ask = [...page.host.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Ask for input",
		)!;
		expect(ask.closest('[data-slot="page-actions"]')).not.toBeNull();
		expect(ask.getAttribute("aria-expanded")).toBe("false");
		expect(page.host.querySelector("form")).toBeNull();
		expect(queue.textContent).toContain("Assigned to me");
		await act(async () => ask.click());
		const form = page.host.querySelector("#ask-for-input-form")!;
		expect(ask.getAttribute("aria-expanded")).toBe("true");
		expect(
			form.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(page.host.querySelectorAll("form")).toHaveLength(1);
		const create = [...page.host.querySelectorAll("button")].find((button) =>
			button.textContent?.trim().startsWith("Create "),
		)!;
		await act(async () => create.form!.requestSubmit());
		await settle();
		expect(mutations("workInteractions.create")).toEqual([]);
		expect(page.host.textContent).toContain("Enter a context id.");
	});

	it("keeps the request form out of the phone queue until opened", async () => {
		viewport(true);
		const page = await mount(<WorkInteractionsPage />);
		expect(page.host.querySelector("#ask-for-input-form")).toBeNull();
		const ask = [...page.host.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Ask for input",
		)!;
		await act(async () => ask.click());
		expect(page.host.querySelector("#ask-for-input-form")).not.toBeNull();
	});

	it("closes a submitted request and shows it in the requested view", async () => {
		viewport(false);
		const page = await mount(<WorkInteractionsPage />);
		const ask = [...page.host.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Ask for input",
		)!;
		await act(async () => ask.click());
		await page.type("Context id", "work-1");
		await page.type("Target principal id", OWNER);
		await page.type("Subject", "Confirm refund policy");
		await page.type("Prompt", "Which policy applies?");
		await page.submit("Create Question");
		expect(mutations("workInteractions.create")[0]).toMatchObject({
			workItemId: "work-1",
			subject: "Confirm refund policy",
			requestedFrom: { type: "user", id: OWNER },
		});
		expect(page.host.querySelector("#ask-for-input-form")).toBeNull();
		expect(
			page.host.querySelector('[aria-labelledby="interaction-queue-title"]')
				?.textContent,
		).toContain("Requested by me");
	});

	it("attributes a chat-linked owner request to Codex without inventing a chat name", async () => {
		viewport(false);
		api.reads["workInteractions.get"] = {
			request: {
				id: "request-1",
				subject: "Dinner notes",
				kind: "question",
				version: 1,
				creatorType: "user",
				creatorId: "owner-1",
				requestedFromId: "owner-1",
				prompt: "What did you agree?",
				metadata: { originChatId: "chat-1", agentHarness: "codex" },
			},
			effectiveState: "open",
			canRespond: true,
			canCancel: true,
			responses: { data: [], hasMore: false, nextCursor: null },
		};
		const page = await mount(<WorkInteractionPage requestId="request-1" />);
		expect(page.host.querySelector(".fd-proposer")?.textContent).toContain(
			"Codex",
		);
		expect(page.host.textContent).toContain("What did you agree?");
		expect(page.host.textContent).toContain("Answer");
		expect(
			page.host
				.querySelector('[data-kumo-component="CollapsibleTrigger"]')
				?.getAttribute("aria-expanded"),
		).toBe("false");
	});

	it("keeps one action boundary and a quiet response collection on the detail page", async () => {
		viewport(false);
		api.reads["workInteractions.get"] = {
			request: {
				id: "request-1",
				subject: "Confirm refund policy",
				kind: "question",
				version: 1,
				creatorType: "user",
				creatorId: "owner-1",
				requestedFromId: null,
				prompt: "Can we refund within 30 days?",
				metadata: { originChatTitle: "OS" },
			},
			effectiveState: "open",
			canRespond: true,
			canCancel: true,
			responses: { data: [], hasMore: false, nextCursor: null },
		};
		const page = await mount(<WorkInteractionPage requestId="request-1" />);
		expect(page.host.querySelector('[data-slot="page"]')!.className).toBe(
			pageClass("lg"),
		);
		expect(page.host.querySelector('a[href="/work/needs-you"]')).not.toBeNull();
		expect(page.host.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
		expect(page.host.textContent).toContain("OS");
		expect(page.host.textContent).not.toContain("Responses (0)");
		expect(page.host.textContent).toContain("Can we refund within 30 days?");
		expect(
			page.host
				.querySelector('[data-kumo-component="CollapsibleTrigger"]')
				?.getAttribute("aria-expanded"),
		).toBe("false");
		expect(
			page.host.querySelector('[data-kumo-component="CollapsibleTrigger"]')
				?.textContent,
		).toBe("Why this?");
		await page.submit("Answer");
		expect(mutations("workInteractions.respond")).toEqual([]);
		await page.type("Your answer", "  Keep access passwordless.  ");
		await page.submit("Answer");
		expect(mutations("workInteractions.respond")).toEqual([
			{
				requestId: "request-1",
				expectedRequestVersion: 1,
				responseKind: "answer",
				body: "Keep access passwordless.",
				resolvesRequest: true,
				metadata: {
					source: "os-decision-card",
					cardAction: "answer",
					feedbackSignal: "answer",
					decisionClass: "question",
					decisionChoice: "approve",
					elapsedMs: expect.any(Number),
				},
			},
		]);
	});
});

describe("External action requests", () => {
	function request(url: string, state = "open", canRespond = true) {
		api.reads["workInteractions.get"] = {
			request: {
				id: "request-1",
				version: 1,
				subject: "Set up reviewer sign-in",
				kind: "input",
				creatorType: "user",
				creatorId: "owner-1",
				requestedFromId: null,
				prompt: "Complete reviewer sign-in on the provider site.",
				metadata: {
					originChatTitle: "OS",
					externalAction: { label: "Open sign-in", url },
				},
			},
			effectiveState: state,
			canRespond,
			canCancel: false,
			responses: { data: [], hasMore: false, nextCursor: null },
		};
	}
	it("shows an external step without collecting an answer or marking it done", async () => {
		request("https://accounts.google.com/");
		const page = await mount(<WorkInteractionPage requestId="request-1" />);
		expect(page.host.textContent).toContain("OS");
		expect(page.host.querySelector("input, textarea")).toBeNull();
		expect(page.host.textContent).toContain(
			"Complete reviewer sign-in on the provider site.",
		);
		const link = page.host.querySelector(
			'a[href="https://accounts.google.com/"]',
		)!;
		expect(link.textContent).toBe("Open sign-in");
		expect(link.getAttribute("rel")).toContain("noopener");
		expect(page.host.querySelector("form, textarea")).toBeNull();
		expect(mutations("workInteractions.respond")).toEqual([]);
	});
	it.each([
		"javascript:alert(1)",
		"http://example.com",
		"https://user:password@example.com",
	])("rejects unsafe action URL %s", async (url) => {
		request(url);
		const page = await mount(<WorkInteractionPage requestId="request-1" />);
		expect(page.host.textContent).not.toContain("Open sign-in");
		expect(
			page.host.querySelector('textarea[aria-label="Your answer"]'),
		).not.toBeNull();
	});
	it.each([
		["cancelled", true],
		["resolved", true],
		["open", false],
	] as const)(
		"preserves state %s and recipient permission %s",
		async (state, canRespond) => {
			request("https://accounts.google.com/", state, canRespond);
			const page = await mount(<WorkInteractionPage requestId="request-1" />);
			expect(page.host.textContent).not.toContain("Open sign-in");
			expect(page.host.querySelector("form, textarea")).toBeNull();
			if (state !== "open")
				expect(page.host.textContent).toContain("Request closed");
			expect(
				page.host.querySelector('textarea[aria-label="Your answer"]'),
			).toBeNull();
		},
	);
});

describe("Work admission and capacity", () => {
	it("uses separate schema-backed lookup and specification forms", async () => {
		viewport(false);
		const page = await mount(<WorkAdmissionPage />);
		expect(page.host.querySelectorAll("form")).toHaveLength(0);
		await page.submit("Advanced: IDs and specification JSON");
		expect(page.host.querySelectorAll("form")).toHaveLength(2);
		await page.type("Work Item id", "not-a-uuid");
		await page.submit("Load");
		expect(page.host.textContent).toContain(
			"Enter a canonical Work Item UUID.",
		);
		expect(
			api.calls.some(
				(call) => call.path === "workItems.getAdmissionSpecification",
			),
		).toBe(false);
	});

	it("uses schema-backed resource and budget forms that close on phones after saving", async () => {
		viewport(true);
		api.reads["workItems.listResourcePools"] = {
			data: [
				{
					pool: {
						id: "pool-1",
						resourceKey: "repo:acme/app",
						allocationMode: "exclusive",
						capacity: 1,
						version: 3,
					},
					activeReserved: 0,
					effectiveAvailable: 1,
				},
			],
			nextCursor: null,
		};
		const page = await mount(<WorkCapacityPage />);
		const surfaces = [
			...page.host.querySelectorAll<HTMLElement>(
				'[data-kumo-component="ResponsiveFormSurface"]',
			),
		];
		expect(surfaces).toHaveLength(2);
		for (const surface of surfaces)
			expect(surface.dataset.responsiveFormState).toBe("closed");

		// Editing a pool opens its form on phones with the pool's values.
		const edit = [
			...page.host.querySelectorAll<HTMLButtonElement>("button"),
		].find((button) => button.textContent?.trim() === "Edit")!;
		await act(async () => edit.click());
		expect(surfaces[0]!.dataset.responsiveFormState).toBe("open");
		await page.submit("Save version 3");
		expect(mutations("workItems.putResourcePool")[0]).toMatchObject({
			resourceKey: "repo:acme/app",
			allocationMode: "exclusive",
		});
		expect(surfaces[0]!.dataset.responsiveFormState).toBe("closed");

		// The budget form refuses an invalid scope before any write.
		await act(async () =>
			surfaces[1]!.querySelector<HTMLElement>("button")!.click(),
		);
		await page.type("Scope id", "not-a-uuid");
		await page.submit("Create envelope");
		expect(mutations("workItems.putBudgetEnvelope")).toEqual([]);
		expect(page.host.textContent).toContain("Enter the scope UUID.");
	});
});

describe("Work case detail and clusters", () => {
	const TASK = "11111111-1111-4111-8111-111111111111";
	const OTHER_STREAM = "22222222-2222-4222-8222-222222222222";
	const workStream = (stage: string) => ({
		workCase: {
			id: "case-1",
			title: "Refund backlog",
			kind: "operations",
			stage,
			version: 2,
			projectId: null,
			accountableOwnerId: OWNER,
		},
		items: {
			data: [
				{
					id: "attachment-1",
					workItemId: TASK,
					rationale: "Customers wait on it",
				},
			],
			nextCursor: null,
		},
		dependencies: {
			data: [
				{ id: "edge-1", fromCaseId: "case-1", toCaseId: OTHER_STREAM },
				{ id: "edge-2", fromCaseId: OTHER_STREAM, toCaseId: "case-1" },
			],
			nextCursor: null,
		},
	});

	it("picks tasks and work streams by title and never shows raw ids", async () => {
		viewport(false);
		api.reads["workItems.getCase"] = workStream("planning");
		api.reads["workItems.getById"] = {
			workItem: { id: TASK, title: "Refund the March orders" },
		};
		api.reads["workItems.listCases"] = {
			data: [
				{ id: "case-1", title: "Refund backlog" },
				{ id: OTHER_STREAM, title: "Supplier audit" },
			],
			nextCursor: null,
		};
		const page = await mount(<WorkCasePage caseId="case-1" />);
		// No typed-id fields remain; both actions start disabled until a pick.
		expect(page.host.querySelector('input[placeholder*="UUID"]')).toBeNull();
		expect(page.host.textContent).not.toContain("Work Item id");
		for (const label of ["Add task", "Add dependency"]) {
			const button = [...page.host.querySelectorAll("button")].find(
				(candidate) => candidate.textContent?.trim() === label,
			);
			expect(button?.disabled, label).toBe(true);
		}
		expect(
			page.host.querySelector('[aria-label="Choose a task"]'),
		).not.toBeNull();
		expect(
			page.host.querySelector('[aria-label="Choose a work stream"]'),
		).not.toBeNull();
		// Lists name tasks and work streams by title.
		const task = page.host.querySelector("[data-case-task]")!;
		expect(task.textContent).toBe(
			"Refund the March orders — Customers wait on it",
		);
		const edges = [...page.host.querySelectorAll("[data-case-dependency]")].map(
			(edge) => edge.textContent,
		);
		expect(edges).toEqual([
			"Supplier audit waits for this one",
			"This one waits for Supplier audit",
		]);
		expect(page.host.textContent).not.toContain(TASK);
		expect(page.host.textContent).not.toContain(OTHER_STREAM);
		await page.submit("Add task");
		await page.submit("Add dependency");
		expect(
			api.calls.filter((call) =>
				[
					"workItems.attachCaseWorkItem",
					"workItems.addCaseDependency",
				].includes(call.path),
			),
		).toEqual([]);
	});

	it("labels a stage change while it is pending", async () => {
		viewport(false);
		api.reads["workItems.getCase"] = workStream("investigating");
		api.reads["workItems.updateCase"] = new Promise(() => undefined);
		const page = await mount(<WorkCasePage caseId="case-1" />);
		await page.submit("Planning");
		const stage = [...page.host.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Moving to Planning…",
		);
		expect(stage?.disabled).toBe(true);
	});

	it("uses a schema-backed form for execution cluster lookup", async () => {
		viewport(false);
		const page = await mount(<WorkClustersPage />);
		expect(page.host.querySelectorAll("form")).toHaveLength(0);
		await page.submit("Advanced: tedi UUID");
		await page.type("Executor tedi id", "not-a-uuid");
		await page.submit("Plan waves");
		expect(page.host.textContent).toContain("Enter a canonical tedi UUID.");
		expect(
			api.calls.some((call) => call.path === "workScheduler.planClusters"),
		).toBe(false);
	});
});

describe("Proposal decision cards", () => {
	it.each([
		["Yes, start", "handoff_accepted", true, "start"],
		["Not now", "handoff_declined", false, "not-now"],
		["Never", "handoff_declined", true, "never"],
	] as const)(
		"records %s as a valid handoff response",
		async (label, responseKind, resolvesRequest, cardAction) => {
			api.reads["workInteractions.get"] = {
				request: {
					id: "proposal-1",
					kind: "handoff",
					version: 4,
					subject: "Tedix can draft the harbor timetable",
					prompt: "Robin can prepare a timetable for review.",
					metadata: {},
				},
				effectiveState: "open",
				canRespond: true,
				canCancel: false,
				responses: { data: [], hasMore: false, nextCursor: null },
			};
			const page = await mount(<WorkInteractionPage requestId="proposal-1" />);
			expect(page.host.querySelector("input,textarea")).toBeNull();
			await page.submit(label);
			expect(mutations("workInteractions.respond")).toEqual([
				expect.objectContaining({
					requestId: "proposal-1",
					expectedRequestVersion: 4,
					responseKind,
					resolvesRequest,
					metadata: expect.objectContaining({
						source: "os-decision-card",
						cardAction,
					}),
				}),
			]);
		},
	);
});

describe("Lane outcome cards", () => {
	it.each([
		["Done", "done", true],
		["Snooze 1 day", "snooze", false],
	] as const)(
		"preserves the existing %s action",
		async (label, laneAction, resolvesRequest) => {
			api.reads["workInteractions.get"] = {
				request: {
					id: "lane-question",
					kind: "question",
					version: 2,
					subject: "Confirm the harbor address",
					prompt: "Robin prepared the route. Confirm the address.",
					metadata: {
						followThrough: { laneHandoff: { nextClick: "Confirm address" } },
					},
				},
				effectiveState: "open",
				canRespond: true,
				canCancel: false,
				responses: { data: [], hasMore: false, nextCursor: null },
			};
			const page = await mount(
				<WorkInteractionPage requestId="lane-question" />,
			);
			expect(page.host.querySelector("input,textarea")).toBeNull();
			await page.submit(label);
			expect(mutations("workInteractions.respond")).toEqual([
				expect.objectContaining({
					requestId: "lane-question",
					responseKind: "answer",
					resolvesRequest,
					metadata: expect.objectContaining({
						laneAction,
						source: "os-decision-card",
					}),
				}),
			]);
		},
	);
});
