import { describe, expect, it } from "vite-plus/test";
import {
	boundedArgsJson,
	buildDelegationFailureEnvelope,
	buildInternalServiceBindingContext,
	childRunStatusFromSummary,
	delegatedChildSteerRunId,
	homeRunProgress,
	isActiveHomeRunStatus,
	isMissingKernelRuntimeRunsTable,
	isMissingKernelRuntimeTable,
	isRemoteD1TransportError,
	isTerminalBlockerStatus,
	isTerminalHomeRunStatus,
	nextCursor,
	predictAgentRunId,
	resolveOrganizationId,
	sanitizeAgentTurnKey,
	shouldFailSoftChildEvidenceRead,
	shouldFailSoftHomeRunSetRead,
	shouldFailSoftKernelRuntimeRead,
	withTimeout,
} from "./runtime-shared";

describe("withTimeout", () => {
	it("resolves when the promise settles in time", async () => {
		await expect(withTimeout(Promise.resolve("ok"), 50, "fast")).resolves.toBe(
			"ok",
		);
	});

	it("rejects when the promise exceeds the deadline", async () => {
		await expect(
			withTimeout(new Promise(() => {}), 10, "slow"),
		).rejects.toThrow("slow timed out after 10ms");
	});

	it("leaves the dispatched child executable after the parent stops waiting", async () => {
		let startChild!: () => void;
		let childExecuted = false;
		const queuedChild = new Promise<void>((resolve) => {
			startChild = resolve;
		}).then(() => {
			childExecuted = true;
		});
		await expect(withTimeout(queuedChild, 1, "parent")).rejects.toThrow(
			"timed out",
		);
		expect(childExecuted).toBe(false);
		startChild();
		await queuedChild;
		expect(childExecuted).toBe(true);
	});
});

describe("D1 fail-soft classifiers", () => {
	const missingEvents = new Error("no such table: kernel_runtime_events");
	const missingRuns = new Error("no such table: kernel_runtime_runs");
	const connLost = new Error("D1_ERROR: Network connection lost");
	const unrelated = new Error("some other failure");

	it("detects the missing tables", () => {
		expect(isMissingKernelRuntimeTable(missingEvents)).toBe(true);
		expect(isMissingKernelRuntimeTable(missingRuns)).toBe(false);
		expect(isMissingKernelRuntimeRunsTable(missingRuns)).toBe(true);
		expect(isMissingKernelRuntimeRunsTable(missingEvents)).toBe(false);
	});

	const transport502 = new Error(
		"Failed query: select ... D1_ERROR: Failed to parse body as JSON, got: error code: 502",
	);

	it("classifies transient remote-D1 transport errors (both observed shapes)", () => {
		expect(isRemoteD1TransportError(connLost)).toBe(true);
		expect(isRemoteD1TransportError(transport502)).toBe(true);
		expect(isRemoteD1TransportError(unrelated)).toBe(false);
		// A 502-ish message WITHOUT the D1_ERROR marker is not a D1 transport flake.
		expect(
			isRemoteD1TransportError(
				new Error("Failed to parse body as JSON, got: error code: 502"),
			),
		).toBe(false);
	});

	it("composes the fail-soft decisions", () => {
		expect(shouldFailSoftKernelRuntimeRead(missingEvents)).toBe(true);
		expect(shouldFailSoftKernelRuntimeRead(connLost)).toBe(true);
		expect(shouldFailSoftKernelRuntimeRead(transport502)).toBe(true);
		expect(shouldFailSoftKernelRuntimeRead(missingRuns)).toBe(false);

		expect(shouldFailSoftHomeRunSetRead(missingRuns)).toBe(true);
		expect(shouldFailSoftHomeRunSetRead(connLost)).toBe(true);
		expect(shouldFailSoftHomeRunSetRead(transport502)).toBe(true);
		expect(shouldFailSoftHomeRunSetRead(missingEvents)).toBe(false);

		expect(shouldFailSoftChildEvidenceRead(connLost)).toBe(true);
		expect(shouldFailSoftChildEvidenceRead(transport502)).toBe(true);
		expect(shouldFailSoftChildEvidenceRead(missingEvents)).toBe(false);
	});
});

