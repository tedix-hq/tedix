import { describe, expect, it } from "vite-plus/test";
import type { TediApprovalRequest } from "@tedix/db/schema/approvals";
import {
	browserTakeoverWakeRequest,
	isSameBrowserTakeover,
} from "./browser-takeover";

const approval = {
	id: "approval-1",
	tediId: "worker-1",
	orgId: "org-example",
	actionType: "browser.live_view_takeover",
	status: "approved",
	payload: {
		kind: "browser_live_view_takeover",
		sessionId: "browser-1",
		sessionKey: "console-task",
	},
} as TediApprovalRequest;
const tedi = { slug: "example-worker", organizationId: "org-example" };

describe("browser takeover continuation", () => {
	it("wakes the original session with a stable idempotency key and no login data", async () => {
		const wake = browserTakeoverWakeRequest(approval, tedi, "tedix.test")!;
		expect(wake.url).toBe("https://tedi/hooks/inject");
		expect(wake.headers.get("X-Tedix-Host")).toBe(
			"example-worker.tedi.tedix.test",
		);
		expect(wake.headers.get("X-Tedix-Caller-Trust")).toBe("member");
		const body = await wake.json();
		expect(body).toMatchObject({
			session_key: "console-task",
			client_request_id: "browser-takeover:approval-1:approved",
			async: true,
		});
		expect(body.text).toContain("get_browser_takeover_status");
		expect(body.text).toContain("continuationReady");
		expect(
			await browserTakeoverWakeRequest(approval, tedi, "tedix.test")!.json(),
		).toEqual(body);
	});
	it.each(["pending", "cancelled", "rejected", "expired"])(
		"does not resume a %s takeover",
		(status) => {
			expect(
				browserTakeoverWakeRequest({ ...approval, status }, tedi, "tedix.test"),
			).toBeNull();
		},
	);
	it("cannot wake another organization or guess a missing session", () => {
		expect(() =>
			browserTakeoverWakeRequest(
				approval,
				{ ...tedi, organizationId: "other-org" },
				"tedix.test",
			),
		).toThrow();
		expect(() =>
			browserTakeoverWakeRequest(
				{ ...approval, payload: { kind: "browser_live_view_takeover" } },
				tedi,
				"tedix.test",
			),
		).toThrow();
	});
	it("recovers an existing takeover's session from its canonical conversation", async () => {
		const wake = browserTakeoverWakeRequest(
			{
				...approval,
				payload: {
					kind: "browser_live_view_takeover",
					conversationId: "example-worker:console-task",
				},
			},
			tedi,
			"tedix.test",
		)!;
		expect((await wake.json()).session_key).toBe("console-task");
	});
});

describe("takeover replacement scope", () => {
	it.each(["pending", "approved", "cancelled", "expired", "rejected"])(
		"permits a fresh request for the same session after %s",
		(status) => {
			expect(isSameBrowserTakeover({ ...approval, status }, approval)).toBe(
				true,
			);
		},
	);
	it("rejects other organizations, tedis, sessions and approval kinds", () => {
		for (const change of [
			{ orgId: "other-org" },
			{ tediId: "other-worker" },
			{ actionType: "deploy" },
			{ payload: { ...approval.payload, sessionId: "browser-2" } },
		]) {
			expect(isSameBrowserTakeover(approval, { ...approval, ...change })).toBe(
				false,
			);
		}
	});
});
