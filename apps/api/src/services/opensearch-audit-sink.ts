import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { ActionReceipt } from "@tedix/api-contract/utils/action-receipt";
import { stableStringify } from "@tedix/api-contract/utils/stable-json";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
	/(?:authorization|body|budget|confidential|content|cookie|credential|password|private.?key|prompt|secret|token|api.?key)/i;
const SENSITIVE_VALUE =
	/(?:bearer\s+[a-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|pk)_(?:live|test)_[a-z0-9_-]+)/i;
const INDEX_NAME = /^[a-z0-9][a-z0-9._-]{0,254}$/;

export interface OpenSearchAuditSinkEnv {
	AUDIT_OPENSEARCH_ENABLED?: string;
	AUDIT_OPENSEARCH_ENDPOINT?: string;
	AUDIT_OPENSEARCH_INDEX?: string;
	AUDIT_OPENSEARCH_AUTHORIZATION?: string;
}

export type OpenSearchAuditSinkConfig =
	| { enabled: false }
	| {
			enabled: true;
			endpoint: string;
			index: string;
			authorization?: string;
	  };

export interface AuditVerifierAttribution {
	type: "tedix" | "user" | "tedi" | "external_agent" | "service";
	id: string;
	sessionId?: string;
	method: string;
}

export interface AuditActionEventInput {
	id: string;
	sequence: number;
	previousDigest: string | null;
	occurredAt: string;
	tenantId: string;
	actor: {
		type: string;
		id: string;
		sessionId?: string;
	};
	workItemId: string;
	attemptId: string;
	externalIdentity?: {
		principalId: string;
		sessionId: string;
	};
	approval?: {
		requestId: string;
		status: string;
		resolvedBy?: string;
	};
	verifier: AuditVerifierAttribution;
	receipt: ActionReceipt & { id: string };
	metadata?: Record<string, JsonValue>;
}

export interface AuditActionEvent extends AuditActionEventInput {
	schemaVersion: 1;
	evidenceKind: "derivative_export";
	metadata: Record<string, JsonValue>;
	digest: string;
}

export interface AuditExportCheckpoint {
	sequence: number;
	digest: string | null;
	consecutiveFailures: number;
}

export type AuditExportResult =
	| { status: "disabled"; checkpoint: AuditExportCheckpoint }
	| {
			status: "delivered";
			checkpoint: AuditExportCheckpoint;
			delivered: number;
	  }
	| {
			status: "gap";
			checkpoint: AuditExportCheckpoint;
			expectedSequence: number;
			observedSequence: number;
	  }
	| {
			status: "tampered";
			checkpoint: AuditExportCheckpoint;
			sequence: number;
			reason: "digest_mismatch" | "chain_mismatch";
	  }
	| {
			status: "retry";
			checkpoint: AuditExportCheckpoint;
			sequence: number;
			retryAfterMs: number;
			errorCode: "network" | `http_${number}`;
	  };

type Fetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export function openSearchAuditSinkConfig(
	env: OpenSearchAuditSinkEnv,
): OpenSearchAuditSinkConfig {
	if (env.AUDIT_OPENSEARCH_ENABLED !== "true") return { enabled: false };
	if (!env.AUDIT_OPENSEARCH_ENDPOINT || !env.AUDIT_OPENSEARCH_INDEX)
		throw new Error("OpenSearch audit sink configuration is incomplete");
	const endpoint = new URL(env.AUDIT_OPENSEARCH_ENDPOINT);
	if (
		endpoint.protocol !== "https:" ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash
	)
		throw new Error(
			"OpenSearch audit endpoint must be a credential-free HTTPS URL",
		);
	if (!INDEX_NAME.test(env.AUDIT_OPENSEARCH_INDEX))
		throw new Error("OpenSearch audit index is invalid");
	return {
		enabled: true,
		endpoint: endpoint.href.replace(/\/$/, ""),
		index: env.AUDIT_OPENSEARCH_INDEX,
		...(env.AUDIT_OPENSEARCH_AUTHORIZATION
			? { authorization: env.AUDIT_OPENSEARCH_AUTHORIZATION }
			: {}),
	};
}

