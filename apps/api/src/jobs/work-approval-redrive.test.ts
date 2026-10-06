import { describe, expect, it } from "vite-plus/test";
import type { PendingTediWorkApproval } from "@tedix/db/queries/work-items/approvals";
import {
	assertWorkApprovalCapabilities,
	assertWorkApprovalWakeAccepted,
	buildWorkApprovalCapabilityRequest,
	buildWorkApprovalWakeRequest,
} from "./work-approval-redrive";

const candidate: PendingTediWorkApproval = {
	id: "proposal-1",
	orgId: "org-1",
	workItemId: "work-1",
	workItemVersion: 2,
	workItemTitle: "Repair widget query turns",
	authorityKey: "risk:high",
	proposal: { scope: "read-only widget query route" },
	requesterType: "external_agent",
	requesterId: "agent-1",
	approverId: "tedi-cto",
	rationale: "Bounded repair",
	expiresAt: "2026-09-03T00:00:00.000Z",
	version: 1,
};

describe("work approval redrive", () => {
	it("scopes a Home delegation approval to one dispatch in the wake text", async () => {
		const homeDelegation = buildWorkApprovalWakeRequest({
			candidate: {
				...candidate,
				authorityKey: "home_delegation",
				proposal: { kind: "home_delegation", homeRunId: "run-1" },
			},
			tediSlug: "cto",
			domain: "tedix.dev",
			nowMs: 600_000,
		});
		const text = ((await homeDelegation.json()) as { text: string }).text;
		expect(text).toContain(
			"authorizes this one dispatch only; it is not an entrustment, a standing grant, or a promotion",
		);
		const ordinary = buildWorkApprovalWakeRequest({
			candidate,
			tediSlug: "cto",
			domain: "tedix.dev",
			nowMs: 600_000,
		});
		expect(((await ordinary.json()) as { text: string }).text).not.toContain(
			"one dispatch only",
		);
	});

	it("wakes only the designated tedi with a deterministic decision request", async () => {
		const request = buildWorkApprovalWakeRequest({
			candidate,
			tediSlug: "cto",
			domain: "tedix.dev",
			nowMs: 600_000,
		});
		expect(request.headers.get("X-Tedix-Host")).toBe("cto.tedi.tedix.dev");
		const body = (await request.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			session_key: "work-approval:proposal-1:v1:e1",
			client_request_id: "work-approval:proposal-1:v1:e1",
			async: true,
			metadata: {
				source: "work_approval_redrive",
				proposalId: "proposal-1",
			},
		});
		// Approval wakes are ordinary tedi turns. A lone workItemId would be
		// mistaken for an incomplete Home-supervised authority context.
		expect(body.metadata).not.toHaveProperty("workItemId");
		expect(body.metadata).not.toHaveProperty("homeRunId");
		expect(body.text).toContain("Work Item work-1 version 2");
		expect(body.text).toContain("directly call decide_work_approval");
		expect(body.text).toContain("identity-bound native tools");
		expect(body.text).toContain(
			'list_work_approval_inbox({proposalId:"proposal-1",limit:1})',
		);
		expect(body.text).toContain("admissionSpecification resources/budget");
		expect(body.text).toContain("do not approve the stale proposal");
		expect(body.text).toContain("do not approve by default");
		expect(body.text).toContain("Do not ask a human");
	});

	it("deduplicates a retry window and rotates after a terminal failure window", async () => {
		const wake = async (nowMs: number, version = 1) => {
			const request = buildWorkApprovalWakeRequest({
				candidate: { ...candidate, version },
				tediSlug: "cto",
				domain: "tedix.dev",
				nowMs,
			});
			return (await request.json()) as {
				session_key: string;
				client_request_id: string;
			};
		};
		const first = await wake(600_000);
		expect(await wake(1_199_999)).toMatchObject(first);
		expect((await wake(1_200_000)).session_key).not.toBe(first.session_key);
		expect((await wake(600_000, 2)).client_request_id).not.toBe(
			first.client_request_id,
		);
		expect(first.client_request_id).toBe(first.session_key);
	});

	it("preflights the exact native admission approval tools", async () => {
		const request = buildWorkApprovalCapabilityRequest({
			tediSlug: "cto",
			domain: "tedix.dev",
		});
		expect(request.url).toBe("https://tedi/hooks/review-capabilities");
		expect(request.headers.get("X-Tedix-Host")).toBe("cto.tedi.tedix.dev");
		await expect(
			assertWorkApprovalCapabilities(
				Response.json({
					nativeTools: ["list_work_approval_inbox", "decide_work_approval"],
				}),
			),
		).resolves.toBeUndefined();
		await expect(
			assertWorkApprovalCapabilities(
				Response.json({ nativeTools: ["list_work_approval_inbox"] }),
			),
		).rejects.toThrow("decide_work_approval");
	});

	it("counts only a durable accepted runtime run as dispatched", async () => {
		await expect(
			assertWorkApprovalWakeAccepted(
				Response.json({ accepted: true, run_id: "run-1" }, { status: 202 }),
			),
		).resolves.toEqual({ runId: "run-1" });
		await expect(
			assertWorkApprovalWakeAccepted(
				Response.json({ success: true, ok: true, run_id: "run-1" }),
			),
		).resolves.toEqual({ runId: "run-1" });
		await expect(
			assertWorkApprovalWakeAccepted(
				Response.json({ accepted: true }, { status: 202 }),
			),
		).rejects.toThrow("durable run_id");
		await expect(
			assertWorkApprovalWakeAccepted(
				Response.json(
					{ accepted: false, canceled: true, run_id: "run-1" },
					{ status: 202 },
				),
			),
		).rejects.toThrow("Ambiguous");
	});
});
