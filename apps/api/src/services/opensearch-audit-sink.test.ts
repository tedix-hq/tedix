import { describe, expect, it } from "vite-plus/test";
import {
	type AuditActionEvent,
	type AuditExportCheckpoint,
	deliverOpenSearchAuditEvents,
	openSearchAuditSinkConfig,
	sealAuditActionEvent,
} from "./opensearch-audit-sink";

const initialCheckpoint: AuditExportCheckpoint = {
	sequence: 0,
	digest: null,
	consecutiveFailures: 0,
};

function testEndpoint() {
	const documents = new Map<string, AuditActionEvent>();
	let available = true;
	let calls = 0;
	return {
		documents,
		setAvailable(value: boolean) {
			available = value;
		},
		get calls() {
			return calls;
		},
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			calls++;
			if (!available) return new Response(null, { status: 503 });
			const url = new URL(input.toString());
			expect(init?.method).toBe("PUT");
			expect(init?.redirect).toBe("error");
			expect(url.pathname).toMatch(/^\/tedix-audit-test\/_create\//);
			const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
			if (documents.has(id)) return new Response(null, { status: 409 });
			documents.set(id, JSON.parse(String(init?.body)) as AuditActionEvent);
			return Response.json({ result: "created" }, { status: 201 });
		},
	};
}

const config = openSearchAuditSinkConfig({
	AUDIT_OPENSEARCH_ENABLED: "true",
	AUDIT_OPENSEARCH_ENDPOINT: "https://opensearch.example.test",
	AUDIT_OPENSEARCH_INDEX: "tedix-audit-test",
	AUDIT_OPENSEARCH_AUTHORIZATION: "Basic test-only-credential",
});

async function event(
	sequence: number,
	previousDigest: string | null,
): Promise<AuditActionEvent> {
	return sealAuditActionEvent({
		id: `event-${sequence}`,
		sequence,
		previousDigest,
		occurredAt: `2026-11-04T22:0${sequence}:00.000Z`,
		tenantId: "tenant-fictional",
		actor: {
			type: "external_agent",
			id: "agent-fictional",
			sessionId: "session-fictional",
		},
		workItemId: "work-fictional",
		attemptId: "attempt-fictional",
		externalIdentity: {
			principalId: "principal-fictional",
			sessionId: "external-session-fictional",
		},
		approval: {
			requestId: "approval-fictional",
			status: "approved",
			resolvedBy: "owner-fictional",
		},
		verifier: {
			type: "tedix",
			id: "readback-verifier",
			sessionId: "verifier-session-fictional",
			method: "authorized_readback",
		},
		receipt: {
			id: `receipt-${sequence}`,
			operation: "work.add_comment",
			actor: "external_agent:agent-fictional",
			verified: true,
			url: "https://os.example.test/work/items/work-fictional",
			state: "accepted",
			checkedAt: `2026-11-04T22:0${sequence}:01.000Z`,
		},
		metadata: {
			outcome: "comment present",
			apiToken: "token-must-not-leak",
			confidentialBudget: "never export this",
			nested: { authorization: "Bearer must-not-leak" },
		},
	});
}

describe("OpenSearch audit sink", () => {
	it("is disabled unless explicitly enabled", async () => {
		const endpoint = testEndpoint();
		const result = await deliverOpenSearchAuditEvents(
			openSearchAuditSinkConfig({}),
			[await event(1, null)],
			initialCheckpoint,
			{ fetch: endpoint.fetch },
		);
		expect(result.status).toBe("disabled");
		expect(endpoint.calls).toBe(0);
	});

	it("exports append-only events with receipt and attribution correlation", async () => {
		const endpoint = testEndpoint();
		const first = await event(1, null);
		const result = await deliverOpenSearchAuditEvents(
			config,
			[first],
			initialCheckpoint,
			{ fetch: endpoint.fetch },
		);
		expect(result).toMatchObject({
			status: "delivered",
			delivered: 1,
			checkpoint: { sequence: 1, digest: first.digest },
		});
		const exported = endpoint.documents.get(first.id);
		expect(exported).toMatchObject({
			tenantId: "tenant-fictional",
			actor: { id: "agent-fictional", sessionId: "session-fictional" },
			workItemId: "work-fictional",
			attemptId: "attempt-fictional",
			externalIdentity: { principalId: "principal-fictional" },
			approval: {
				requestId: "approval-fictional",
				resolvedBy: "owner-fictional",
			},
			verifier: { id: "readback-verifier", method: "authorized_readback" },
			receipt: { id: "receipt-1", verified: true },
			evidenceKind: "derivative_export",
		});
		expect(exported?.metadata).toEqual({
			outcome: "comment present",
			apiToken: "[REDACTED]",
			confidentialBudget: "[REDACTED]",
			nested: { authorization: "[REDACTED]" },
		});
		expect(JSON.stringify(exported)).not.toContain("must-not-leak");
	});

	it("retries outages and accepts create conflicts as idempotent delivery", async () => {
		const endpoint = testEndpoint();
		const first = await event(1, null);
		const firstDelivery = await deliverOpenSearchAuditEvents(
			config,
			[first],
			initialCheckpoint,
			{ fetch: endpoint.fetch },
		);
		expect(firstDelivery.status).toBe("delivered");
		if (firstDelivery.status !== "delivered")
			throw new Error("delivery failed");
		const replay = await deliverOpenSearchAuditEvents(
			config,
			[first],
			initialCheckpoint,
			{ fetch: endpoint.fetch },
		);
		expect(replay).toMatchObject({
			status: "delivered",
			checkpoint: { sequence: 1, digest: first.digest },
		});

		const second = await event(2, first.digest);
		endpoint.setAvailable(false);
		const outage = await deliverOpenSearchAuditEvents(
			config,
			[second],
			firstDelivery.checkpoint,
			{ fetch: endpoint.fetch },
		);
		expect(outage).toMatchObject({
			status: "retry",
			sequence: 2,
			errorCode: "http_503",
			checkpoint: { sequence: 1, consecutiveFailures: 1 },
		});
		if (outage.status !== "retry") throw new Error("retry was not scheduled");
		endpoint.setAvailable(true);
		const recovered = await deliverOpenSearchAuditEvents(
			config,
			[second],
			outage.checkpoint,
			{ fetch: endpoint.fetch },
		);
		expect(recovered).toMatchObject({
			status: "delivered",
			checkpoint: { sequence: 2, consecutiveFailures: 0 },
		});
	});

	it("stops on explicit sequence gaps and tampering", async () => {
		const endpoint = testEndpoint();
		const first = await event(1, null);
		const checkpoint = {
			sequence: 1,
			digest: first.digest,
			consecutiveFailures: 0,
		};
		const third = await event(3, first.digest);
		const gap = await deliverOpenSearchAuditEvents(
			config,
			[third],
			checkpoint,
			{
				fetch: endpoint.fetch,
			},
		);
		expect(gap).toMatchObject({
			status: "gap",
			expectedSequence: 2,
			observedSequence: 3,
		});
		expect(endpoint.calls).toBe(0);

		const second = await event(2, first.digest);
		const modified = {
			...second,
			metadata: { ...second.metadata, outcome: "tampered after sealing" },
		};
		const tampered = await deliverOpenSearchAuditEvents(
			config,
			[modified],
			checkpoint,
			{ fetch: endpoint.fetch },
		);
		expect(tampered).toMatchObject({
			status: "tampered",
			sequence: 2,
			reason: "digest_mismatch",
		});
		expect(endpoint.calls).toBe(0);
	});
});
