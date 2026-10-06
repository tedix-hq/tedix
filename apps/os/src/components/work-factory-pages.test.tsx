import type { WorkItem } from "@tedix/api-contract/schemas/work-items";
import type { Project } from "@tedix/api-contract/contracts/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	projectListQueryOptions,
	projectRollupQueryOptions,
	workReadinessProjectionQueryOptions,
	workFleetQueryOptions,
	workAttemptProjectionQueryOptions,
	workItemDetailQueryOptions,
	workItemListQueryOptions,
	workItemAttemptsQueryOptions,
	workItemEvidenceQueryOptions,
	workItemEventsQueryOptions,
	workItemReadinessQueryOptions,
} from "@/lib/os-query-options";
import {
	EvidenceReference,
	EvidencePreviewResult,
	compactEvidenceUri,
	milestoneLifecycleUpdateInput,
	PortfolioProjectList,
	ProjectSummary,
	WorkItemStatusSummary,
	WorkItemPage,
	WorkRecordedOutcome,
	WorkAttemptActivity,
	recordedSettlementCommits,
	WorkItemInspectorPage,
	WorkItemReadOnlyLedgers,
	WorkPortfolioPage,
	WorkQueuePage,
	WorkGraphLedger,
	WorkRecoveryLedger,
	WorkAttemptsLedger,
	WorkAttemptsPage,
	workActivitySearch,
	workQueueSearch,
	WorkCompletedPage,
	workAttemptSessionLabel,
	WorkItemsTable,
	workEventActorLabel,
	evidenceTrustLabel,
} from "./work-factory-pages";
import { workPrincipalLabel } from "@/lib/work-display";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";

const project: Project = {
	id: "33333333-3333-4333-8333-333333333333",
	orgId: "22222222-2222-4222-8222-222222222222",
	key: "QUIET-OS",
	name: "Quiet command center",
	description: null,
	status: "active",
	leadTediId: null,
	ownerUserId: "owner-1",
	objectiveId: null,
	targetDate: "2026-09-01",
	metadata: null,
	createdAt: "2026-08-20T00:00:00.000Z",
	updatedAt: null,
	archivedAt: null,
};

const item: WorkItem = {
	id: ITEM_ID,
	orgId: "22222222-2222-4222-8222-222222222222",
	title: "Verify the customer export",
	description: null,
	disposition: "accepted",
	workKind: "operations",
	riskLevel: "high",
	acceptanceContract: {
		version: 1,
		doneLooksLike: "Final provider state is verified",
	},
	requiredCapabilities: [],
	requiredAuthorities: [],
	priority: "high",
	objectiveId: null,
	workClass: "objective",
	purposeExceptionExpiresAt: null,
	projectId: null,
	parentWorkItemId: null,
	sourceSessionKey: null,
	sourceIntentId: null,
	accountableOwnerType: "user",
	accountableOwnerId: "owner-1",
	stewardType: "tedi",
	stewardId: "operator-1",
	reviewerType: "user",
	reviewerId: "reviewer-1",
	reviewerLeaseExpiresAt: "2026-08-21T00:00:00.000Z",
	dueDate: null,
	deadline: null,
	startAt: null,
	durationDays: null,
	provenance: {},
	metadata: {},
	admissionSpecRevision: "fixture-revision-1",
	createdAt: "2026-08-20T00:00:00.000Z",
	updatedAt: null,
	acceptedAt: "2026-08-20T00:01:00.000Z",
	completedAt: null,
	cancelledAt: null,
	version: 1,
};