describe("child run status helpers", () => {
	it("passes through known child statuses", () => {
		expect(childRunStatusFromSummary({ childRunStatus: "running" })).toBe(
			"running",
		);
		expect(
			childRunStatusFromSummary({ childRunStatus: "requires_approval" }),
		).toBe("requires_approval");
	});

	it("defaults unknown/null summaries to queued", () => {
		expect(childRunStatusFromSummary({ childRunStatus: "mystery" })).toBe(
			"queued",
		);
		expect(childRunStatusFromSummary(null)).toBe("queued");
	});

	it("reads the delegated child steer inject run id", () => {
		const row = {
			metadata: {
				delegatedChildSteer: { childInjectRunId: "child-run-42" },
			},
		} as unknown as Parameters<typeof delegatedChildSteerRunId>[0];
		expect(delegatedChildSteerRunId(row)).toBe("child-run-42");

		const empty = {
			metadata: {},
		} as unknown as Parameters<typeof delegatedChildSteerRunId>[0];
		expect(delegatedChildSteerRunId(empty)).toBeNull();
	});
});

describe("home run status predicates", () => {
	it("classifies active statuses", () => {
		expect(isActiveHomeRunStatus("queued")).toBe(true);
		expect(isActiveHomeRunStatus("running")).toBe(true);
		expect(isActiveHomeRunStatus("requires_approval")).toBe(true);
		expect(isActiveHomeRunStatus("completed")).toBe(false);
	});

	it("classifies terminal statuses", () => {
		expect(isTerminalHomeRunStatus("completed")).toBe(true);
		expect(isTerminalHomeRunStatus("failed")).toBe(true);
		expect(isTerminalHomeRunStatus("canceled")).toBe(true);
		expect(isTerminalHomeRunStatus("running")).toBe(false);
	});

	it("classifies terminal blocker statuses", () => {
		expect(isTerminalBlockerStatus("completed")).toBe(true);
		expect(isTerminalBlockerStatus("cancelled")).toBe(true);
		expect(isTerminalBlockerStatus("accepted")).toBe(false);
		expect(isTerminalBlockerStatus("done")).toBe(false);
	});
});

describe("homeRunProgress", () => {
	it("carries the child's stop reason as the detail of a failed or partial run", () => {
		expect(
			homeRunProgress({
				eventCount: 40,
				status: "failed",
				stopDetail:
					"Stopped after 17 steps: per-turn cumulative input-token ceiling reached",
			}),
		).toEqual({
			current: 100,
			detail:
				"Stopped after 17 steps: per-turn cumulative input-token ceiling reached",
			label: "Failed",
			total: 100,
		});
		expect(
			homeRunProgress({
				eventCount: 40,
				status: "partial",
				stopDetail: "Stopped after 10 steps: provider-call ceiling reached",
			}),
		).toEqual({
			current: 100,
			detail:
				"Partial result — Stopped after 10 steps: provider-call ceiling reached; continuation required",
			label: "Partial",
			total: 100,
		});
	});

	it("prefers the live activity label for in-progress statuses", () => {
		expect(
			homeRunProgress({
				eventCount: 1,
				latestActivityLabel: "calling list_builds",
				status: "running",
			}),
		).toEqual({
			current: 48,
			detail: "calling list_builds",
			label: "Running",
			total: 100,
		});
	});
});

describe("nextCursor", () => {
	it("returns the last createdAt only when the page is full", () => {
		const rows = [{ createdAt: "a" }, { createdAt: "b" }];
		expect(nextCursor(rows, 2)).toBe("b");
		expect(nextCursor(rows, 5)).toBeNull();
	});
});

describe("resolveOrganizationId", () => {
	const ctx = (organizationId?: string) =>
		({ organizationId }) as unknown as Parameters<
			typeof resolveOrganizationId
		>[0];

	it("returns the requested org when it matches context", () => {
		expect(resolveOrganizationId(ctx("org-1"), "org-1")).toBe("org-1");
	});

	it("falls back to the context org", () => {
		expect(resolveOrganizationId(ctx("org-1"))).toBe("org-1");
	});

	it("throws when no org is resolvable", () => {
		expect(() => resolveOrganizationId(ctx(undefined))).toThrow();
	});

	it("throws when the requested org differs from context", () => {
		expect(() => resolveOrganizationId(ctx("org-1"), "org-2")).toThrow(
			"Use the authenticated organization UUID org-1, or omit organizationId to use the current scope. Organization slugs are not accepted here.",
		);
	});
});