function redact(value: JsonValue, key?: string, depth = 0): JsonValue {
	if (key && SENSITIVE_KEY.test(key)) return REDACTED;
	if (depth >= 8) return "[TRUNCATED]";
	if (typeof value === "string")
		return SENSITIVE_VALUE.test(value) ? REDACTED : value.slice(0, 2_000);
	if (Array.isArray(value))
		return value
			.slice(0, 100)
			.map((item) => redact(item, undefined, depth + 1));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([childKey, child]) => [
				childKey,
				redact(child, childKey, depth + 1),
			]),
		);
	return value;
}

async function sha256(value: unknown): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(stableStringify(value)),
	);
	return [...new Uint8Array(bytes)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function unsignedEvent(event: AuditActionEvent) {
	const { digest: _digest, ...unsigned } = event;
	return unsigned;
}

export async function sealAuditActionEvent(
	input: AuditActionEventInput,
): Promise<AuditActionEvent> {
	if (!Number.isSafeInteger(input.sequence) || input.sequence < 1)
		throw new Error("Audit action event sequence must be a positive integer");
	const unsigned = {
		...input,
		schemaVersion: 1 as const,
		evidenceKind: "derivative_export" as const,
		metadata: redact(input.metadata ?? {}) as Record<string, JsonValue>,
	};
	return { ...unsigned, digest: await sha256(unsigned) };
}

export async function deliverOpenSearchAuditEvents(
	config: OpenSearchAuditSinkConfig,
	events: readonly AuditActionEvent[],
	checkpoint: AuditExportCheckpoint,
	options: { fetch?: Fetch } = {},
): Promise<AuditExportResult> {
	if (!config.enabled) return { status: "disabled", checkpoint };
	const fetcher = options.fetch ?? fetch;
	let current = { ...checkpoint };
	let delivered = 0;

	for (const event of events) {
		if (event.sequence <= current.sequence) continue;
		const expectedSequence = current.sequence + 1;
		if (event.sequence !== expectedSequence)
			return {
				status: "gap",
				checkpoint: current,
				expectedSequence,
				observedSequence: event.sequence,
			};
		if (event.previousDigest !== current.digest)
			return {
				status: "tampered",
				checkpoint: current,
				sequence: event.sequence,
				reason: "chain_mismatch",
			};
		if ((await sha256(unsignedEvent(event))) !== event.digest)
			return {
				status: "tampered",
				checkpoint: current,
				sequence: event.sequence,
				reason: "digest_mismatch",
			};

		let response: Response;
		try {
			response = await fetcher(
				`${config.endpoint}/${config.index}/_create/${encodeURIComponent(event.id)}`,
				{
					method: "PUT",
					headers: {
						"content-type": "application/json",
						...(config.authorization
							? { authorization: config.authorization }
							: {}),
					},
					body: JSON.stringify(event),
					redirect: "error",
				},
			);
		} catch {
			const consecutiveFailures = current.consecutiveFailures + 1;
			return {
				status: "retry",
				checkpoint: { ...current, consecutiveFailures },
				sequence: event.sequence,
				retryAfterMs: Math.min(60_000, 1_000 * 2 ** (consecutiveFailures - 1)),
				errorCode: "network",
			};
		}
		if (!response.ok && response.status !== 409) {
			const consecutiveFailures = current.consecutiveFailures + 1;
			return {
				status: "retry",
				checkpoint: { ...current, consecutiveFailures },
				sequence: event.sequence,
				retryAfterMs: Math.min(60_000, 1_000 * 2 ** (consecutiveFailures - 1)),
				errorCode: `http_${response.status}`,
			};
		}
		current = {
			sequence: event.sequence,
			digest: event.digest,
			consecutiveFailures: 0,
		};
		delivered++;
	}

	return { status: "delivered", checkpoint: current, delivered };
}
