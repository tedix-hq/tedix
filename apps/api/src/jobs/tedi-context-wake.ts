import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { buildRuntimeRunId } from "@tedix/api-contract/utils/runtime-identity";
import type { DbClient } from "@tedix/db/client";
import { listTediRuntimeEvents } from "@tedix/db/queries/kernel-runtime-events";
import { assertWorkApprovalWakeAccepted } from "./work-approval-redrive";
import { CALLER_TRUST_HEADER } from "@tedix/mcp-shared/auth/caller-trust";

export function buildTediContextWakeRequest(
	slug: string,
	environment: string,
	body: {
		session_key: string;
		client_request_id: string;
		metadata: Record<string, JsonValue>;
		text: string;
	},
): Request {
	return new Request("https://tedi/hooks/inject", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Tedix-Host": `${slug}.tedi.${environment === "production" ? "tedix.dev" : "tedix.tech"}`,
			"X-Service-Binding": "true",
			[CALLER_TRUST_HEADER]: "member",
		},
		body: JSON.stringify({ ...body, async: true }),
	});
}

/** A worker outcome cannot revoke delivery of an already acknowledged context wake. */
export async function deliverTediContextWake(
	db: DbClient,
	input: {
		orgId: string;
		tediId: string;
		request: Request;
		send: (request: Request) => Promise<Response>;
	},
): Promise<{ runId: string; deduplicated: boolean }> {
	const body = (await input.request.clone().json()) as {
		client_request_id: string;
	};
	const runId = buildRuntimeRunId({
		tediId: input.tediId,
		turnKey: body.client_request_id,
		surface: "mcp",
	});
	const acknowledged = async () =>
		(
			await listTediRuntimeEvents(db, {
				organizationId: input.orgId,
				tediId: input.tediId,
				runId,
				kinds: ["run.started", "run.completed", "run.failed", "run.canceled"],
				limit: 1,
			})
		).length > 0;
	if (await acknowledged()) return { runId, deduplicated: true };
	try {
		return {
			...(await assertWorkApprovalWakeAccepted(
				await input.send(input.request),
			)),
			deduplicated: false,
		};
	} catch (error) {
		// A concurrent delivery or lost response may have committed the ingress receipt.
		if (await acknowledged()) return { runId, deduplicated: true };
		throw error;
	}
}
