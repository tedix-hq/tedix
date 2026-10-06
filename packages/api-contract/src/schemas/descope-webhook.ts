/**
 * Descope Webhook Schemas
 * Zod schemas for Descope Audit Webhook event ingestion
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

// =============================================================================
// DESCOPE AUDIT EVENT SCHEMA
// =============================================================================

/**
 * Single Descope audit event as received from the webhook connector.
 * Based on Descope Audit Webhook documentation.
 */
export const DescopeAuditEventSchema = z.object({
	/** Action name, e.g. "LoginSucceed", "UserCreated", "RoleModified" */
	action: z.string(),
	/** ID of the actor who performed the action (Descope user ID or management key ID) */
	actorId: z.string().optional(),
	/** Target user ID (for user-targeted events) */
	userId: z.string().optional(),
	/** Webhook event time in Unix milliseconds (Search Audit uses a different wire type). */
	occurred: z
		.number()
		.finite()
		.min(-8_640_000_000_000_000)
		.max(8_640_000_000_000_000),
	projectId: z
		.string()
		.optional()
		.describe(
			"Descope project context when supplied; not tenant authorization.",
		),
	occurred_formatted: z
		.string()
		.optional()
		.describe(
			"Optional provider-formatted timestamp; numeric occurred remains authoritative.",
		),
	/** Device info */
	device: z.string().optional(),
	/** Auth method (e.g. "otp", "password", "sso") */
	method: z.string().optional(),
	/** Client IP address */
	remoteAddress: z.string().optional(),
	/** Login IDs associated with the user */
	loginIds: z.array(z.string()).optional(),
	/** Descope tenant IDs associated with the event */
	tenants: z
		.array(z.string())
		.nullable()
		.optional()
		.describe(
			"Associated tenant IDs, null or absent for project-level events.",
		),
	/** Action-specific data */
	data: z.record(z.string(), JsonValueSchema).optional(),
	/** Geo location info */
	geo: z.string().optional(),
});

export type DescopeAuditEvent = z.infer<typeof DescopeAuditEventSchema>;

/** Descope posts an array, including singleton deliveries; at most 100 events. */
export const DescopeAuditBatchSchema = z
	.array(DescopeAuditEventSchema)
	.max(100);
