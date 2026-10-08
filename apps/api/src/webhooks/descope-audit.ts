/**
 * Descope Audit Webhook Handler
 * Receives Descope audit events and writes them to the unified audit_events D1 table
 *
 * Security: HMAC-SHA256 signature verification via `x-descope-webhook-s256` header
 * Flow: Descope → Webhook → insertAuditEvent() → audit_events D1 table
 *
 * Event types include:
 * - LoginSucceed, LoginFailed (auth events)
 * - UserCreated, UserModified, UserDeleted (user lifecycle)
 * - RoleModified (RBAC changes)
 * - AccessKeyCreated, AccessKeyActivated, AccessKeyDeactivated (service keys)
 * - ConsentGiven, ConsentRevoked (consent management)
 * - TenantCreated, TenantModified (tenant lifecycle)
 *
 * @see https://docs.descope.com/connectors/connector-configuration-guides/network/audit-webhook
 */

import {
	DescopeAuditBatchSchema,
	type DescopeAuditEvent,
} from "@tedix/api-contract/schemas/descope-webhook";
import { createDbClient } from "@tedix/db/client";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { getOrganizationByDescopeId } from "@tedix/db/queries/organizations";
import { toJsonRecord } from "@tedix/db/utils/json";
import type { Context } from "hono";
import { timingSafeEqual } from "@tedix/worker-kit/crypto";
import { safeErrorMetadata } from "../lib/safe-log-metadata";

type DescopeFailureEvent =
	| "descope_audit.signature_verification_failed"
	| "descope_audit.ingestion_failed";