describe("Work factory queue", () => {
	it("labels governed, legacy, external, and unavailable evidence honestly", () => {
		expect(
			evidenceTrustLabel({
				kind: "artifact",
				status: "available",
				bundleDigestKind: "manifest",
			}),
		).toContain("manifest digest");
		expect(
			evidenceTrustLabel({ kind: "artifact", status: "unverified_legacy" }),
		).toBe("Unverified legacy");
		expect(
			evidenceTrustLabel({ kind: "external_https", status: "unverified" }),
		).toBe("Unverified external");
		expect(
			evidenceTrustLabel({ kind: "output_revision", status: "unavailable" }),
		).toBe("Source access unavailable");
	});
	it("keeps Work Item detail in the canonical inspector lane with list continuity", () => {
		const html = renderToStaticMarkup(
			<WorkItemInspectorPage>
				<div>Inspector content</div>
			</WorkItemInspectorPage>,
		);

		expect(html).toContain("max-w-5xl");
		expect(html).toContain('href="/work"');
		expect(html).toContain("All work");
	});

	it("links every row to the stable item route", () => {
		const html = renderToStaticMarkup(<WorkItemsTable items={[item]} />);
		expect(html).toContain(`href="/work/items/${ITEM_ID}"`);
		expect(html).toContain('class="m-0 grid list-none');
		expect(html).toContain("md:hidden");
		expect(html).toContain("hidden md:block");
	});

	it("renders row titles as records, not as a page of hyperlinks", () => {
		const html = renderToStaticMarkup(<WorkItemsTable items={[item]} />);

		// Still a real anchor: keyboard, middle-click, copy-link-address.
		expect(html).toContain(`<a href="/work/items/${ITEM_ID}"`);
		// Console treatment: surrounding foreground, no resting underline.
		expect(html).toContain("text-current");
		expect(html).not.toContain("text-kumo-link");
		expect(html).toContain("no-underline!");
		// The affordance survives: hover underline plus a visible focus ring.
		expect(html).toContain("hover:underline!");
		expect(html).toContain("focus-visible:ring-kumo-focus");
	});

	it("keeps mobile outcome metadata readable without a wide table", () => {
		const html = renderToStaticMarkup(<WorkItemsTable items={[item]} />);

		expect(html).toContain('aria-label="Work queue"');
		expect(html).toContain("Verify the customer export");
		expect(html).toContain("Accountable");
		expect(html).toContain("owner-1");
		expect(html).toContain("Kind");
		expect(html).toContain("Operations");
		expect(html).toContain("Updated");
		expect(html).toContain("min-w-[44rem] table-fixed xl:min-w-[54rem]");
		expect(html).toContain("line-clamp-2 font-medium");
		expect(html).toContain("min-h-11 min-w-0 flex-col items-start");
		expect(html).toContain("text-left");
		expect(html).toContain("basis-full flex-wrap");
		expect(html).toContain("type-tedix-label");
		expect(html).not.toContain(
			"flex min-h-7 min-w-0 items-center gap-2 overflow-hidden",
		);
		expect(html).toContain("py-2! whitespace-normal");
		expect(html).toContain('title="owner-1"');
		expect(html).toContain('title="Accountable: owner-1"');
		expect(html).toContain("hidden truncate py-2! xl:table-cell");
	});

	it("shortens opaque accountable UUIDs without abbreviating human labels", () => {
		expect(workPrincipalLabel("5eed0028-0000-4000-8000-000000000028")).toBe(
			"5eed0028…",
		);
		expect(workPrincipalLabel("owner-1")).toBe("owner-1");
		expect(workPrincipalLabel(null)).toBe("Unassigned");
		expect(
			workPrincipalLabel(
				"5eed0046-0000-4000-8000-000000000046",
				"external_agent",
			),
		).toBe("external_agent:5eed0046…");
	});

	it("renders business disposition independently from derived readiness", () => {
		const readiness = new Map([
			[
				ITEM_ID,
				{
					status: "evaluated" as const,
					state: "dependencies_blocked",
					ready: false,
				},
			],
		]);
		const html = renderToStaticMarkup(
			<WorkItemsTable items={[item]} readiness={readiness} />,
		);
		expect(html).toContain("Accepted");
		expect(html).toContain("Dependencies blocked");
	});

	it("omits redundant disposition from admission queue presentations", () => {
		const html = renderToStaticMarkup(
			<WorkItemsTable
				items={[item]}
				readiness={
					new Map([
						[
							ITEM_ID,
							{
								status: "evaluated" as const,
								state: "evaluation_required",
								ready: false,
							},
						],
					])
				}
				showDisposition={false}
			/>,
		);

		expect(html).not.toContain(">Disposition<");
		expect(html).not.toContain(">Accepted<");
		expect(html).toContain("Evaluation required");
		expect(html).toContain("min-w-[38rem] table-fixed xl:min-w-[48rem]");
	});

	it("labels readiness gates that have not been evaluated", () => {
		const html = renderToStaticMarkup(
			<WorkItemsTable
				items={[item]}
				readiness={new Map([[ITEM_ID, { status: "evaluating" as const }]])}
			/>,
		);
		expect(html).toContain("Evaluating gates");
		expect(html).not.toContain(">Ready<");
	});

	it("renders an evaluation-required result as not ready", () => {
		const html = renderToStaticMarkup(
			<WorkItemsTable
				items={[item]}
				readiness={
					new Map([
						[
							ITEM_ID,
							{
								status: "evaluated" as const,
								state: "evaluation_required",
								ready: false,
							},
						],
					])
				}
			/>,
		);
		expect(html).toContain("Evaluation required");
		expect(html).not.toContain(">Ready<");
	});

	it("renders one bounded readiness projection page and its continuation", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(workReadinessProjectionQueryOptions().queryKey, {
			data: [
				{
					workItem: {
						id: item.id,
						title: item.title,
						disposition: item.disposition,
						workKind: item.workKind,
						riskLevel: item.riskLevel,
						priority: item.priority,
						projectId: item.projectId,
						accountableOwnerType: item.accountableOwnerType,
						accountableOwnerId: item.accountableOwnerId,
						createdAt: item.createdAt,
						updatedAt: item.updatedAt,
					},
					readiness: {
						workItemId: item.id,
						state: "evaluation_required",
						ready: false,
						reasons: [],
						derivedAt: "2026-08-21T00:00:00.000Z",
						gates: [],
					},
				},
			],
			nextCursor: { at: item.createdAt, id: item.id },
			hasMore: true,
			observedAt: "2026-08-21T00:00:00.000Z",
		});
		const emptyBudgetScope = {
			envelopeCount: 0,
			limitMicros: 0,
			activeReservedMicros: 0,
			consumedMicros: 0,
			availableMicros: 0,
			exhaustedEnvelopeCount: 0,
		};
		queryClient.setQueryData(workFleetQueryOptions().queryKey, {
			observedAt: "2026-10-03T09:30:00.000Z",
			workItems: { total: 1, byDisposition: { accepted: 1 } },
			attempts: {
				total: 0,
				byRuntimeState: {},
				active: 0,
				staleLeases: 0,
				withoutAdmission: 0,
			},
			admissions: {
				total: 1,
				byEffectiveState: { rejected: 1 },
				latestRejected: 1,
			},
			approvals: { total: 0, byEffectiveStatus: {}, awaitingDecision: 0 },
			interactions: {
				total: 0,
				byEffectiveState: {},
				awaitingResponse: 0,
				overdue: 0,
			},
			resources: {
				poolCount: 0,
				totalCapacity: 0,
				activeReserved: 0,
				consumed: 0,
				saturatedPoolCount: 0,
				saturatedResourceKeys: [],
			},
			budgets: {
				envelopeCount: 0,
				byScope: {
					organization: emptyBudgetScope,
					project: emptyBudgetScope,
					case: emptyBudgetScope,
					work_item: emptyBudgetScope,
				},
			},
			attention: {
				staleAttemptLeases: 0,
				rejectedAdmissions: 1,
				approvalBacklog: 0,
				interactionBacklog: 0,
				saturatedResources: 0,
				exhaustedBudgets: 0,
				actions: [
					{
						key: "rejected_admissions",
						severity: "high",
						count: 1,
						label: "Resolve admission blockers",
						rationale: "Review current rejection details.",
						href: "/work/admission",
					},
				],
			},
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<WorkQueuePage />
			</QueryClientProvider>,
		);
		expect(html.indexOf("Work attention")).toBeLessThan(
			html.indexOf("Verify the customer export"),
		);
		expect(html).toContain("Resolve admission blockers");
		expect(html).toContain('href="/work/interactions"');
		expect(html).toContain("Verify the customer export");
		expect(html).toContain("Evaluation required");
		expect(html).not.toContain(">Disposition<");
		expect(html).not.toContain(">Accepted<");
		expect(html).toContain("Next page");
		expect(html).toContain('aria-label="Work queue"');
		expect(html).toContain('data-appearance="inline"');
	});
});

