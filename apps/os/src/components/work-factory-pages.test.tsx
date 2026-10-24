import type { WorkItem } from "@tedix/api-contract/schemas/work-items";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	userProfileQueryOptions,
	workItemDetailQueryOptions,
	workItemRelationsQueryOptions,
	workItemAttemptsQueryOptions,
	workItemEvidenceQueryOptions,
	workItemEventsQueryOptions,
	workItemReadinessQueryOptions,
	membersListQueryOptions,
	tediRosterQueryOptions,
	workExternalPrincipalsQueryOptions,
} from "@/lib/os-query-options";
import {
	EvidenceReference,
	EvidencePreviewResult,
	compactEvidenceUri,
	milestoneLifecycleUpdateInput,
	ProjectBrief,
	ProjectSummary,
	WorkItemStatusSummary,
	WorkItemPage,
	WorkRecordedOutcome,
	WorkAttemptActivity,
	recordedSettlementCommits,
	WorkItemInspectorPage,
	WorkItemReadOnlyLedgers,
	WorkGraphLedger,
	WorkGraphPage,
	workAttemptSessionLabel,
	WorkItemsTable,
	workOwnerName,
	workOwnerTitle,
	workEventActorLabel,
	evidenceTrustLabel,
} from "./work-factory-pages";
import { workPrincipalLabel } from "@/lib/work-display";

/** Seeds the accountable-name reads so a mounted page never reaches the network. */
function seedPrincipalNames(client: QueryClient, orgId: string) {
	client.setQueryData<unknown>(tediRosterQueryOptions(100).queryKey, {
		data: [],
	});
	client.setQueryData<unknown>(
		membersListQueryOptions({ organizationId: orgId, limit: 100, offset: 0 })
			.queryKey,
		{ data: [] },
	);
	client.setQueryData<unknown>(
		workExternalPrincipalsQueryOptions(orgId).queryKey,
		[],
	);
}

const ITEM_ID = "11111111-1111-4111-8111-111111111111";

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
		expect(html).toContain('href="/work/queue"');
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
		expect(html).toContain("Owner");
		expect(html).toContain("Owner name unavailable");
		expect(html).toContain("Kind");
		expect(html).toContain("Operations");
		expect(html).toContain("Updated");
		expect(html).toContain("min-w-[44rem] table-fixed xl:min-w-[54rem]");
		expect(html).toContain(
			'<span class="line-clamp-2">Verify the customer export</span>',
		);
		expect(html).toContain("min-h-11 min-w-0 flex-col items-start");
		expect(html).toContain("text-left");
		expect(html).toContain("basis-full flex-wrap");
		expect(html).toContain("type-tedix-label");
		expect(html).not.toContain(
			"flex min-h-7 min-w-0 items-center gap-2 overflow-hidden",
		);
		expect(html).toContain("py-2! whitespace-normal");
		expect(html).toContain('title="Owner: Owner name unavailable"');
		expect(html).toContain("hidden truncate py-2! xl:table-cell");
	});

	it("wraps long unbroken owner names inside phone queue rows", () => {
		const owner = "UnbreakableOwnerNameWithoutAnySpacesThatKeepsGoingAndGoing";
		const html = renderToStaticMarkup(
			<WorkItemsTable
				items={[item]}
				principalNames={new Map([["user:owner-1", owner]])}
			/>,
		);
		const doc = new DOMParser().parseFromString(html, "text/html");
		const ownerCell = [...doc.querySelectorAll("dd")].find(
			(cell) => cell.textContent === owner,
		);

		expect(ownerCell).not.toBeNull();
		expect(ownerCell?.className).toContain("break-words");
	});

	it("wraps kind and updated metadata inside phone queue rows", () => {
		const html = renderToStaticMarkup(<WorkItemsTable items={[item]} />);
		const doc = new DOMParser().parseFromString(html, "text/html");
		const kindCell = [...doc.querySelectorAll("dd")].find(
			(cell) => cell.textContent?.trim() === "Operations task",
		);
		const updatedCell = [...doc.querySelectorAll("dd")].find(
			(cell) => cell.querySelector("time") !== null,
		);

		expect(kindCell?.className).toContain("break-words");
		expect(updatedCell?.className).toContain("break-words");
	});

	it("names the owner without exposing the underlying identifier", () => {
		const names = new Map([["user:owner-1", "Mira Okafor"]]);
		const html = renderToStaticMarkup(
			<WorkItemsTable items={[item]} principalNames={names} />,
		);
		expect(html).toContain(">Mira Okafor<");
		expect(html).toContain('title="Owner: Mira Okafor"');
		expect(workOwnerName("tedi", "t-1", new Map([["tedi:t-1", "Sana"]]))).toBe(
			"Sana",
		);
		expect(workOwnerName(null, "owner-1", names)).toBe("Mira Okafor");
		expect(workOwnerName("user", null)).toBe("Unassigned");
		expect(workOwnerTitle("user", "owner-1")).toBe(
			"Owner: Owner name unavailable",
		);
	});

	it("keeps row identifiers out of visible text and tooltips", () => {
		const html = renderToStaticMarkup(<WorkItemsTable items={[item]} />);
		const doc = new DOMParser().parseFromString(html, "text/html");
		expect(doc.body.textContent).not.toContain(ITEM_ID.slice(0, 8));
		expect(html).not.toContain("data-row-id");
		expect(doc.body.textContent).not.toContain("owner-1");
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
});

