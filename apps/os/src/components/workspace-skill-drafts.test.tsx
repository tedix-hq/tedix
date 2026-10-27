import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const harness = vi.hoisted(() => ({
	permissions: [] as string[],
	getGrant: vi.fn(),
	getSource: vi.fn(),
	listProposals: vi.fn(),
	getProposal: vi.fn(),
	withdraw: vi.fn(),
	members: vi.fn(),
	setGrant: vi.fn(),
	propose: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		skills: {
			setWorkspaceDraftGrant: harness.setGrant,
			proposeWorkspaceRevision: harness.propose,
			getWorkspaceDraftProposal: harness.getProposal,
			withdrawWorkspaceDraftProposal: harness.withdraw,
		},
	},
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: {
			authority: { permissions: harness.permissions },
			organization: { id: "org-fixture" },
		},
	}),
}));
vi.mock("@/lib/os-query-options", () => {
	const endpoint = (
		name: string,
		fetch: (input: unknown) => Promise<unknown>,
	) => ({
		key: () => [name],
		queryOptions: ({ input }: { input: unknown }) => ({
			queryKey: [name, input],
			queryFn: () => fetch(input),
		}),
	});
	return {
		osQuery: {
			skills: {
				getWorkspaceDraftGrant: endpoint("grant", harness.getGrant),
				listWorkspaceDraftProposals: endpoint(
					"proposals",
					harness.listProposals,
				),
				getWorkspaceDraftProposal: endpoint("proposal", harness.getProposal),
			},
		},
		membersListQueryOptions: (input: unknown) => ({
			queryKey: ["members", input],
			queryFn: () => harness.members(input),
		}),
		skillDetailQueryOptions: (id: string) => ({
			queryKey: ["skill", id],
			queryFn: () => harness.getSource(id),
		}),
		// Read by the shared draft dialog an owner opens from a saved proposal.
		skillRunsQueryOptions: (id: string) => ({
			queryKey: ["runs", id],
			queryFn: () => Promise.resolve({ runs: [] }),
		}),
		tediRosterQueryOptions: () => ({
			queryKey: ["tedis"],
			queryFn: () => Promise.resolve({ data: [] }),
		}),
		skillRevisionsQueryOptions: (id: string) => ({
			queryKey: ["revisions", id],
		}),
		osQueryKeys: { skills: () => ["skill"], skillRuns: () => ["runs"] },
	};
});
vi.mock("@tanstack/react-router", () => ({
	Link: (props: { children?: unknown }) => <a>{String(props.children)}</a>,
}));

import { WorkspaceSkillDrafts } from "./workspace-skill-drafts";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";
const resource = {
	id: RESOURCE_ID,
	workspaceId: WORKSPACE_ID,
	providerId: "tedix",
	resourceType: "skill",
	providerResourceId: "research-skill",
	name: "Research skill",
	status: "active",
} as OsWorkspaceResource;
const source = {
	id: "research-skill",
	title: "Research skill",
	revision: 4,
	content: "# Research\n\nRead the source.",
	files: { "scripts/workflow.ts": "export default { run() { return 1; } };" },
};