describe("Work graph collection", () => {
	it("keeps every edge in one bounded responsive collection with canonical destinations", () => {
		const secondItemId = "44444444-4444-4444-8444-444444444444";
		const missingTitleId = "55555555-5555-4555-8555-555555555555";
		const html = renderToStaticMarkup(
			<WorkGraphLedger
				relations={[
					{
						id: "66666666-6666-4666-8666-666666666666",
						fromWorkItemId: ITEM_ID,
						toWorkItemId: secondItemId,
						relationType: "blocks",
						createdAt: "2026-08-30T00:00:00.000Z",
					},
					{
						id: "77777777-7777-4777-8777-777777777777",
						fromWorkItemId: secondItemId,
						toWorkItemId: missingTitleId,
						relationType: "references",
						createdAt: "2026-08-30T00:00:00.000Z",
					},
				]}
				titles={
					new Map([
						[ITEM_ID, "Verify the customer export"],
						[secondItemId, "Publish the verified export"],
					])
				}
				truncated
			/>,
		);

		expect(html).toContain('aria-label="Work dependency edges"');
		expect(html).toContain('data-slot="collection"');
		expect(html).toContain('data-appearance="inline"');
		expect(html).toContain("max-h-[min(65vh,40rem)]");
		expect(html).toContain("overflow-y-auto");
		expect(html).toContain("sm:hidden");
		expect(html).toContain("hidden overflow-visible sm:block");
		expect(html).toContain("min-h-11 w-full min-w-0 items-center");
		expect(html).toContain(`href="/work/items/${ITEM_ID}"`);
		expect(html).toContain(`href="/work/items/${secondItemId}"`);
		expect(html).toContain(`href="/work/items/${missingTitleId}"`);
		expect(html).toContain("Verify the customer export");
		expect(html).toContain(missingTitleId);
		expect(html).toContain("Blocks");
		expect(html).toContain("References");
		expect(html).toContain("Dependency view is truncated");
		expect(html).toContain("first 5,000 returned edges");
	});
});

describe("Work recovery collection", () => {
	it("renders one bounded responsive signal ledger instead of record cards", () => {
		const html = renderToStaticMarkup(
			<WorkRecoveryLedger
				records={[
					{
						id: ITEM_ID,
						title: "Recover the customer export",
						signals: ["dependencies_blocked"],
						blockingDependencyCount: 2,
						latestAttemptState: "finished",
						latestAttemptOutcome: "failed",
					},
				]}
			/>,
		);

		expect(html).toContain('aria-label="Work recovery signals"');
		expect(html).toContain('data-slot="collection"');
		expect(html).toContain('data-appearance="inline"');
		expect(html).toContain("max-h-[min(65vh,40rem)]");
		expect(html).toContain("overflow-y-auto");
		expect(html).toContain("overscroll-y-contain");
		expect(html).toContain("lg:hidden");
		expect(html).toContain("hidden overflow-visible lg:block");
		expect(html).toContain("sticky top-0");
		expect(html).toContain("min-h-11");
		expect(html).toContain("flex-col items-start");
		expect(html).toContain("text-left");
		expect(html).toContain(`href="/work/items/${ITEM_ID}"`);
		expect(html).toContain("Dependencies blocked");
		expect(html).toContain("2 blocked · Finished · Failed");
		expect(html).not.toContain('data-slot="card"');
	});
});