describe("Work graph collection", () => {
	it("resolves the displayed endpoints independently of the bounded Work list", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		const otherId = "44444444-4444-4444-8444-444444444444";
		client.setQueryData(workItemRelationsQueryOptions({}, 5000).queryKey, {
			relations: Array.from({ length: 26 }, (_, index) => ({
				id: `edge-${index}`,
				fromWorkItemId: ITEM_ID,
				toWorkItemId:
					index === 25 ? "55555555-5555-4555-8555-555555555555" : otherId,
				relationType: "blocks" as const,
				createdAt: item.createdAt,
			})),
			truncated: true,
		});
		client.setQueryData(workItemDetailQueryOptions(ITEM_ID).queryKey, {
			workItem: item,
			project: null,
			projections: [],
			evidence: [],
			evidenceNextCursor: null,
			comments: [],
		});
		client.setQueryData(workItemDetailQueryOptions(otherId).queryKey, {
			project: null,
			projections: [],
			evidence: [],
			evidenceNextCursor: null,
			comments: [],
			workItem: {
				...item,
				id: otherId,
				title: "Older task outside the first 100",
			},
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkGraphPage />
			</QueryClientProvider>,
		);
		expect(html).toContain(item.title);
		expect(html).toContain("Older task outside the first 100");
		expect(html).toContain("1–25 of 26 returned dependencies");
		expect(html).toContain("Dependency view is truncated");
		expect(html).toContain("Next dependencies");
		expect(client.getQueryCache().getAll()).toHaveLength(3);
	});

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
		expect(html).toContain("min-h-11");
		expect(html).toContain(`href="/work/items/${ITEM_ID}"`);
		expect(html).toContain(`href="/work/items/${secondItemId}"`);
		expect(html).toContain(`href="/work/items/${missingTitleId}"`);
		expect(html).toContain("Verify the customer export");
		expect(html).toContain(missingTitleId);
		expect(html).toContain("Task unavailable");
		expect(html).toContain('aria-label="Copy to clipboard"');
		expect(html).not.toContain(`From ${missingTitleId}`);
		expect(html).toContain("Blocks");
		expect(html).toContain("References");
		expect(html).toContain("Dependency view is truncated");
		expect(html).toContain("first 5,000 returned edges");
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
		expect(html).toContain('data-slot="metric-grid"');
		expect(html.match(/data-slot="metric-item"/g)).toHaveLength(3);
		expect(html).toContain("<dl");
		expect(html).toContain("86%");
		expect(html).toContain("Not recorded");
		expect(html).not.toContain('data-slot="card"');
	});
});

describe("Work project brief", () => {
	it("shows the description with its line breaks", () => {
		const doc = new DOMParser().parseFromString(
			renderToStaticMarkup(
				<ProjectBrief description={"First line\nSecond line"} />,
			),
			"text/html",
		);
		const brief = doc.querySelector('section[aria-label="Brief"] p');
		expect(brief?.textContent).toBe("First line\nSecond line");
		expect(brief?.className).toContain("whitespace-pre-line");
	});

	it("shows a muted hint when the brief is empty", () => {
		for (const description of [null, "   "]) {
			const html = renderToStaticMarkup(
				<ProjectBrief description={description} />,
			);
			expect(html).toContain("This project has no brief yet.");
		}
	});
});

