import type { TediType } from "@tedix/api-contract/schemas/tedi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const tedisApi = vi.hoisted(() => ({
	list: vi.fn(),
	listOperationsSummaries: vi.fn(),
}));
const runtimeEntitlementsApi = vi.hoisted(() => ({
	get: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		runtimeEntitlements: runtimeEntitlementsApi,
		tedis: tedisApi,
	},
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

import {
	avatarKind,
	entrustmentSummary,
	roleHint,
	TASKS_PREVIEW_LIMIT,
	TeamChip,
	TeamEmpty,
	TediAvatar,
	TediDetailLink,
	type TediDetailLinkProps,
	TediDetailPanel,
	TediDetailUnavailable,
	tediMonogram,
	type TediOperationsDetail,
	TediRow,
	tediStatusLabel,
	tediStatusTone,
	TeamPage,
} from "./team-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseTedi: TediType = {
	id: "11111111-1111-4111-8111-111111111111",
	organizationId: "22222222-2222-4222-8222-222222222222",
	ownerUserId: null,
	scope: "organization",
	name: "cto",
	slug: "cto",
	displayName: "CTO Tedi",
	externalRef: null,
	tags: ["engineering"],
	personality: "Pragmatic engineering lead.\nSecond line never shows.",
	avatar: null,
	timezone: "Europe/Berlin",
	language: "en",
	installedSkills: ["record_skill"],
	installedPlugins: null,
	status: "active",
	billingState: "active",
	workerName: null,
	r2BucketName: null,
	runtimeState: "active",
	runtimeStatus: "running",
	lastActivityAt: "2026-08-13T08:00:00.000Z",
	lastSeenAt: "2026-08-13T07:00:00.000Z",
	lastSyncAt: null,
	createdAt: "2026-08-01T10:00:00.000Z",
	updatedAt: "2026-08-12T10:00:00.000Z",
};

const baseDetail: TediOperationsDetail = {
	delegationProfile: {
		activeRole: { roleName: "Engineering Lead", careerStage: "operator" },
		entrustments: [
			{ effectiveStatus: "active" },
			{ effectiveStatus: "active" },
			{ effectiveStatus: "restricted" },
		],
	},
	activeTasks: [
		{
			id: "t1",
			title: "Ship the deploy gate",
			status: "in_progress",
			blocker: null,
		},
		{
			id: "t2",
			title: "Fix cron drift",
			status: "blocked",
			blocker: "Waiting on approval",
		},
	],
	objectives: [{ id: "o1", status: "active" }],
	completedObjectives: 4,
	muscleCount: 12,
	pulse: {
		decisionsLast24h: 7,
		factsLearnedLast24h: 3,
		lastRationale: {
			action: "Chose batch over transaction",
			createdAt: "2026-08-13T06:00:00.000Z",
		},
	},
	approvalFatigueSignal: null,
};

describe("tediStatusTone", () => {
	it("maps every lifecycle status to an honest chip tone", () => {
		expect(tediStatusTone("active")).toBe("done");
		expect(tediStatusTone("provisioning")).toBe("active");
		expect(tediStatusTone("paused")).toBe("warn");
		expect(tediStatusTone("error")).toBe("blocked");
		expect(tediStatusTone(null)).toBe("neutral");
	});

	it("labels a null status as unknown instead of hiding it", () => {
		expect(tediStatusLabel("active")).toBe("active");
		expect(tediStatusLabel(null)).toBe("unknown");
	});
});

describe("avatarKind", () => {
	it("classifies URLs as images and short strings as emoji", () => {
		expect(avatarKind("https://cdn.tedix.dev/a.png")).toBe("image");
		expect(avatarKind("data:image/png;base64,AAAA")).toBe("image");
		expect(avatarKind("🤖")).toBe("emoji");
		expect(avatarKind(null)).toBe("monogram");
		expect(avatarKind("not an avatar at all")).toBe("monogram");
	});
});

describe("tediMonogram", () => {
	it("prefers the display name and uppercases the initial", () => {
		expect(tediMonogram(baseTedi)).toBe("C");
		expect(tediMonogram({ ...baseTedi, displayName: null, name: "ada" })).toBe(
			"A",
		);
	});

	it("falls back to ? when every name source is empty", () => {
		expect(
			tediMonogram({ displayName: null, name: "", slug: "" } as Pick<
				TediType,
				"displayName" | "name" | "slug"
			>),
		).toBe("?");
	});
});

describe("roleHint", () => {
	it("prefers the earned-delegation active role", () => {
		expect(
			roleHint(baseTedi, { roleName: "Engineering Lead", careerStage: "lead" }),
		).toBe("Engineering Lead · lead");
	});

	it("falls back to the first persona line", () => {
		expect(roleHint(baseTedi, null)).toBe("Pragmatic engineering lead.");
		expect(roleHint({ personality: null })).toBeNull();
	});

	it("truncates a long persona line with an ellipsis", () => {
		const hint = roleHint({ personality: "x".repeat(200) });
		expect(hint?.endsWith("…")).toBe(true);
		expect(hint!.length).toBeLessThanOrEqual(81);
	});
});

describe("entrustmentSummary", () => {
	it("counts by effective status in a fixed order", () => {
		expect(entrustmentSummary(baseDetail.delegationProfile.entrustments)).toBe(
			"2 active · 1 restricted entrustments",
		);
	});

	it("singularizes and returns null when empty", () => {
		expect(entrustmentSummary([{ effectiveStatus: "revoked" }])).toBe(
			"1 revoked entrustment",
		);
		expect(entrustmentSummary([])).toBeNull();
	});
});

describe("TeamChip", () => {
	it("renders a Kumo Badge stamped with its tone", () => {
		const html = renderToStaticMarkup(<TeamChip tone="done">x</TeamChip>);
		expect(html).toContain('data-slot="badge"');
		expect(html).toContain('data-tone="done"');
	});
});

describe("TediAvatar", () => {
	it("renders an image for URL avatars", () => {
		const html = renderToStaticMarkup(
			<TediAvatar
				tedi={{ ...baseTedi, avatar: "https://cdn.tedix.dev/a.png" }}
			/>,
		);
		expect(html).toContain('src="https://cdn.tedix.dev/a.png"');
	});

	it("renders the emoji avatar as-is and the monogram otherwise", () => {
		expect(
			renderToStaticMarkup(<TediAvatar tedi={{ ...baseTedi, avatar: "🤖" }} />),
		).toContain("🤖");
		expect(renderToStaticMarkup(<TediAvatar tedi={baseTedi} />)).toContain(
			">C<",
		);
	});
});

describe("TediRow", () => {
	it("renders avatar initial, name, slug, role hint, and the status chip", () => {
		const html = renderToStaticMarkup(<TediRow tedi={baseTedi} />);
		expect(html.indexOf("Sana")).toBeLessThan(html.indexOf("Active"));
		expect(html).toContain("CTO Tedi");
		expect(html).toContain("cto · Pragmatic engineering lead.");
		expect(html).toContain('data-tone="done"');
		expect(html).toContain("Active");
		expect(html).toContain("Running");
		expect(html).toContain('aria-expanded="false"');
	});

	it("marks personal-scope tedis and honors the delegation role hint", () => {
		const html = renderToStaticMarkup(
			<TediRow
				tedi={{ ...baseTedi, scope: "personal" }}
				summary={baseDetail}
			/>,
		);
		expect(html).toContain("Personal");
		expect(html).toContain("cto · Engineering Lead · operator");
	});

	it("states missing runtime/activity signals instead of hiding them", () => {
		const html = renderToStaticMarkup(
			<TediRow
				tedi={{
					...baseTedi,
					runtimeStatus: "unknown",
					lastActivityAt: null,
					lastSeenAt: null,
				}}
			/>,
		);
		expect(html).toContain("No runtime signal");
		expect(html).toContain("no recorded activity");
	});

	it("shows the detail panel when expanded with a summary", () => {
		const html = renderToStaticMarkup(
			<TediRow
				tedi={baseTedi}
				summary={baseDetail}
				expanded
				LinkComponent={StubLink}
			/>,
		);
		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain("Engineering Lead · Operator");
	});

	it("explains summary exclusion when expanded without one", () => {
		const html = renderToStaticMarkup(
			<TediRow
				tedi={{ ...baseTedi, status: "paused" }}
				expanded
				LinkComponent={StubLink}
			/>,
		);
		expect(html).toContain("excluded from the operations read");
	});

	it("offers the detail link without first opening the inspector", () => {
		const collapsed = renderToStaticMarkup(
			<TediRow tedi={baseTedi} LinkComponent={StubLink} />,
		);
		expect(collapsed).toContain(`/team/${baseTedi.id}`);
		expect(collapsed).toContain("Open details");
		expect(collapsed).toContain("Open CTO Tedi details");
		const expanded = renderToStaticMarkup(
			<TediRow tedi={baseTedi} expanded LinkComponent={StubLink} />,
		);
		expect(
			expanded.match(new RegExp(`/team/${baseTedi.id}`, "g")),
		).toHaveLength(1);
	});
});

// An anchor nested inside the row's expand <button> is invalid HTML and
// swallows one of the two activations, so the link must be a SIBLING.
const StubLink = ({
	params,
	children,
	"aria-label": ariaLabel,
}: TediDetailLinkProps) => (
	<a href={`/team/${params.tediId}`} aria-label={ariaLabel}>
		{children}
	</a>
);

describe("TediDetailLink", () => {
	it("links to the per-tedi evidence route", () => {
		const html = renderToStaticMarkup(
			<TediDetailLink tediId={baseTedi.id} LinkComponent={StubLink} />,
		);
		expect(html).toContain(`/team/${baseTedi.id}`);
		expect(html).toContain("Authority, telemetry, and learning evidence");
	});

	it("renders outside the expand button, never inside it", () => {
		const html = renderToStaticMarkup(
			<TediRow tedi={baseTedi} expanded LinkComponent={StubLink} />,
		);
		const buttonEnd = html.indexOf("</button>");
		expect(buttonEnd).toBeGreaterThan(-1);
		expect(html.indexOf(`href="/team/${baseTedi.id}"`)).toBeGreaterThan(
			buttonEnd,
		);
	});
});

describe("TediDetailPanel", () => {
	it("renders delegation, workload, and pulse with honest counts", () => {
		const html = renderToStaticMarkup(<TediDetailPanel detail={baseDetail} />);
		expect(html).toContain("Engineering Lead · Operator");
		expect(html).toContain("2 active · 1 restricted entrustments");
		expect(html).toContain("2 active tasks · 1 blocked");
		expect(html).toContain("1 current objective · 4 completed");
		expect(html).toContain("Ship the deploy gate");
		expect(html).toContain("blocked: Waiting on approval");
		expect(html).toContain(
			"7 decisions · 3 facts learned in the last 24h · 12 muscle memories",
		);
		expect(html).toContain("Chose batch over transaction");
	});

	it("states the observe-only default when delegation is empty", () => {
		const html = renderToStaticMarkup(
			<TediDetailPanel
				detail={{
					...baseDetail,
					delegationProfile: { activeRole: null, entrustments: [] },
				}}
			/>,
		);
		expect(html).toContain("No active role");
		expect(html).toContain("No entrustments — observe-only");
	});

	it("truncates the task list past the preview limit", () => {
		const manyTasks = Array.from(
			{ length: TASKS_PREVIEW_LIMIT + 2 },
			(_, i) => ({
				id: `task-${i}`,
				title: `Task ${i}`,
				status: "in_progress",
				blocker: null,
			}),
		);
		const html = renderToStaticMarkup(
			<TediDetailPanel detail={{ ...baseDetail, activeTasks: manyTasks }} />,
		);
		expect(html).toContain(`Task ${TASKS_PREVIEW_LIMIT - 1}`);
		expect(html).not.toContain(`Task ${TASKS_PREVIEW_LIMIT}<`);
		expect(html).toContain("+2 more active tasks");
	});

	it("surfaces the approval-fatigue signal when present", () => {
		const html = renderToStaticMarkup(
			<TediDetailPanel
				detail={{
					...baseDetail,
					approvalFatigueSignal: {
						type: "rubber_stamping",
						evidence: ["e1"],
					},
				}}
			/>,
		);
		expect(html).toContain("Approval fatigue signal: rubber stamping");
	});
});

describe("empty and unavailable states", () => {
	it("explains the empty roster without implying failure", () => {
		expect(renderToStaticMarkup(<TeamEmpty />)).toContain("No tedis yet");
	});

	it("distinguishes exclusion from a failed operations read", () => {
		expect(renderToStaticMarkup(<TediDetailUnavailable />)).toContain(
			"excluded from the operations read",
		);
		expect(
			renderToStaticMarkup(<TediDetailUnavailable readFailed />),
		).toContain("unavailable right now");
	});
});

// ---------------------------------------------------------------------------
// Page: Runtime section above the roster
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

function renderPage(): HTMLElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	function ControlledTeam() {
		const [page, setPage] = useState(1);
		return <TeamPage page={page} onPageChange={setPage} />;
	}
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<ControlledTeam />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

/** One macrotask tick is occasionally not enough for a query to settle. */
async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

describe("TeamPage", () => {
	beforeEach(() => {
		tedisApi.list.mockReset();
		tedisApi.listOperationsSummaries.mockReset();
		runtimeEntitlementsApi.get.mockReset();
		runtimeEntitlementsApi.get.mockResolvedValue({
			entitlement: { planName: "Business", active: true },
			modelPolicy: null,
		});
		tedisApi.list.mockResolvedValue({
			data: [baseTedi],
			pagination: { total: 1, hasMore: false },
		});
		tedisApi.listOperationsSummaries.mockResolvedValue({ data: [] });
	});

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("opens on the tedi roster without healthy runtime details", async () => {
		const container = renderPage();
		await flush();
		expect(container.textContent).toContain("CTO Tedi");
		expect(container.textContent).toContain("1 result");
		expect(container.textContent).not.toContain("Digital workers");
		expect(container.textContent).not.toContain("Business");
		expect(container.textContent).not.toContain("Model catalog");
		expect(container.textContent).not.toContain("Tedis cannot run");
	});

	it("shows one actionable notice when inference is blocked", async () => {
		runtimeEntitlementsApi.get.mockResolvedValue({
			entitlement: {
				planKey: "growth",
				planName: "Growth",
				status: "suspended",
				periodStart: "2026-08-01T00:00:00.000Z",
				periodEnd: "2100-01-01T00:00:00.000Z",
				active: false,
				settlementMode: "managed",
				source: "managed-plan",
				version: 1,
			},
			modelPolicy: null,
		});
		const container = renderPage();
		await flush();
		const text = container.textContent ?? "";
		expect(text).toContain("Tedis cannot run");
		expect(text).toContain("Growth is inactive.");
		expect(text).toContain("Runtime inference is blocked for this workspace.");
		expect(text).toContain("Review billing");
		expect(text).toContain("CTO Tedi");
		expect(container.querySelectorAll('[data-slot="alert"]')).toHaveLength(1);
	});

	it("shows the honest not-configured state without failing the roster", async () => {
		runtimeEntitlementsApi.get.mockResolvedValue({
			entitlement: null,
			modelPolicy: null,
		});
		const container = renderPage();
		await flush();
		const text = container.textContent ?? "";
		expect(text).toContain("This organization has no runtime plan.");
		expect(text).toContain("Review billing");
		expect(text).toContain("CTO Tedi");
	});

	it("keeps the roster visible if runtime status cannot be read", async () => {
		runtimeEntitlementsApi.get.mockRejectedValue(new Error("read failed"));
		const container = renderPage();
		await flush();
		expect(container.textContent).toContain("Runtime status unavailable");
		expect(container.textContent).toContain("View Compute");
		expect(container.textContent).toContain("CTO Tedi");
	});

	it("pages the complete roster and searches beyond the first page", async () => {
		const finance = {
			...baseTedi,
			id: "33333333-3333-4333-8333-333333333333",
			displayName: "Finance Tedi",
			slug: "finance",
			status: "active" as const,
		};
		const firstPage = Array.from({ length: 50 }, (_, index) => ({
			...baseTedi,
			id: `worker-${index}`,
			displayName: `Worker ${index}`,
			slug: `worker-${index}`,
		}));
		tedisApi.list.mockImplementation(
			async (input: { offset: number; search?: string }) => {
				if (input.search === "finance") {
					return {
						data: [finance],
						pagination: { total: 1, hasMore: false },
					};
				}
				return input.offset === 50
					? {
							data: [finance],
							pagination: { total: 51, hasMore: false },
						}
					: {
							data: firstPage,
							pagination: { total: 51, hasMore: true },
						};
			},
		);
		const container = renderPage();
		await flush();
		const input = container.querySelector<HTMLInputElement>(
			'input[aria-label="Search digital workers"]',
		);
		expect(input?.closest('[data-slot="page-toolbar"]')).not.toBeNull();
		expect(
			container.querySelector('[aria-label="Filter digital worker status"]'),
		).not.toBeNull();
		expect(container.textContent).toContain("51 results");
		expect(container.textContent).toContain("Showing 1–50 of 51 tedis");
		const next = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Next page"),
		);
		await act(async () => next?.click());
		await flush();
		expect(tedisApi.list).toHaveBeenCalledWith(
			{ limit: 50, offset: 50 },
			expect.anything(),
		);
		expect(container.textContent).toContain("Showing 51–51 of 51 tedis");
		expect(container.textContent).toContain("Finance Tedi");
		expect(tedisApi.listOperationsSummaries).toHaveBeenLastCalledWith(
			{ tediIds: [finance.id] },
			expect.anything(),
		);
		const activeInput = container.querySelector<HTMLInputElement>(
			'input[aria-label="Search digital workers"]',
		);
		await act(async () => {
			const setValue = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!;
			setValue.call(activeInput, "finance");
			activeInput!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
		});
		await flush();
		expect(tedisApi.list).toHaveBeenCalledWith(
			{ limit: 50, offset: 0, search: "finance" },
			expect.anything(),
		);
		expect(container.textContent).toContain("Showing 1–1 of 1 tedis");
		expect(container.textContent).toContain("Finance Tedi");
		expect(
			container.querySelectorAll('[data-slot="collection"] li'),
		).toHaveLength(1);
	});
});