describe("Work portfolio", () => {
	it("keys each server page and search separately", () => {
		expect(
			projectListQueryOptions(20, { offset: 20, search: "quiet" }).queryKey,
		).not.toEqual(projectListQueryOptions(20, { offset: 0 }).queryKey);
	});

	it("renders a compact desktop table and a dedicated mobile list", () => {
		const html = renderToStaticMarkup(
			<PortfolioProjectList
				projects={[project]}
				rollups={[{ percentDone: 0.625, aggregateDisposition: "accepted" }]}
			/>,
		);

		expect(html).toContain('aria-label="Projects"');
		expect(html).toContain("lg:hidden");
		expect(html).toContain("hidden lg:block");
		expect(html).toContain(`/work/projects/${project.id}`);
		expect(html).toContain("62.5%");
		expect(html).toContain("Accepted");
		expect(html).toContain('data-slot="collection"');
		expect(html).toContain("data-mobile-project-row");
		expect(html).toContain("data-mobile-project-progress");
		expect(html).toContain("data-mobile-project-owner");
		expect(html).toContain("data-mobile-project-horizon");
		expect(html).toContain(
			'<span class="line-clamp-2">Quiet command center</span>',
		);
		expect(html).not.toContain("min-w-0 truncate font-medium leading-snug");
		expect(html).not.toContain("<dt");
	});

	it("quiets opaque project owner ids without discarding canonical truth", () => {
		const ownerId = "5eed0028-0000-4000-8000-000000000028";
		const html = renderToStaticMarkup(
			<PortfolioProjectList
				projects={[{ ...project, ownerUserId: ownerId }]}
				rollups={[{ percentDone: 0.625, aggregateDisposition: "accepted" }]}
			/>,
		);

		expect(html.match(/5eed0028…/g)).toHaveLength(2);
		expect(html.match(new RegExp(`title="${ownerId}"`, "g"))).toHaveLength(2);
		expect(html).not.toContain(`Owner: ${ownerId}`);
	});

	it("shows the server total beyond the loaded page and bounds project rows", () => {
		const projects = Array.from({ length: 25 }, (_, index) => ({
			...project,
			id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
			key: `QUIET-${index}`,
			name: `Quiet command center ${index}`,
		}));
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(
			projectListQueryOptions(20, { offset: 0, search: undefined }).queryKey,
			{
				data: projects.slice(0, 20),
				pagination: {
					limit: 20,
					offset: 0,
					total: 125,
					hasMore: true,
				},
			},
		);
		for (const visibleProject of projects.slice(0, 20)) {
			queryClient.setQueryData(
				projectRollupQueryOptions(visibleProject.id).queryKey,
				{
					projectId: visibleProject.id,
					total: 2,
					byDisposition: { accepted: 2 },
					byWorkKind: { coding: 2 },
					percentDone: 0.5,
					aggregateDisposition: "accepted",
					distinctExecutors: [],
					topLevelItems: [],
					truncated: false,
				},
			);
		}

		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<WorkPortfolioPage />
			</QueryClientProvider>,
		);

		expect(html.match(/href="\/work\/projects\//g)).toHaveLength(40);
		expect(html).toContain("Showing 1–20 of 125 projects");
		expect(html).toContain("Next page");
		expect(html).not.toContain("Quiet command center 20");
	});

	it("pages to projects beyond the first server page", async () => {
		const projects = Array.from({ length: 25 }, (_, index) => ({
			...project,
			id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
			key: `QUIET-${index}`,
			name:
				index === 24
					? "Keystone command center"
					: `Quiet command center ${index}`,
		}));
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		for (const page of [0, 1]) {
			queryClient.setQueryData(
				projectListQueryOptions(20, {
					offset: page * 20,
					search: undefined,
				}).queryKey,
				{
					data: projects.slice(page * 20, page * 20 + 20),
					pagination: {
						limit: 20,
						offset: page * 20,
						total: 25,
						hasMore: page === 0,
					},
				},
			);
		}
		for (const row of projects) {
			queryClient.setQueryData(projectRollupQueryOptions(row.id).queryKey, {
				projectId: row.id,
				total: 0,
				byDisposition: {},
				byWorkKind: {},
				percentDone: 0,
				aggregateDisposition: "proposed",
				distinctExecutors: [],
				topLevelItems: [],
				truncated: false,
			});
		}
		queryClient.setQueryData(
			projectListQueryOptions(20, { offset: 0, search: "keystone" }).queryKey,
			{
				data: [projects[24]!],
				pagination: { limit: 20, offset: 0, total: 1, hasMore: false },
			},
		);
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={queryClient}>
						<WorkPortfolioPage />
					</QueryClientProvider>,
				),
			);
			expect(host.textContent).toContain("Quiet command center 0");
			const next = [...host.querySelectorAll("button")].find(
				(button) => button.textContent?.trim() === "Next page",
			);
			if (!next) throw new Error("Next page button missing");
			await act(async () => next.click());
			expect(host.textContent).toContain("Quiet command center 20");
			expect(host.textContent).not.toContain("Quiet command center 0");
			expect(host.textContent).toContain("Showing 21–25 of 25 projects");
			const search = host.querySelector<HTMLInputElement>(
				'[aria-label="Search projects"]',
			);
			if (!search) throw new Error("Search projects input missing");
			await act(async () => {
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)?.set?.call(search, "keystone");
				search.dispatchEvent(new Event("input", { bubbles: true }));
				await new Promise((resolve) => setTimeout(resolve, 275));
			});
			expect(host.textContent).toContain("Keystone command center");
			expect(host.textContent).toContain("1 matching projects");
			expect(host.textContent).not.toContain("Quiet command center 20");
		} finally {
			await act(async () => root.unmount());
			host.remove();
			queryClient.clear();
		}
	});

	it("omits empty mobile horizons while the desktop table keeps the explicit state", () => {
		const html = renderToStaticMarkup(
			<PortfolioProjectList
				projects={[{ ...project, targetDate: null }]}
				rollups={[{ percentDone: 0.625, aggregateDisposition: "accepted" }]}
			/>,
		);

		expect(html).not.toContain("data-mobile-project-horizon");
		expect(html).toContain("Not recorded");
	});
});