function receipt() {
	return {
		workspaceId: WORKSPACE_ID,
		resourceId: RESOURCE_ID,
		humanActivationRequired: true,
		canWithdraw: true,
		proposal: {
			id: PROPOSAL_ID,
			memberId: "member-agent",
			skillId: source.id,
			sourceRevision: 4,
			baseContent: source.content,
			baseFiles: source.files,
			content: "# Research\n\nRead and cite the source.",
			files: source.files,
			reason: "Include citations in each result.",
			status: "pending",
			withdrawnAt: null,
			createdAt: "2026-10-21T20:00:00.000Z",
		},
	};
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 6; tick += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
async function mount() {
	act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkspaceSkillDrafts workspaceId={WORKSPACE_ID} resource={resource} />
			</QueryClientProvider>,
		),
	);
	await flush();
}
function button(text: string) {
	const result = [...document.querySelectorAll("button")].find((item) =>
		item.textContent?.includes(text),
	);
	if (!result) throw new Error(`Missing button: ${text}`);
	return result;
}
async function click(target: HTMLElement) {
	act(() => target.click());
	await flush();
}
function fill(label: string, value: string) {
	const target = document.querySelector(`[aria-label="${label}"]`);
	if (!(target instanceof HTMLTextAreaElement))
		throw new Error(`Missing textarea: ${label}`);
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("Missing textarea value setter");
	act(() => {
		setter.call(target, value);
		target.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	harness.permissions = [];
	harness.getGrant.mockResolvedValue({
		effective: true,
		grant: {
			enabled: true,
			expiresAt: new Date(Date.now() + 86400_000).toISOString(),
		},
	});
	harness.getSource.mockResolvedValue({ entry: source });
	harness.listProposals.mockResolvedValue({ proposals: [] });
	harness.getProposal.mockResolvedValue(receipt());
	harness.propose.mockResolvedValue(receipt());
	harness.members.mockResolvedValue({
		data: [
			{
				id: "member-agent",
				name: "Assistant",
				email: "agent@example.test",
				status: "active",
			},
			{
				id: "other-agent",
				name: "Assistant",
				email: "other@example.test",
				status: "active",
			},
		],
	});
	harness.setGrant.mockResolvedValue({
		grant: {
			enabled: true,
			memberId: "member-agent",
			workspaceId: WORKSPACE_ID,
			resourceId: RESOURCE_ID,
		},
	});
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	client.clear();
	container.remove();
});

describe("workspace skill draft safety and usability", () => {
	it("keeps editing disabled without a grant and exposes no owner controls to a member", async () => {
		harness.getGrant.mockResolvedValue({ grant: null });
		await mount();
		expect(button("Propose changes").disabled).toBe(true);
		expect(document.body.textContent).not.toContain("Allow drafts for 7 days");
		expect(harness.getSource).not.toHaveBeenCalled();
		expect(harness.members).not.toHaveBeenCalled();
		expect(harness.propose).not.toHaveBeenCalled();
	});

	it("shows the source version and instruction/workflow diff before saving a non-executable proposal", async () => {
		const saved = receipt();
		saved.proposal.files = {
			"scripts/workflow.ts": "export default { run() { return 2; } };",
		};
		harness.propose.mockResolvedValue(saved);
		harness.getProposal.mockResolvedValue(saved);
		await mount();
		await click(button("Propose changes"));
		expect(document.body.textContent).toContain("Based on version 4");
		expect(
			(
				document.querySelector(
					'[aria-label="Draft skill instructions"]',
				) as HTMLTextAreaElement
			).value,
		).toBe(source.content);
		fill("Draft skill instructions", receipt().proposal.content);
		fill("Draft automation source", "export default { run() { return 2; } };");
		fill("Draft change reason", receipt().proposal.reason);
		const changes = [...document.querySelectorAll("summary")].find((item) =>
			item.textContent?.includes("Review changes"),
		);
		if (!changes) throw new Error("Missing reviewable source diff");
		await click(changes);
		const preview = [
			...document.querySelectorAll('[aria-label="Draft changes"]'),
		]
			.map((item) => item.textContent)
			.join("\n");
		expect(preview).toContain("- Read the source.");
		expect(preview).toContain("+ Read and cite the source.");
		expect(preview).toContain("return 1");
		expect(preview).toContain("return 2");
		await click(button("Save draft for review"));
		expect(harness.propose).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: WORKSPACE_ID,
				resourceId: RESOURCE_ID,
				expectedSourceRevision: 4,
				content: receipt().proposal.content,
				reason: receipt().proposal.reason,
				files: {
					"scripts/workflow.ts": "export default { run() { return 2; } };",
				},
				requestId: expect.any(String),
			}),
		);
		expect(harness.getProposal).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			resourceId: RESOURCE_ID,
			proposalId: PROPOSAL_ID,
		});
		expect(document.body.textContent).toContain("Pending owner review");
		expect(document.body.textContent).toContain("Base version 4");
		expect(document.body.textContent).toContain(`Receipt: ${PROPOSAL_ID}`);
		expect(
			[...document.querySelectorAll("button")].some((item) =>
				/publish|activate|run now/i.test(item.textContent ?? ""),
			),
		).toBe(false);
		expect(document.querySelector('a[href^="/skills/"]')).toBeNull();
	});

	it("reuses the same request receipt after an uncertain failure and retains the proposed edits", async () => {
		harness.propose.mockRejectedValueOnce(
			new Error(
				"Response unavailable; check the saved receipt before retrying.",
			),
		);
		await mount();
		await click(button("Propose changes"));
		fill("Draft skill instructions", receipt().proposal.content);
		fill("Draft change reason", receipt().proposal.reason);
		await click(button("Save draft for review"));
		expect(document.body.textContent).toContain("Response unavailable");
		expect(
			(
				document.querySelector(
					'[aria-label="Draft skill instructions"]',
				) as HTMLTextAreaElement
			).value,
		).toBe(receipt().proposal.content);
		const first = harness.propose.mock.calls[0]?.[0];
		await click(button("Save draft for review"));
		expect(harness.propose).toHaveBeenCalledTimes(2);
		expect(harness.propose.mock.calls[1]?.[0]).toEqual(first);
		expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
		expect(document.body.textContent).toContain("Pending owner review");
	});

	it("distinguishes matching display names by exact email before granting only this resource", async () => {
		harness.permissions = ["team:manage"];
		const expiresAt = "2026-12-01T12:34:56.000Z";
		harness.getGrant.mockImplementation(async (input) => ({
			effective: input.memberId === "member-agent",
			grant:
				input.memberId === "member-agent"
					? {
							memberId: input.memberId,
							workspaceId: WORKSPACE_ID,
							resourceId: RESOURCE_ID,
							skillId: source.id,
							enabled: true,
							expiresAt,
						}
					: null,
		}));
		await mount();
		const picker = document.querySelector<HTMLElement>(
			'[aria-label="Draft access for Research skill"]',
		);
		if (!picker) throw new Error("Missing draft-access member picker");
		await click(picker);
		const option = [
			...document.querySelectorAll<HTMLElement>('[role="option"]'),
		].find(
			(item) =>
				item.textContent?.includes("agent@example.test") &&
				!item.textContent?.includes("other@example.test"),
		);
		if (!option) throw new Error("Exact member email is not shown");
		expect(document.body.textContent).toContain("other@example.test");
		await click(option);
		expect(harness.getGrant).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			resourceId: RESOURCE_ID,
			memberId: "member-agent",
		});
		const readback = document.querySelector(
			'[aria-label="Selected member draft access"]',
		);
		expect(readback?.textContent).toContain(
			"agent@example.test · Research skill",
		);
		expect(readback?.textContent).toContain(RESOURCE_ID);
		expect(readback?.textContent).toContain(expiresAt);
		expect(readback?.textContent).toContain("Draft access allowed.");
		await click(button("Allow drafts for 7 days"));
		expect(harness.setGrant).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: WORKSPACE_ID,
				resourceId: RESOURCE_ID,
				memberId: "member-agent",
				enabled: true,
				expiresAt: expect.any(String),
			}),
		);
		const expiry = Date.parse(harness.setGrant.mock.calls[0]?.[0].expiresAt);
		expect(expiry).toBeGreaterThan(Date.now());
		expect(expiry).toBeLessThanOrEqual(Date.now() + 7 * 86400_000);
		expect(document.body.textContent).toContain(
			"Draft access saved for this skill and workspace.",
		);
		await click(picker);
		const other = [
			...document.querySelectorAll<HTMLElement>('[role="option"]'),
		].find((item) => item.textContent?.includes("other@example.test"));
		if (!other) throw new Error("Missing other member");
		await click(other);
		expect(document.body.textContent).not.toContain(
			"Draft access saved for this skill and workspace.",
		);
		expect(
			document.querySelector('[aria-label="Selected member draft access"]')
				?.textContent,
		).toContain("No current draft access.");
		expect(harness.getGrant).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			resourceId: RESOURCE_ID,
			memberId: "other-agent",
		});
	});

	it("uses server-effective access even when a stored grant is enabled", async () => {
		harness.getGrant.mockResolvedValue({
			grant: {
				enabled: true,
				expiresAt: new Date(Date.now() + 86400_000).toISOString(),
			},
			effective: false,
		});
		await mount();
		expect(button("Propose changes").disabled).toBe(true);
	});

	it("reports a selected-member access read failure and lets the owner retry", async () => {
		harness.permissions = ["team:manage"];
		harness.getGrant.mockImplementation(async (input) => {
			if (input.memberId) throw new Error("Access read unavailable");
			return { grant: null, effective: false };
		});
		await mount();
		const picker = document.querySelector<HTMLElement>(
			'[aria-label="Draft access for Research skill"]',
		);
		if (!picker) throw new Error("Missing member picker");
		await click(picker);
		const option = [
			...document.querySelectorAll<HTMLElement>('[role="option"]'),
		].find((item) => item.textContent?.includes("other@example.test"));
		if (!option) throw new Error("Missing member option");
		await click(option);
		expect(
			document.querySelector('[aria-label="Selected member draft access"]')
				?.textContent,
		).toContain("Access could not be checked.");
		harness.getGrant.mockResolvedValue({ grant: null, effective: false });
		await click(button("Retry member access"));
		expect(
			document.querySelector('[aria-label="Selected member draft access"]')
				?.textContent,
		).toContain("No current draft access.");
	});

	it("lets an owner review another member's pending receipt without a misleading withdraw or publish action", async () => {
		harness.permissions = ["team:manage"];
		harness.listProposals.mockResolvedValue({
			proposals: [
				{
					id: PROPOSAL_ID,
					memberId: "other-agent",
					sourceRevision: 4,
					reason: "Review these instructions",
					status: "pending",
				},
			],
		});
		harness.getProposal.mockResolvedValue({ ...receipt(), canWithdraw: false });
		await mount();
		await click(button("View pending draft"));
		expect(document.body.textContent).toContain(
			"It cannot run or change the live skill.",
		);
		expect(document.body.textContent).toContain(`Receipt: ${PROPOSAL_ID}`);
		expect(document.body.textContent).not.toContain("Withdraw my draft");
		expect(
			[...document.querySelectorAll("button")].some((item) =>
				/publish|activate|run now/i.test(item.textContent ?? ""),
			),
		).toBe(false);
		expect(harness.withdraw).not.toHaveBeenCalled();
	});

	it("shows the server's real reason, with its details, when a draft cannot be saved", async () => {
		harness.propose.mockRejectedValueOnce(
			Object.assign(new Error("Skill validation failed: WORKFLOW_SYNTAX"), {
				code: "BAD_REQUEST",
				data: {
					errors: [
						{
							code: "WORKFLOW_SYNTAX",
							message: "Unexpected token at line 3",
							path: "scripts/workflow.ts",
						},
					],
					warnings: [],
				},
			}),
		);
		await mount();
		await click(button("Propose changes"));
		fill("Draft automation source", "export default {");
		fill("Draft change reason", "Try a broken draft");
		await click(button("Save draft for review"));
		const alert = document.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain(
			"The draft could not be saved: Skill validation failed: WORKFLOW_SYNTAX",
		);
		expect(alert?.textContent).toContain(
			"WORKFLOW_SYNTAX: Unexpected token at line 3 (scripts/workflow.ts)",
		);
	});

	it("offers owners the shared test-and-switch-on path from a saved draft, and members nothing", async () => {
		harness.listProposals.mockResolvedValue({
			proposals: [
				{
					id: PROPOSAL_ID,
					memberId: "other-agent",
					sourceRevision: 4,
					reason: "Include citations in each result.",
					status: "pending",
				},
			],
		});
		await mount();
		await click(button("View pending draft"));
		expect(document.body.textContent).not.toContain(
			"Test and switch on this draft",
		);
		act(() => root.unmount());
		root = createRoot(container);
		harness.permissions = ["team:manage", "tedis:update"];
		harness.getSource.mockResolvedValue({
			entry: { ...source, organizationId: "org-fixture", tediId: "worker-1" },
		});
		await mount();
		await click(button("View pending draft"));
		await click(button("Test and switch on this draft"));
		expect(harness.getSource).toHaveBeenCalledWith(source.id);
		expect(document.body.textContent).toContain("from a workspace draft");
		expect(
			(
				document.querySelector(
					'[aria-label="Draft skill instructions"]',
				) as HTMLTextAreaElement
			).value,
		).toBe(receipt().proposal.content);
		expect(
			(
				document.querySelector(
					'[aria-label="Draft change reason"]',
				) as HTMLTextAreaElement
			).value,
		).toContain(
			`Include citations in each result. (workspace draft ${PROPOSAL_ID})`,
		);
		expect(harness.propose).not.toHaveBeenCalled();
	});

	it("distinguishes unavailable saved history from an empty list and retries the read", async () => {
		harness.listProposals.mockRejectedValueOnce(
			new Error("Service unavailable"),
		);
		await mount();
		expect(document.body.textContent).toContain(
			"Saved drafts could not be loaded",
		);
		expect(document.body.textContent).toContain(
			"before creating another proposal",
		);
		await click(button("Retry saved drafts"));
		expect(harness.listProposals).toHaveBeenCalledTimes(2);
		expect(document.body.textContent).not.toContain(
			"Saved drafts could not be loaded",
		);
		expect(harness.propose).not.toHaveBeenCalled();
	});

	it("explains an unavailable linked source instead of silently opening no editor", async () => {
		harness.getSource.mockResolvedValue({ entry: null });
		await mount();
		await click(button("Propose changes"));
		expect(document.body.textContent).toContain(
			"The linked skill could not be loaded",
		);
		expect(
			document.querySelector('[aria-label="Draft skill instructions"]'),
		).toBeNull();
		expect(harness.propose).not.toHaveBeenCalled();
	});
});
