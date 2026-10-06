/**
 * Project planning mutations go through schema-backed Kumo forms: an invalid
 * milestone never reaches the API and says why; a valid one is trimmed and
 * sent once.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => [] as Array<{ path: string; input: unknown }>);
vi.mock("@/lib/api", () => {
	const client = (path: string[]): unknown =>
		new Proxy(
			(input: unknown) => {
				calls.push({ path: path.join("."), input });
				return Promise.resolve({ data: [], pagination: {} });
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
	Link: ({ to, children }: { to: string; children?: ReactNode }) => (
		<a href={to}>{children}</a>
	),
	useNavigate: () => () => {},
}));

const { WorkProjectPage } = await import("./work-factory-pages");
const q = await import("@/lib/os-query-options");

const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
	calls.length = 0;
	document.body.replaceChildren();
});

async function mountProject() {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				enabled: false,
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
			},
			mutations: { retry: false },
		},
	});
	client.setQueryData(q.projectDetailQueryOptions(PROJECT_ID).queryKey, {
		id: PROJECT_ID,
		orgId: "22222222-2222-4222-8222-222222222222",
		key: "QUIET-OS",
		name: "Quiet command center",
		description: null,
		status: "active",
		leadTediId: null,
		ownerUserId: "owner-1",
		objectiveId: null,
		targetDate: null,
		metadata: null,
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: null,
		archivedAt: null,
	} as never);
	client.setQueryData(q.projectMilestonesQueryOptions(PROJECT_ID).queryKey, {
		data: [],
	} as never);
	client.setQueryData(q.projectRollupQueryOptions(PROJECT_ID).queryKey, {
		percentDone: 0,
		aggregateDisposition: "accepted",
	} as never);
	client.setQueryData(
		q.projectHealthJudgmentsQueryOptions(PROJECT_ID).queryKey,
		[] as never,
	);
	client.setQueryData(
		q.workItemListQueryOptions({ projectId: PROJECT_ID, limit: 100 }).queryKey,
		{ data: [] } as never,
	);
	const host = document.createElement("div");
	document.body.append(host);
	await act(async () =>
		createRoot(host).render(
			<QueryClientProvider client={client}>
				<WorkProjectPage projectId={PROJECT_ID} />
			</QueryClientProvider>,
		),
	);
	const field = (label: string) => {
		const labelElement = [...host.querySelectorAll("label")].find((candidate) =>
			candidate.textContent?.trim().startsWith(label),
		)!;
		return host.querySelector<HTMLInputElement>(
			`#${CSS.escape(labelElement.htmlFor)}`,
		)!;
	};
	const type = async (label: string, value: string) => {
		const input = field(label);
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	};
	const submit = async () => {
		const button = [...host.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.trim() === "Create milestone",
		)!;
		await act(async () => {
			button.form!.requestSubmit();
			for (let tick = 0; tick < 3; tick += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
		});
	};
	return { host, type, submit };
}

describe("Project milestone updates", () => {
	it("uses schema-backed Kumo forms for project planning mutations", async () => {
		const page = await mountProject();
		await page.submit();
		expect(calls.some((call) => call.path === "projects.createMilestone")).toBe(
			false,
		);
		expect(page.host.textContent).toContain("Enter a milestone outcome.");

		await page.type("Milestone outcome", "  Launch the pilot  ");
		await page.type("Accountable user id", "owner-1");
		await page.submit();
		expect(
			calls.filter((call) => call.path === "projects.createMilestone"),
		).toEqual([
			{
				path: "projects.createMilestone",
				input: {
					id: PROJECT_ID,
					title: "Launch the pilot",
					accountableOwnerType: "user",
					accountableOwnerId: "owner-1",
				},
			},
		]);
	});
});