async function logDescopeFailure(
	event: DescopeFailureEvent,
	error: unknown,
): Promise<void> {
	try {
		console.error(
			JSON.stringify({ event, exception: await safeErrorMetadata(error) }),
		);
	} catch {
		// Diagnostic formatting must not change webhook denial or retry behavior.
		console.error(
			JSON.stringify({ event, exception: { kind: "unavailable" } }),
		);
	}
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Cached Descope tenant ID → organization ID mapping
 * Avoids repeated D1 lookups within a single webhook batch
 */
type OrgCache = Map<string, string | null>;

// =============================================================================
// ACTION → RESOURCE TYPE MAPPING
// =============================================================================

/**
 * Derive resourceType from the Descope action name.
 * Groups actions into logical resource categories for audit filtering.
 */
function deriveResourceType(action: string): string {
	const lower = action.toLowerCase();

	if (
		lower.includes("login") ||
		lower.includes("logout") ||
		lower.includes("otp") ||
		lower.includes("password") ||
		lower.includes("magiclink") ||
		lower.includes("enchantedlink") ||
		lower.includes("saml") ||
		lower.includes("oauth")
	) {
		return "session";
	}
	if (lower.includes("user")) return "user";
	if (lower.includes("role") || lower.includes("permission")) return "role";
	if (lower.includes("tenant")) return "tenant";
	if (lower.includes("accesskey")) return "access_key";
	if (lower.includes("consent")) return "consent";
	if (lower.includes("flow")) return "flow";

	return "unknown";
}

/**
 * Derive actorType from event context.
 * Management key actions are "service", login events are "user".
 */
function deriveActorType(
	event: DescopeAuditEvent,
): "user" | "service" | "anonymous" {
	// If the action relates to management operations and there's no userId context,
	// it's likely a management key (service) action
	const lower = event.action.toLowerCase();

	if (
		lower.includes("accesskey") ||
		lower.includes("role") ||
		lower.includes("permission") ||
		lower.includes("tenant")
	) {
		// Could be management key or admin user — check if actorId looks like a management key
		if (event.actorId && !event.userId) return "service";
	}

	if (event.actorId || event.userId) return "user";

	return "anonymous";
}

/**
 * Convert a Descope action name to a normalized audit action string.
 * E.g., "LoginSucceed" → "descope.login_succeed"
 */
function normalizeAction(action: string): string {
	// Convert PascalCase to snake_case
	const snaked = action
		.replace(/([A-Z])/g, "_$1")
		.toLowerCase()
		.replace(/^_/, ""); // Remove leading underscore

	return `descope.${snaked}`;
}

// =============================================================================
// EVENT → AUDIT ROW MAPPING
// =============================================================================

/**
 * Map a Descope audit event to our audit_events schema fields.
 */
function mapDescopeEvent(
	event: DescopeAuditEvent,
	organizationId: string,
): {
	organizationId: string;
	actorId: string;
	actorType: "user" | "service" | "anonymous";
	action: string;
	resourceType: string;
	resourceId: string | null;
	metadata: Record<string, unknown> | null;
	ipAddress: string | null;
} {
	const metadata: Record<string, unknown> = {};

	// Preserve all Descope-specific fields in metadata
	if (event.data) metadata.data = event.data;
	if (event.method) metadata.method = event.method;
	if (event.device) metadata.device = event.device;
	if (event.geo) metadata.geo = event.geo;
	if (event.loginIds && event.loginIds.length > 0)
		metadata.loginIds = event.loginIds;
	if (event.tenants && event.tenants.length > 0)
		metadata.tenants = event.tenants;
	if (event.projectId) metadata.projectId = event.projectId;
	if (event.occurred_formatted)
		metadata.occurred_formatted = event.occurred_formatted;

	return {
		organizationId,
		actorId: event.actorId || event.userId || "unknown",
		actorType: deriveActorType(event),
		action: normalizeAction(event.action),
		resourceType: deriveResourceType(event.action),
		resourceId: event.userId || null,
		metadata: Object.keys(metadata).length > 0 ? metadata : null,
		ipAddress: event.remoteAddress || null,
	};
}

// =============================================================================
// DESCOPE TENANT → ORG RESOLUTION
// =============================================================================

/**
 * Resolve Descope tenant ID to our D1 organization ID.
 * Uses a per-request cache to avoid duplicate lookups within a batch.
 */
async function resolveOrganizationId(
	db: ReturnType<typeof createDbClient>,
	descopeTenantId: string,
	cache: OrgCache,
): Promise<string | null> {
	if (cache.has(descopeTenantId)) {
		return cache.get(descopeTenantId) ?? null;
	}

	const org = await getOrganizationByDescopeId(db, descopeTenantId);
	const orgId = org?.id ?? null;
	cache.set(descopeTenantId, orgId);
	return orgId;
}

// =============================================================================
// HMAC VERIFICATION
// =============================================================================

/**
 * Verify Descope HMAC-SHA256 signature.
 *
 * Descope signs webhook payloads with HMAC-SHA256 and sends the signature
 * in the `x-descope-webhook-s256` header as a base64-encoded hash.
 */
async function verifyDescopeSignature(
	signature: string | undefined,
	body: string,
	secret: string,
): Promise<boolean> {
	if (!signature) {
		console.error("[Descope Webhook] Missing x-descope-webhook-s256 header");
		return false;
	}

	try {
		const encoder = new TextEncoder();
		const keyData = encoder.encode(secret);
		const messageData = encoder.encode(body);

		const key = await crypto.subtle.importKey(
			"raw",
			keyData,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);

		const sig = await crypto.subtle.sign("HMAC", key, messageData);
		const bytes = new Uint8Array(sig);
		let binary = "";
		for (const b of bytes) binary += String.fromCharCode(b);
		const expectedHash = btoa(binary);

		// Timing-safe comparison (both base64-encoded)
		return timingSafeEqual(signature, expectedHash);
	} catch (error) {
		await logDescopeFailure(
			"descope_audit.signature_verification_failed",
			error,
		);
		return false;
	}
}

/**
 * Maximum buffered body accepted before HMAC and JSON parsing. Content-Length
 * permits an early rejection; undeclared bodies are fully read before checking
 * their UTF-8 byte length. This does not bound allocation while reading them.
 */
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * Deterministic id for an audit event, used as the PK so redelivery collides
 * instead of duplicating.
 *
 * Dedup, NOT a ±5-minute timestamp window: this is an audit sink, where
 * dropping a late-but-genuine batch loses evidence permanently while a
 * duplicate only corrupts the trail. Rationale in docs/engineering/platform/auth.md.
 *
 * Hashes identity-bearing fields only, all inside the HMAC-signed body so they
 * cannot be varied without breaking the signature. `data`/`geo`/`device` are
 * excluded — descriptive, and a cosmetic diff would mint a "new" event.
 */
async function deterministicAuditEventId(
	organizationId: string,
	event: DescopeAuditEvent,
): Promise<string> {
	const identity = JSON.stringify([
		organizationId,
		event.action,
		event.occurred,
		event.actorId ?? "",
		event.userId ?? "",
		[...(event.tenants ?? [])].sort(),
		event.remoteAddress ?? "",
	]);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(identity),
	);
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	// Prefixed so a deterministic row is distinguishable from a random-UUID one
	// when auditing the audit log.
	return `descope-${hex.slice(0, 32)}`;
}

// =============================================================================
// WEBHOOK HANDLER
// =============================================================================

/**
 * Handle incoming Descope audit webhook events.
 *
 * Security:
 * 1. Reject declared oversize bodies before reading; check buffered body size
 *    before HMAC/JSON. Undeclared-body allocation is not bounded by this check.
 * 2. Verify HMAC-SHA256 signature from x-descope-webhook-s256 header over the
 *    RAW bytes (never a re-serialized parse)
 * 3. Reject requests with invalid/missing signatures
 * 4. Replay-protect by content-addressed primary key: a redelivered batch
 *    collides and is ignored rather than duplicating the audit trail
 *
 * Processing:
 * 1. Parse events array from webhook payload
 * 2. Resolve Descope tenant IDs to D1 organization IDs
 * 3. Map events to audit_events schema and insert
 * 4. Acknowledge only after persistence finishes; fail the request on storage errors
 */