describe("Work project summary", () => {
	it("uses one semantic summary strip instead of nested statistic cards", () => {
		const html = renderToStaticMarkup(
			<ProjectSummary
				status="active"
				percentDone={0.86}
				aggregateDisposition="accepted"
				targetDate={null}
			/>,
		);

		expect(html).toContain('aria-label="Project summary"');
		expect(html).toContain("<dl");
		expect(html).toContain("86%");
		expect(html).toContain("Not recorded");
		expect(html).not.toContain('data-slot="card"');
	});
});

describe("Work item status summary", () => {
	it("uses a semantic status strip instead of statistic cards", () => {
		const html = renderToStaticMarkup(
			<WorkItemStatusSummary
				disposition="accepted"
				accountableOwnerId="owner-1"
				readiness={{
					state: "dependencies_blocked",
					ready: false,
					reasons: [{ detail: "A required dependency is still active." }],
				}}
			/>,
		);

		expect(html).toContain('aria-label="Work item status"');
		expect(html).toContain("Business disposition");
		expect(html).toContain("Dependencies blocked");
		expect(html).toContain("A required dependency is still active.");
		expect(html).not.toContain('data-slot="card"');
	});
});

describe("Work item read-only ledgers", () => {
	it("shows generic preview request failures without leaking raw errors", () => {
		const html = renderToStaticMarkup(
			<EvidencePreviewResult failed preview={undefined} />,
		);
		expect(html).toContain("Preview request failed");
		expect(html).toContain("Retry without changing the evidence record");
		expect(html).not.toContain("stack");
	});

	it("labels truncated bounded previews without expanding their content", () => {
		const html = renderToStaticMarkup(
			<EvidencePreviewResult
				failed={false}
				preview={{ status: "available", text: "bounded body", truncated: true }}
			/>,
		);
		expect(html).toContain("bounded body");
		expect(html).toContain("Preview truncated at 50 KiB");
		expect(html).toContain("governed source");
	});

	it("renders a lazy inert preview control for resolved evidence", () => {
		const html = renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<WorkItemReadOnlyLedgers
					workItemId={ITEM_ID}
					acceptanceContract={null}
					attempts={[]}
					events={[]}
					evidence={[
						{
							id: "55555555-5555-4555-8555-555555555555",
							uri: "artifact://proof",
							label: "Proof",
							kind: "artifact",
							claimKey: "result",
							disposition: "pending",
							reference: {
								kind: "artifact",
								status: "available",
								bundleDigestKind: "bytes",
							},
						},
					]}
				/>
			</QueryClientProvider>,
		);
		expect(html).toContain("Preview evidence");
		expect(html).toContain("Governed artifact");
		expect(html).not.toContain("<script");
	});

	it("uses shared flat collections instead of card shells", () => {
		const machineEvidence =
			"cloudflare://example-os/versions/11111111-1111-4111-8111-111111111111?git_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const html = renderToStaticMarkup(
			<WorkItemReadOnlyLedgers
				workItemId={item.id}
				acceptanceContract={item.acceptanceContract}
				attempts={[
					{
						id: "44444444-4444-4444-8444-444444444444",
						runtimeState: "finished",
						executorType: "external_agent",
						executorId: "executor-1",
						attemptNumber: 1,
					},
				]}
				evidence={[
					{
						id: "55555555-5555-4555-8555-555555555555",
						uri: machineEvidence,
						label: "Browser proof",
						kind: "browser",
						claimKey: "readback",
						disposition: "pending",
					},
				]}
				events={[
					{
						id: "66666666-6666-4666-8666-666666666666",
						eventType: "attempt.settled",
						actorType: "external_agent",
						actorId: "executor-1",
						occurredAt: "2026-08-21T00:00:00.000Z",
					},
				]}
			/>,
		);

		expect(html.match(/data-slot="section-collection"/g)).toHaveLength(4);
		expect(html).toContain("Runtime outcomes remain separate");
		expect(html).toContain("independent review are separate transitions");
		expect(html).toContain("lifecycle state is recorded here");
		expect(html).toContain("Attempt 1");
		expect(html).toContain("Finished");
		expect(html).toContain("Browser proof");
		expect(html).toContain(compactEvidenceUri(machineEvidence));
		expect(html).toContain(`title="${machineEvidence}"`);
		expect(html).toContain('aria-label="Copy to clipboard"');
		expect(html).toContain("Readback");
		expect(html).toContain("Attempt settled");
		expect(html).not.toContain('data-slot="card"');
	});

	it("retains explicit empty states", () => {
		const html = renderToStaticMarkup(
			<WorkItemReadOnlyLedgers
				workItemId={item.id}
				acceptanceContract={null}
				attempts={[]}
				evidence={[]}
				events={[]}
			/>,
		);

		expect(html).toContain("No acceptance contract defined.");
		expect(html).toContain("No execution attempts on this page.");
		expect(html).toContain("No lifecycle events recorded.");
	});

	it("quiets long event principals while preserving short human labels", () => {
		expect(workEventActorLabel("owner-1", "user")).toBe("user:owner-1");
		expect(workEventActorLabel("U39z24M4F456C31EdxA3a39gsuLH", "user")).toBe(
			"user:U39z24M4…",
		);
	});
});

