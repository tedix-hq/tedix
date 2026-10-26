import "./__tests__/kernel-runtime-work-mocks";
import { describe, expect, it } from "vite-plus/test";
import {
	ORG_ID,
	normalizeKernelRuntimeRunInsert,
	createKernelRuntimeDb,
	createContext,
	createKernelRuntimeClient,
	childRuntimeEvent,
} from "./__tests__/kernel-runtime-db";

describe("kernel runtime router: child-evidence", () => {
	it("reads delegated child run evidence from the runtime owner ledger", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.runtimeEvents.push(
			{
				artifactId: null,
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:00:00.000Z",
				delta: null,
				id: "runtime-child-started",
				kind: "run.started",
				messageId: null,
				organizationId: ORG_ID,
				payload: { status: "running" },
				runId: "child-run-evidence",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-cpo",
				toolCallId: null,
			},
			{
				artifactId: "artifact-1",
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:01:00.000Z",
				delta: null,
				id: "runtime-child-artifact",
				kind: "artifact.created",
				messageId: null,
				organizationId: ORG_ID,
				payload: { text: "Evidence bundle ready" },
				runId: "child-run-evidence",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-cpo",
				toolCallId: null,
			},
			{
				artifactId: null,
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:02:00.000Z",
				delta: null,
				id: "runtime-child-completed",
				kind: "run.completed",
				messageId: null,
				organizationId: ORG_ID,
				payload: { status: "completed" },
				runId: "child-run-evidence",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-cpo",
				toolCallId: null,
			},
		);
		db.artifacts.push({
			accessClassification: "runtime_private",
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:01:00.000Z",
			id: "artifact-1",
			kind: "document",
			messageId: null,
			metadata: { source: "test" },
			mimeType: "text/markdown",
			name: "Evidence bundle",
			organizationId: ORG_ID,
			runId: "child-run-evidence",
			sizeBytes: 2048,
			tediId: "tedi-cpo",
			uri: "r2://tedix/evidence.md",
		});
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-parent-with-work-item",
				organizationId: ORG_ID,
				conversationId: "home:test",
				status: "running",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-run-evidence",
				metadata: {
					workItemId: "wi-child-evidence",
				},
			}),
		);

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-evidence",
			delegatedTediId: "tedi-cpo",
		});

		expect(result.evidence).toMatchObject({
			childRunId: "child-run-evidence",
			delegatedTediId: "tedi-cpo",
			workItemId: "wi-child-evidence",
			status: "completed",
			latestEventKind: "run.completed",
			terminalAt: "2026-06-06T08:02:00.000Z",
			terminalEventKind: "run.completed",
			control: {
				canStop: false,
				state: "terminal",
			},
		});
		expect(result.evidence.events.map((event) => event.id)).toEqual([
			"runtime-child-completed",
			"runtime-child-artifact",
			"runtime-child-started",
		]);
		expect(result.evidence.artifacts.map((artifact) => artifact.id)).toEqual([
			"artifact-1",
		]);
		expect(result.evidence.artifacts[0]?.uri).toBeUndefined();
		expect(result.evidence.artifacts[0]?.metadata).toBeUndefined();
	});

	it("does not expose child run evidence for a tedi outside the organization", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.tediRows.push({
			id: "tedi-outside",
			organizationId: "org-outside",
			runtimeKind: "agent",
		});

		await expect(
			client.readChildRunEvidence({
				childRunId: "outside-run",
				delegatedTediId: "tedi-outside",
			}),
		).rejects.toThrow("Delegated tedi not found");
	});

	it("returns workstation process log artifact rows as child run evidence", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.artifacts.push(
			{
				conversationId: "cto:agent:main:main",
				createdAt: "2026-06-06T08:03:00.000Z",
				id: "child-run-workstation:artifact:workstation_process:install-deps:evidence",
				kind: "log",
				messageId: null,
				metadata: {
					source: "workstation_process",
					subKind: "workstation_process",
					processId: "install-deps",
					refType: "evidence",
					traceId: "trace-workstation-1",
				},
				mimeType: "application/json",
				name: "workstation_process/install-deps/evidence.json",
				organizationId: ORG_ID,
				runId: "child-run-workstation",
				sizeBytes: null,
				tediId: "tedi-cto",
				uri: "r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/general/processes/install-deps/terminal/evidence.json",
			},
			{
				conversationId: "cto:agent:main:main",
				createdAt: "2026-06-06T08:02:00.000Z",
				id: "child-run-workstation:artifact:workstation_process:install-deps:stdout",
				kind: "log",
				messageId: null,
				metadata: {
					source: "workstation_process",
					subKind: "workstation_process",
					processId: "install-deps",
					refType: "stdout",
					traceId: "trace-workstation-1",
				},
				mimeType: "text/plain; charset=utf-8",
				name: "workstation_process/install-deps/stdout.log",
				organizationId: ORG_ID,
				runId: "child-run-workstation",
				sizeBytes: null,
				tediId: "tedi-cto",
				uri: "r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/general/processes/install-deps/terminal/stdout.log",
			},
		);

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-workstation",
			delegatedTediId: "tedi-cto",
		});

		expect(result.evidence.artifacts.map((artifact) => artifact.id)).toEqual([
			"child-run-workstation:artifact:workstation_process:install-deps:evidence",
			"child-run-workstation:artifact:workstation_process:install-deps:stdout",
		]);
		expect(result.evidence.artifacts[0]).toMatchObject({
			kind: "log",
			name: "workstation_process/install-deps/evidence.json",
			metadata: {
				source: "workstation_process",
				processId: "install-deps",
				refType: "evidence",
			},
		});
	});

	it("keeps child run evidence readable when runtime event reads flake", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.controls.childRuntimeSelectError = new Error(
			"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
		);
		db.artifacts.push({
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:01:00.000Z",
			id: "artifact-flaky-events",
			kind: "document",
			messageId: null,
			metadata: { source: "test" },
			mimeType: "text/markdown",
			name: "Evidence bundle",
			organizationId: ORG_ID,
			runId: "child-run-flaky-events",
			sizeBytes: 2048,
			tediId: "tedi-cpo",
			uri: "r2://tedix/evidence.md",
		});

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-flaky-events",
			delegatedTediId: "tedi-cpo",
		});

		expect(result.evidence).toMatchObject({
			childRunId: "child-run-flaky-events",
			delegatedTediId: "tedi-cpo",
			status: "queued",
			latestEventAt: null,
		});
		expect(result.evidence.events).toEqual([]);
		expect(result.evidence.artifacts.map((artifact) => artifact.id)).toEqual([
			"artifact-flaky-events",
		]);
	});

	it("keeps child run evidence readable when artifact reads flake", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.controls.artifactSelectError = new Error(
			"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
		);
		// Genuine completion: include message.completed so the disposition gate
		// reports completed even when artifact reads flake.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "runtime-flaky-artifacts-message",
				kind: "message.completed",
				payload: { role: "assistant", content: "Artifact run complete." },
				runId: "child-run-flaky-artifacts",
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:00.000Z",
				id: "runtime-flaky-artifacts-completed",
				kind: "run.completed",
				payload: { status: "completed" },
				runId: "child-run-flaky-artifacts",
				tediId: "tedi-cpo",
			}),
		);

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-flaky-artifacts",
			delegatedTediId: "tedi-cpo",
		});

		expect(result.evidence).toMatchObject({
			childRunId: "child-run-flaky-artifacts",
			delegatedTediId: "tedi-cpo",
			status: "completed",
			latestEventKind: "run.completed",
		});
		expect(result.evidence.events.map((event) => event.id)).toEqual([
			"runtime-flaky-artifacts-completed",
			"runtime-flaky-artifacts-message",
		]);
		expect(result.evidence.artifacts).toEqual([]);
	});

	it("surfaces workstation.egress.deny events stored under kernel run id as child run evidence", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		// The kernel delegation row: id is the kernel run id; childRunId is the
		// tedi-runtime run id. Egress events carry runId = kernelRunId (id), not
		// childRunId — that is the gap this fix addresses.
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "kernel-run-egress",
				organizationId: ORG_ID,
				conversationId: "home:test",
				status: "running",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-run-egress",
			}),
		);
		// Egress event recorded by tedi-workstation-runtime with runId = kernel run id.
		db.runtimeEvents.push({
			artifactId: null,
			approvalRequestId: null,
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:01:00.000Z",
			delta: null,
			id: "egress-deny-1",
			kind: "workstation.egress.deny",
			messageId: null,
			organizationId: ORG_ID,
			payload: {
				decision: "deny",
				host: "blocked.example.com",
				method: "GET",
				protocol: "https",
				reason: "not_in_allowlist",
				kernelRunId: "kernel-run-egress",
				workstationId: "ws-1",
				adapter: "cloudflare-sandbox-workstation",
				leaseId: null,
				profileId: null,
				traceBundleId: null,
				traceId: null,
				workItemId: null,
				containerId: "ws-1",
				className: "WorkstationDO",
				loggingMode: "all",
			},
			runId: "kernel-run-egress",
			runtimeBackend: "custom",
			runtimeExternalId: "ws-1",
			runtimeExternalUrl: null,
			runtimeMetadata: {
				adapter: "cloudflare-sandbox-workstation",
				kernelRunId: "kernel-run-egress",
				workstationId: "ws-1",
			},
			sequence: null,
			tediId: "tedi-cpo",
			toolCallId: null,
		});

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-egress",
			delegatedTediId: "tedi-cpo",
		});

		expect(result.evidence.events.map((event) => event.id)).toContain(
			"egress-deny-1",
		);
		const egressEvent = result.evidence.events.find(
			(event) => event.id === "egress-deny-1",
		);
		expect(egressEvent).toMatchObject({
			id: "egress-deny-1",
			kind: "workstation.egress.deny",
			payload: {
				decision: "deny",
				host: "blocked.example.com",
				reason: "not_in_allowlist",
			},
		});
	});
});