describe("Work item status summary", () => {
	it("puts acceptance beside the owner message only for the signed-in owner", () => {
		for (const viewerId of ["owner-1", "another-person"]) {
			const client = new QueryClient({
				defaultOptions: { queries: { staleTime: Infinity, retry: false } },
			});
			seedPrincipalNames(client, item.orgId);
			client.setQueryData<unknown>(
				membersListQueryOptions({
					organizationId: item.orgId,
					limit: 100,
					offset: 0,
				}).queryKey,
				{ data: [{ descopeUserId: "owner-1", name: "Mira Okafor" }] },
			);
			client.setQueryData<unknown>(userProfileQueryOptions().queryKey, {
				id: viewerId,
			});
			client.setQueryData<unknown>(
				workItemDetailQueryOptions(item.id).queryKey,
				{
					workItem: {
						...item,
						disposition: "proposed",
						acceptanceContract: null,
					},
					project: null,
					comments: [],
				},
			);
			const html = renderToStaticMarkup(
				<QueryClientProvider client={client}>
					<WorkItemPage itemId={item.id} />
				</QueryClientProvider>,
			);
			const doc = new DOMParser().parseFromString(html, "text/html");
			expect(doc.body.textContent).toContain(
				"Not started yet · Mira needs to accept this",
			);
			expect(doc.body.textContent).not.toContain("WorkSpec");
			expect(doc.body.textContent).not.toContain(item.id);
			const accept = [...doc.querySelectorAll("button")].some(
				(button) => button.textContent === "Accept",
			);
			expect(accept).toBe(viewerId === "owner-1");
			client.clear();
		}
	});

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
		expect(html).toContain("Status");
		expect(html).toContain("Waiting for the next step");
		expect(html).not.toContain("Business disposition");
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
		expect(html).toContain("Open the source");
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
		expect(html).toContain("Saved artifact");
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
		expect(html).toContain("See who worked on this task");
		expect(html).toContain("Saved evidence may still need to be reviewed");
		expect(html).toContain("lifecycle state is recorded here");
		expect(html).toContain("Session 1");
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

		expect(html).toContain("The expected result has not been described yet.");
		expect(html).toContain("No work sessions on this page.");
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
	it("shows recorded result, finish time and commits without converting them into live verification", () => {
		const html = renderToStaticMarkup(
			<WorkRecordedOutcome attempt={attempt} />,
		);
		expect(html).toContain("Latest session: Finished · Succeeded");
		expect(html).toContain(attempt.summary);
		expect(html).toContain(sha);
		expect(html).toContain('dateTime="2026-10-03T09:15:00.000Z"');
		expect(html).toContain(
			"Check the latest session result and any published changes",
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
		expect(missing).toContain("No session result recorded");
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
		seedPrincipalNames(queryClient, item.orgId);
		queryClient.setQueryData(workItemDetailQueryOptions(item.id).queryKey, {
			workItem: { ...item, disposition: "completed" },
			project: null,
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
		expect(html).toContain("Activity");
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
			const disclosure = [...host.querySelectorAll("button")].find(
				(button) => button.textContent?.trim() === "Technical details",
			);
			if (!disclosure) throw new Error("Technical details disclosure missing");
			await act(async () => disclosure.click());
			const next = [...host.querySelectorAll("button")].find(
				(button) =>
					button.textContent?.trim() === "Next page" && !button.disabled,
			);
			if (!next) throw new Error("Attempt next-page control missing");
			await act(async () => next.click());
			expect(host.textContent).toContain("Session 1");
			expect(host.textContent).toContain(
				"Latest session: Finished · Succeeded",
			);
			expect(host.textContent).toContain(attempt.summary);
		} finally {
			act(() => root.unmount());
			host.remove();
		}
	});
});

describe("lean activity navigation", () => {
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
});

it("renders verified raster evidence as an image", () => {
	const html = renderToStaticMarkup(
		<EvidencePreviewResult
			failed={false}
			preview={{
				status: "available",
				text: "",
				truncated: false,
				imageDataUrl: "data:image/png;base64,aW1hZ2U=",
			}}
		/>,
	);
	expect(html).toContain('alt="Work evidence preview"');
	expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
});