describe("Work evidence links", () => {
	it("keeps short references intact and middle-truncates long machine refs", () => {
		expect(compactEvidenceUri("artifact://receipt/1")).toBe(
			"artifact://receipt/1",
		);
		const uri = `deployment://${"a".repeat(80)}/receipt`;
		const compact = compactEvidenceUri(uri);
		expect(compact).toHaveLength(50);
		expect(compact).toContain("…");
		expect(compact.startsWith("deployment://")).toBe(true);
		expect(compact.endsWith("aaaaaa/receipt")).toBe(true);
	});

	it("links explicit HTTPS evidence", () => {
		const html = renderToStaticMarkup(
			<EvidenceReference
				uri="https://evidence.example/report"
				label="Report"
			/>,
		);
		expect(html).toContain('href="https://evidence.example/report"');
	});

	it.each([
		"javascript:alert(1)",
		"data:text/html,unsafe",
		"file:///etc/passwd",
		"artifact://receipt/1",
	])("renders %s as inert text", (uri) => {
		const html = renderToStaticMarkup(
			<EvidenceReference uri={uri} label="Evidence" />,
		);
		expect(html).not.toContain("href=");
		expect(html).toContain(uri.replaceAll("&", "&amp;"));
	});
});

describe("Work attempt records", () => {
	it("uses a compact narrow-width summary while preserving the desktop table", () => {
		const executorId = "5eed0046-0000-4000-8000-000000000046";
		const html = renderToStaticMarkup(
			<WorkAttemptsLedger
				records={[
					{
						attempt: {
							id: "77777777-7777-4777-8777-777777777777",
							runtimeState: "finished",
							executorType: "external_agent",
							executorId,
							outcome: "succeeded",
							executorSessionId: "codex:customer-export-chat",
							heartbeatAt: "2026-10-03T09:00:00.000Z",
							finishedAt: "2026-10-03T09:15:00.000Z",
						},
						workItem: { id: ITEM_ID, title: "Verify the customer export" },
					},
				]}
			/>,
		);

		expect(html).toContain('aria-label="Attempt records"');
		expect(html).toContain('data-slot="collection"');
		expect(html).toContain('data-appearance="inline"');
		expect(html).toContain("lg:hidden");
		expect(html).toContain("hidden lg:block");
		expect(html).toContain("min-h-11 w-full min-w-0 items-center");
		expect(html).toContain("Finished · Succeeded · ");
		expect(html.match(/Session codex:customer-export-chat/g)).toHaveLength(2);
		expect(html.match(/dateTime="2026-10-03T09:15:00.000Z"/g)).toHaveLength(2);
		expect(html).not.toContain("Last heartbeat");
		expect(html.match(/external_agent:5eed0046…/g)).toHaveLength(2);
		expect(
			html.match(new RegExp(`title="external_agent:${executorId}"`, "g")),
		).toHaveLength(2);
		expect(html).not.toContain(`>external_agent:${executorId}<`);
		expect(html).toContain(`href="/work/items/${ITEM_ID}"`);
	});
});