export async function handleDescopeAuditWebhook(
	c: Context<{ Bindings: CloudflareEnv }>,
): Promise<Response> {
	const isDev = c.env.ENVIRONMENT === "development";

	try {
		// Step 0: Reject a declared oversize body before reading. Content-Length is a
		// cheap early reject; it is also attacker-controlled and absent under
		// chunked encoding, so the byte length of what we actually read is the
		// authority. Both are checked.
		const declaredLength = Number(c.req.header("content-length"));
		if (
			Number.isFinite(declaredLength) &&
			declaredLength > MAX_WEBHOOK_BODY_BYTES
		) {
			console.error(
				`[Descope Webhook] Rejected oversized body: content-length ${declaredLength} > ${MAX_WEBHOOK_BODY_BYTES}`,
			);
			return new Response("Payload Too Large", { status: 413 });
		}

		// Step 1: Read raw body for HMAC verification
		const rawBody = await c.req.text();
		const actualLength = new TextEncoder().encode(rawBody).byteLength;
		if (actualLength > MAX_WEBHOOK_BODY_BYTES) {
			console.error(
				`[Descope Webhook] Rejected oversized body: ${actualLength} bytes > ${MAX_WEBHOOK_BODY_BYTES}`,
			);
			return new Response("Payload Too Large", { status: 413 });
		}
		const signature = c.req.header("x-descope-webhook-s256");

		if (isDev) {
			console.log(
				`[Descope Webhook] Received event, signature present: ${!!signature}`,
			);
		}

		// Step 2: Verify HMAC — secret must be configured
		const secret = c.env.DESCOPE_WEBHOOK_SECRET;
		if (!secret) {
			console.error(
				"[Descope Webhook] DESCOPE_WEBHOOK_SECRET not configured — rejecting request",
			);
			return new Response("Internal Server Error", { status: 500 });
		}
		const isValid = await verifyDescopeSignature(signature, rawBody, secret);
		if (!isValid) {
			console.error("[Descope Webhook] Invalid HMAC signature");
			return new Response("Unauthorized", { status: 401 });
		}

		// Validate the complete signed provider batch before any database writes.
		let payload: unknown;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			return c.json({ ok: false, error: "Invalid JSON" }, 400);
		}
		const parsed = DescopeAuditBatchSchema.safeParse(payload);
		if (!parsed.success) {
			return c.json({ ok: false, error: "Invalid audit batch" }, 400);
		}
		const events = parsed.data;

		if (isDev) {
			console.log(`[Descope Webhook] Processing ${events.length} events`);
		}

		// Acknowledge only after the bounded batch has persisted.
		const db = createDbClient(c.env.DB);
		const orgCache: OrgCache = new Map();
		let processed = 0;
		let skipped = 0;

		for (const event of events) {
			// Resolve organization from Descope tenant IDs
			let organizationId: string | null = null;

			if (event.tenants && event.tenants.length > 0) {
				for (const tenantId of event.tenants) {
					organizationId = await resolveOrganizationId(db, tenantId, orgCache);
					if (organizationId) break;
				}
			}

			if (!organizationId) {
				// Tenantless/unmapped events are outside this tenant-scoped archive.
				skipped++;
				// Events without a resolvable org are logged but skipped
				// (e.g., super-admin actions, events before tenant assignment)
				if (isDev) {
					console.log(
						`[Descope Webhook] Skipping event ${event.action} — no org resolved from tenants: ${event.tenants?.join(", ") ?? "none"}`,
					);
				}
				continue;
			}

			const row = mapDescopeEvent(event, organizationId);

			// Content-addressed PK + DO NOTHING: a redelivered or replayed
			// batch collides and is dropped instead of duplicating the trail.
			await insertAuditEvent(db, {
				id: await deterministicAuditEventId(organizationId, event),
				ignoreDuplicates: true,
				organizationId: row.organizationId,
				actorId: row.actorId,
				actorType: row.actorType,
				action: row.action,
				resourceType: row.resourceType,
				resourceId: row.resourceId,
				metadata: row.metadata === null ? null : toJsonRecord(row.metadata),
				ipAddress: row.ipAddress,
				// Descope's own event time, not receipt time. Delivery is
				// delayed and batch-based, so receipt time would misdate the event.
				occurredAt: new Date(event.occurred),
			});

			processed++;
		}

		if (isDev) {
			console.log(
				`[Descope Webhook] Processed ${processed}/${events.length} events`,
			);
		}

		return c.json({ ok: true, processed, skipped }, 200);
	} catch (error) {
		await logDescopeFailure("descope_audit.ingestion_failed", error);
		// Earlier inserts survive; deterministic IDs make a full retry safe.
		// Never acknowledge a failed lookup or write as a successful delivery.
		return c.json({ ok: false, error: "Audit ingestion failed" }, 503);
	}
}