describe("boundedArgsJson", () => {
	it("truncates oversized payloads with an ellipsis", () => {
		const big = boundedArgsJson({ value: "x".repeat(1000) }, 20);
		expect(big.endsWith("…")).toBe(true);
		expect(big.length).toBe(21);
	});

	it("never throws on unserializable arguments", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(boundedArgsJson(circular)).toBe("[unserializable arguments]");
	});
});

describe("sanitizeAgentTurnKey / predictAgentRunId", () => {
	it("rejects an empty turn key", () => {
		expect(() => sanitizeAgentTurnKey("   ")).toThrow();
	});

	it("predicts a stable mcp run id", () => {
		expect(
			predictAgentRunId({ clientRequestId: "req-1", tediId: "tedi-abc" }),
		).toBe("tedi-abc:mcp:req-1");
	});
});

describe("buildInternalServiceBindingContext", () => {
	it("stamps the service-binding identity, enqueue scope, and org header", () => {
		const base = {
			organizationId: "org-orig",
			authType: "user",
		} as unknown as Parameters<typeof buildInternalServiceBindingContext>[0];
		const result = buildInternalServiceBindingContext(base, "org-target");
		expect(result.organizationId).toBe("org-target");
		expect(result.authType).toBe("service-binding");
		expect(result.tediScopes).toEqual(["tedis:write"]);
		expect(result.headers.get("X-Service-Binding")).toBe("true");
		expect(result.headers.get("X-Tedix-Org-Id")).toBe("org-target");
	});

	it("drops the calling person's credentials and permissions", () => {
		// An approver's request dispatching someone else's delegation.
		const base = {
			organizationId: "org-orig",
			authType: "user",
			user: { sub: "approver-sub", permissions: ["os:approve"] },
			userId: "user-approver",
			userRole: "owner",
			userPermissionOverrides: ["secrets:manage"],
			crossTenantOverrideActive: true,
			oidcScopes: ["tedis:write"],
			factoryOperatorApproval: { requestId: "req-1", userId: "user-approver" },
			apiKey: { id: "key-1", organizationId: "org-orig", name: "k" },
			serviceAccount: { clientId: "client-1" },
			descopeUserId: "approver-sub",
		} as unknown as Parameters<typeof buildInternalServiceBindingContext>[0];
		const result = buildInternalServiceBindingContext(base, "org-orig");
		for (const field of [
			"user",
			"userId",
			"userRole",
			"userPermissionOverrides",
			"crossTenantOverrideActive",
			"oidcScopes",
			"factoryOperatorApproval",
			"apiKey",
			"serviceAccount",
		])
			expect(result).not.toHaveProperty(field);
		// Provenance only, never authority under a service binding.
		expect(result.descopeUserId).toBe("approver-sub");
	});
});

describe("buildDelegationFailureEnvelope", () => {
	it("marks transport dispatch failures retryable", () => {
		expect(
			buildDelegationFailureEnvelope({
				reason: "dispatch_failed",
				error: "Network connection lost.",
			}),
		).toEqual({
			ok: false,
			status: "failed",
			reason: "dispatch_failed",
			error: "Network connection lost.",
			retryable: true,
			childStillRunning: false,
		});
	});

	it("marks a preflight-unreachable runtime as not retryable", () => {
		const envelope = buildDelegationFailureEnvelope({
			reason: "runtime_unavailable",
			error: "tedi is stopped",
		});
		expect(envelope.retryable).toBe(false);
		expect(envelope.childStillRunning).toBe(false);
	});

	it("withholds retry advice while the child may still execute", () => {
		expect(
			buildDelegationFailureEnvelope({
				reason: "dispatch_failed",
				error: "timeout",
				childStillRunning: true,
			}).retryable,
		).toBe(false);
	});

	it("carries childStillRunning when the caller reports a live child", () => {
		expect(
			buildDelegationFailureEnvelope({
				reason: "dispatch_failed",
				error: "budget exceeded",
				childStillRunning: true,
			}).childStillRunning,
		).toBe(true);
	});
});