describe("Project milestone updates", () => {
	it("includes trimmed proof only for the guarded Done transition", () => {
		const common = {
			projectId: "22222222-2222-4222-8222-222222222222",
			milestoneId: "33333333-3333-4333-8333-333333333333",
			version: 4,
		};
		expect(
			milestoneLifecycleUpdateInput({
				...common,
				lifecycle: "done",
				proofRef: "  artifact://milestone/proof  ",
			}),
		).toMatchObject({
			lifecycle: "done",
			proofRef: "artifact://milestone/proof",
			expectedVersion: 4,
		});
		expect(
			milestoneLifecycleUpdateInput({
				...common,
				lifecycle: "active",
				proofRef: "artifact://ignored",
			}),
		).not.toHaveProperty("proofRef");
	});
});

describe("Recorded Work outcomes and activity", () => {
	const sha = "a".repeat(40);
	const attempt = {
		id: "77777777-7777-4777-8777-777777777777",
		orgId: item.orgId,
		workItemId: item.id,
		executorType: "external_agent" as const,
		executorId: "export-agent",
		executorSessionId: "codex:customer-export-chat",
		externalSessionKey: "server-bound-session",
		runtimeState: "finished" as const,
		outcome: "succeeded" as const,
		runId: null,
		admissionId: "99999999-9999-4999-8999-999999999999",
		attemptNumber: 2,
		startedAt: "2026-10-03T09:00:00.000Z",
		heartbeatAt: "2026-10-03T09:10:00.000Z",
		expiresAt: null,
		finishedAt: "2026-10-03T09:15:00.000Z",
		summary: "Published the export and checked customer access.",
		metadata: {
			settlement: { mode: "commit", commitSha: sha, commitShas: [sha] },
		},
	};
	it("prefers the server-bound chat key over the executor session UUID", () => {
		const key = "codex:01a0fd32-50e8-7381-b40e-e65f08270651-os-ux";
		const html = renderToStaticMarkup(
			<WorkAttemptActivity
				attempt={{
					executorSessionId: "99999999-9999-4999-8999-999999999999",
					externalSessionKey: key,
				}}
			/>,
		);
		expect(html).toContain("Codex chat 01a0fd32… · os-ux");
		expect(html).toContain(`title="${key}"`);
		expect(html).not.toContain("99999999");
		expect(workAttemptSessionLabel("codex:customer-export-chat")).toBe(
			"Session codex:customer-export-chat",
		);
	});
	it("makes historical Attempts distinguishable from live harness state", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		queryClient.setQueryData(
			workAttemptProjectionQueryOptions(undefined, "history").queryKey,
			{
				data: [{ attempt, workItem: item }],
				nextCursor: null,
				hasMore: false,
			},
		);
		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<WorkAttemptsPage view="history" />
			</QueryClientProvider>,
		);
		expect(html).toContain("Activity");
		expect(html).toContain("Recorded activity that has ended");
		expect(html).toContain(
			"does not by itself mean the work is completed or deployed",
		);
	});
	it("shows recorded result, finish time and commits without converting them into live verification", () => {
		const html = renderToStaticMarkup(
			<WorkRecordedOutcome attempt={attempt} />,
		);
		expect(html).toContain("Latest Attempt: Finished · Succeeded");
		expect(html).toContain(attempt.summary);
		expect(html).toContain(sha);
		expect(html).toContain('dateTime="2026-10-03T09:15:00.000Z"');
		expect(html).toContain(
			"separately from deployment and independent verification",
		);
		expect(html).not.toContain("Deployment verified");
	});
	it("preserves unknown settlement and missing historical attribution", () => {
		const html = renderToStaticMarkup(
			<WorkRecordedOutcome
				attempt={{ runtimeState: "finished", outcome: null }}
			/>,
		);
		expect(html).toContain("No recorded outcome");
		expect(html).toContain("Session not recorded");
		expect(html).toContain("Activity time not recorded");
		expect(html).toContain("no recorded settlement");
		expect(html).not.toContain("In progress");
		const missing = renderToStaticMarkup(<WorkRecordedOutcome />);
		expect(missing).toContain("No Attempt settlement recorded");
	});
	it("shows last heartbeat as a timestamp without claiming harness liveness", () => {
		const html = renderToStaticMarkup(
			<WorkAttemptActivity
				attempt={{
					externalSessionKey: "claude:bound-session",
					heartbeatAt: attempt.heartbeatAt,
				}}
			/>,
		);
		expect(html).toContain("Session claude:bound-session");
		expect(html).toContain("Last update");
		expect(html).not.toContain("Online");
	});
	it("accepts only recorded commit hashes and deduplicates legacy plus array metadata", () => {
		expect(
			recordedSettlementCommits({
				settlement: {
					commitSha: sha,
					commitShas: [sha, "b".repeat(40), "https://hostile.test", 42],
				},
			}),
		).toEqual([sha, "b".repeat(40)]);
		expect(recordedSettlementCommits({ settlement: null })).toEqual([]);
		expect(recordedSettlementCommits({ settlement: "not a receipt" })).toEqual(
			[],
		);
	});
	it("keeps the completed outcome ahead of historical progress while paging older Attempts", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		queryClient.setQueryData(workItemDetailQueryOptions(item.id).queryKey, {
			workItem: { ...item, disposition: "completed" },
			projections: [],
			evidence: [],
			evidenceNextCursor: null,
			comments: [
				{
					id: "88888888-8888-4888-8888-888888888888",
					workItemId: item.id,
					orgId: item.orgId,
					authorType: "user",
					authorId: "owner-1",
					body: "Activation pending before release",
					createdAt: "2026-10-03T08:00:00.000Z",
					metadata: {},
				},
			],
		});
		queryClient.setQueryData(workItemReadinessQueryOptions(item.id).queryKey, {
			workItemId: item.id,
			state: "not_accepted",
			ready: false,
			reasons: [],
			gates: [],
			derivedAt: attempt.finishedAt,
		});
		const cursor = { at: attempt.startedAt, id: attempt.id };
		queryClient.setQueryData(workItemAttemptsQueryOptions(item.id).queryKey, {
			data: [attempt],
			nextCursor: cursor,
		});
		queryClient.setQueryData(
			workItemAttemptsQueryOptions(item.id, cursor).queryKey,
			{
				data: [
					{
						...attempt,
						id: "66666666-6666-4666-8666-666666666666",
						attemptNumber: 1,
						runtimeState: "failed",
						outcome: "failed",
						summary: "Earlier attempt failed",
						startedAt: "2026-10-02T08:00:00.000Z",
					},
				],
				nextCursor: null,
			},
		);
		queryClient.setQueryData(workItemEvidenceQueryOptions(item.id).queryKey, {
			data: [],
			nextCursor: null,
		});
		queryClient.setQueryData(workItemEventsQueryOptions(item.id).queryKey, {
			events: [],
			nextSequence: null,
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<WorkItemPage itemId={item.id} />
			</QueryClientProvider>,
		);
		expect(html).toContain("Historical updates and discussion");
		expect(html.indexOf("Recorded outcome")).toBeLessThan(
			html.indexOf("Activation pending before release"),
		);
		expect(html).toContain(attempt.summary);
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={queryClient}>
						<WorkItemPage itemId={item.id} />
					</QueryClientProvider>,
				),
			);
			const next = [...host.querySelectorAll("button")].find(
				(button) =>
					button.textContent?.trim() === "Next page" && !button.disabled,
			);
			if (!next) throw new Error("Attempt next-page control missing");
			await act(async () => next.click());
			expect(host.textContent).toContain("Attempt 1");
			expect(host.textContent).toContain(
				"Latest Attempt: Finished · Succeeded",
			);
			expect(host.textContent).toContain(attempt.summary);
		} finally {
			act(() => root.unmount());
			host.remove();
		}
	});
	it("shows actionable serialized Portfolio failure messages", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, retryOnMount: false } },
		});
		const options = projectListQueryOptions(20, {
			offset: 0,
			search: undefined,
		});
		const query = queryClient.getQueryCache().build(queryClient, options);
		query.setState({
			status: "error",
			error: { message: "Project access denied. Sign in again." } as Error,
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<WorkPortfolioPage />
			</QueryClientProvider>,
		);
		expect(html).toContain("Portfolio unavailable");
		expect(html).toContain("Project access denied. Sign in again.");
	});
});

