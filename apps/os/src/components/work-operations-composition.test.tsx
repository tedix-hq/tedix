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

const pages = await import("./work-operations-pages");
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
		validateSearch: pages.workInteractionsSearch,
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
		if (!labelElement) throw new Error(`no field labelled ${label}`);
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
			(candidate) =>
				candidate.form && candidate.textContent?.trim() === buttonText,
		);
		if (!button?.form) throw new Error(`no submit button ${buttonText}`);
		await act(async () => button.form!.requestSubmit());
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

describe("Work cases", () => {
	it("shows the register first and reveals case creation on demand", async () => {
		viewport(false);
		api.reads["workItems.listCases"] = {
			data: [
				{
					id: "case-1",
					title: "Refund backlog",
					kind: "operations",
					stage: "open",
					accountableOwnerId: OWNER,
					targetResolutionAt: null,
				},
			],
			nextCursor: null,
		};
		const page = await mount(<pages.WorkCasesPage />);
		const root = page.host.querySelector('[data-slot="page"]')!;
		expect(root.className).toBe(pageClass("xl"));
		const register = page.host.querySelector(
			'[aria-labelledby="case-register-title"]',
		)!;
		const open = [...page.host.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Open case",
		)!;
		expect(open.closest('[data-slot="page-actions"]')).not.toBeNull();
		expect(open.getAttribute("aria-expanded")).toBe("false");
		expect(page.host.querySelector("#open-case-form")).toBeNull();
		await act(async () => open.click());
		const form = page.host.querySelector("#open-case-form")!;
		expect(open.getAttribute("aria-expanded")).toBe("true");
		expect(
			form.compareDocumentPosition(register) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// A tappable mobile register beside the uncompressed desktop table.
		const mobile = page.host.querySelector('[aria-label="Cases"]')!;
		expect(mobile.classList.contains("sm:hidden")).toBe(true);
		expect(mobile.querySelector("[data-mobile-case-row]")).not.toBeNull();
		expect(mobile.querySelector("[data-mobile-case-owner]")).not.toBeNull();
		expect(
			page.host
				.querySelector("table")
				?.closest(".hidden")
				?.classList.contains("sm:block"),
		).toBe(true);
		// Canonical owners stay available as titles; the visible label is quiet.
		const owner = [...page.host.querySelectorAll(`[title="${OWNER}"]`)];
		expect(owner.length).toBeGreaterThan(0);
		for (const element of owner) expect(element.textContent).not.toBe(OWNER);

		await page.submit("Open case");
		expect(mutations("workItems.createCase")).toEqual([]);
		expect(page.host.textContent).toContain("Enter a case title.");
		await page.type("Case title", "  Refund backlog  ");
		await page.type("Accountable owner id", OWNER);
		await page.submit("Open case");
		expect(mutations("workItems.createCase")[0]).toMatchObject({
			title: "Refund backlog",
			accountableOwnerId: OWNER,
		});
	});

	it("opens the case form on phones and returns them to the register", async () => {
		viewport(true);
		const page = await mount(<pages.WorkCasesPage />);
		const open = [...page.host.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Open case",
		)!;
		expect(page.host.querySelector("#open-case-form")).toBeNull();
		await act(async () => open.click());
		expect(page.host.querySelector("#open-case-form")).not.toBeNull();
		await page.type("Case title", "Refund backlog");
		await page.type("Accountable owner id", OWNER);
		await page.submit("Open case");
		expect(page.host.querySelector("#open-case-form")).toBeNull();
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
	it("keeps ordered runtime decisions separate from Work admission authority", async () => {
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
		const page = await mount(<pages.WorkApprovalsPage />);
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
		const page = await mount(<pages.WorkApprovalsPage />);
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
		const page = await mount(<pages.WorkInteractionsPage />);
		expect(page.host.querySelector('[data-slot="page"]')!.className).toBe(
			pageClass("xl"),
		);
		const views = page.host.querySelector('[aria-label="Interaction view"]');
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
		const page = await mount(<pages.WorkInteractionsPage />);
		expect(page.host.querySelector("#ask-for-input-form")).toBeNull();
		const ask = [...page.host.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Ask for input",
		)!;
		await act(async () => ask.click());
		expect(page.host.querySelector("#ask-for-input-form")).not.toBeNull();
	});

	it("closes a submitted request and shows it in the requested view", async () => {
		viewport(false);
		const page = await mount(<pages.WorkInteractionsPage />);
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
		const page = await mount(
			<pages.WorkInteractionPage requestId="request-1" />,
		);
		expect(page.host.textContent).toContain("Question from your Codex chat");
		expect(page.host.textContent).toContain("What did you agree?");
		expect(page.host.textContent).toContain("Send reply");
		expect(page.host.textContent).not.toContain("Cancel request");
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
		const page = await mount(
			<pages.WorkInteractionPage requestId="request-1" />,
		);
		expect(page.host.querySelector('[data-slot="page"]')!.className).toBe(
			pageClass("lg"),
		);
		expect(
			page.host.querySelector('a[href="/work/interactions"]'),
		).not.toBeNull();
		expect(page.host.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
		expect(page.host.textContent).toContain("Question from OS");
		expect(page.host.textContent).not.toContain("Responses (0)");
		expect(page.host.textContent).toContain("Can we refund within 30 days?");
		expect(page.host.textContent).not.toContain("Cancel request");
		const details = [...page.host.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Request details",
		)!;
		await act(async () => details.click());
		expect(page.host.textContent).toContain("Can we refund within 30 days?");
		expect(page.host.textContent).not.toContain("Response kind");
		await page.submit("Send to OS");
		expect(mutations("workInteractions.respond")).toEqual([]);
		expect(page.host.textContent).toContain("Enter a response.");
		await page.type("Your answer", "  Keep access passwordless.  ");
		await page.submit("Send to OS");
		expect(mutations("workInteractions.respond")).toEqual([
			{
				requestId: "request-1",
				expectedRequestVersion: 1,
				responseKind: "answer",
				body: "Keep access passwordless.",
				resolvesRequest: true,
				metadata: {},
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
		const page = await mount(
			<pages.WorkInteractionPage requestId="request-1" />,
		);
		expect(page.host.textContent).toContain("Action from OS");
		expect(page.host.textContent).toContain("Waiting for your action");
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
		const page = await mount(
			<pages.WorkInteractionPage requestId="request-1" />,
		);
		expect(page.host.textContent).not.toContain("Open sign-in");
		expect(page.host.querySelector("textarea")).not.toBeNull();
	});
	it.each([
		["cancelled", true],
		["resolved", true],
		["open", false],
	] as const)(
		"preserves state %s and recipient permission %s",
		async (state, canRespond) => {
			request("https://accounts.google.com/", state, canRespond);
			const page = await mount(
				<pages.WorkInteractionPage requestId="request-1" />,
			);
			expect(page.host.textContent).not.toContain("Open sign-in");
			expect(page.host.querySelector("form, textarea")).toBeNull();
			if (state !== "open")
				expect(page.host.textContent).toContain("Step closed");
			expect(page.host.textContent).not.toContain("Answer saved");
		},
	);
});

describe("Work admission and capacity", () => {
	it("uses separate schema-backed lookup and specification forms", async () => {
		viewport(false);
		const page = await mount(<pages.WorkAdmissionPage />);
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
		const page = await mount(<pages.WorkCapacityPage />);
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
	it("uses schema-backed forms for case attachments and dependencies", async () => {
		viewport(false);
		api.reads["workItems.getCase"] = {
			workCase: {
				id: "case-1",
				title: "Refund backlog",
				kind: "operations",
				stage: "open",
				version: 2,
				accountableOwnerId: OWNER,
			},
			items: { data: [], nextCursor: null },
			dependencies: { data: [], nextCursor: null },
		};
		const page = await mount(<pages.WorkCasePage caseId="case-1" />);
		await page.type("Work Item id", "not-a-uuid");
		await page.submit("Attach Work Item");
		expect(page.host.textContent).toContain(
			"Enter a canonical Work Item UUID.",
		);
		await page.type("Dependent case id", "not-a-uuid");
		await page.submit("Add dependency");
		expect(page.host.textContent).toContain("Enter a canonical case UUID.");
		expect(
			api.calls.filter((call) =>
				[
					"workItems.attachCaseWorkItem",
					"workItems.addCaseDependency",
				].includes(call.path),
			),
		).toEqual([]);
	});

	it("uses a schema-backed form for execution cluster lookup", async () => {
		viewport(false);
		const page = await mount(<pages.WorkClustersPage />);
		await page.type("Executor tedi id", "not-a-uuid");
		await page.submit("Plan waves");
		expect(page.host.textContent).toContain("Enter a canonical tedi UUID.");
		expect(
			api.calls.some((call) => call.path === "workScheduler.planClusters"),
		).toBe(false);
	});
});