describe("lean activity navigation", () => {
	it("uses canonical server states and keeps active/history query caches distinct", () => {
		expect(workActivitySearch({ view: "invalid" })).toEqual({ view: "active" });
		expect(workActivitySearch({ view: "history" })).toEqual({
			view: "history",
		});
		const active = workAttemptProjectionQueryOptions(undefined, "active");
		const history = workAttemptProjectionQueryOptions(undefined, "history");
		expect(active.queryKey).not.toEqual(history.queryKey);
		expect(JSON.stringify(active.queryKey)).toContain(
			'"runtimeStates":["queued","running","waiting","retrying"]',
		);
		expect(JSON.stringify(history.queryKey)).toContain(
			'"runtimeStates":["finished","failed","expired","cancelled"]',
		);
	});
	it("flags overdue recorded activity without calling the harness offline", () => {
		const html = renderToStaticMarkup(
			<WorkAttemptActivity
				attempt={{
					expiresAt: "2020-01-01T00:00:00.000Z",
					heartbeatAt: "2020-01-01T00:00:00.000Z",
				}}
			/>,
		);
		expect(html).toContain("Update overdue");
		expect(html).not.toContain("Offline");
		const ended = renderToStaticMarkup(
			<WorkAttemptActivity
				attempt={{
					expiresAt: "2020-01-01T00:00:00.000Z",
					finishedAt: "2020-01-01T00:00:00.000Z",
				}}
			/>,
		);
		expect(ended).not.toContain("Update overdue");
	});
	it("lists business-completed work separately from ended activity", () => {
		expect(workQueueSearch({ disposition: "finished" })).toEqual({});
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		queryClient.setQueryData(
			workItemListQueryOptions({
				disposition: "completed",
				limit: 25,
				offset: 0,
			}).queryKey,
			{
				data: [{ ...item, disposition: "completed" }],
				pagination: { total: 1, limit: 25, offset: 0, hasMore: false },
			},
		);
		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<WorkCompletedPage />
			</QueryClientProvider>,
		);
		expect(html).toContain("Completed work");
		expect(html).not.toContain("Readiness");
		expect(html).toContain(item.title);
		expect(html).toContain("does not by itself prove deployment");
	});
});
