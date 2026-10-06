import * as z from "zod";
import {
	JsonValueSchema,
	type JsonValue,
} from "@tedix/api-contract/schemas/common";
import type { AuthPrincipal } from "./principal";
import { hasScope } from "./scopes";

export const DURABLE_CODE_DELEGATION_HEADER =
	"X-Tedix-Auth-Durable-Code-Delegation";
const MAX_LIFETIME_MS = 60_000;
const CLOCK_SKEW_MS = 5_000;
const operationSchema = z.enum([
	"run_durable_code",
	"list_code_executions",
	"get_code_execution",
	"approve_code_execution",
	"reject_code_execution",
	"rollback_code_execution",
	"recover_code_execution",
]);
export type DurableCodeOperation = z.infer<typeof operationSchema>;

/** Classification must come from the owning API authentication layer. Email
 * and a human-shaped subject alone do not distinguish external-agent tokens. */
export interface DurableCodeCaller {
	classification:
		| "human"
		| "external-agent"
		| "tedi"
		| "m2m"
		| "service"
		| "api-key";
	/** orgId must be the canonical UUID resolved by API auth from live membership
	 * and the selected organization; never copy the JWT's Descope tenant id. */
	principal: AuthPrincipal;
}
export interface DurableCodeRequestBinding {
	tediId: string;
	organizationId: string;
	operation: DurableCodeOperation;
	/** The owning operation must validate/default its arguments before calling. */
	arguments: JsonValue;
}
const envelopeSchema = z.strictObject({
	version: z.literal(1),
	issuer: z.literal("tedix-api"),
	audience: z.literal("tedi-runtime"),
	tediId: z.uuid(),
	organizationId: z.uuid(),
	operation: operationSchema,
	argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/),
	operator: z.union([
		z.strictObject({
			classification: z.literal("human"),
			subject: z.string().min(1).max(256),
			email: z.email().max(320),
		}),
		z.strictObject({
			classification: z.enum([
				"external-agent",
				"tedi",
				"m2m",
				"service",
				"api-key",
			]),
			subject: z.string().min(1).max(256),
		}),
	]),
	capability: z.enum(["mcp:tedis.read", "mcp:tedis.write", "mcp:tedis.admin"]),
	issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type DurableCodeDelegation = z.infer<typeof envelopeSchema>;

export function requiredDurableCodeCapability(
	operation: DurableCodeOperation,
): DurableCodeDelegation["capability"] {
	operationSchema.parse(operation);
	if (
		operation === "list_code_executions" ||
		operation === "get_code_execution"
	)
		return "mcp:tedis.read";
	if (operation === "run_durable_code") return "mcp:tedis.write";
	return "mcp:tedis.admin";
}

/** Machines may run/read under their own admitted identity; they never acquire
 * the human lifecycle-resolution authority carried by the operator envelope. */
export async function createMachineDurableCodeDelegation(
	input: DurableCodeRequestBinding & {
		caller: DurableCodeCaller;
		now: number;
		lifetimeMs?: number;
	},
): Promise<DurableCodeDelegation> {
	const { principal } = input.caller;
	const classification = input.caller.classification;
	const capability = requiredDurableCodeCapability(input.operation);
	const expectedSource = {
		"external-agent": ["service-binding"],
		tedi: ["tedi-jwt", "service-binding"],
		m2m: ["aih-m2m"],
		service: ["service-binding"],
		"api-key": ["api-key"],
	} as const;
	if (
		classification === "human" ||
		capability === "mcp:tedis.admin" ||
		!principal.authenticated ||
		principal.verified !== true ||
		!principal.subject ||
		principal.orgId !== input.organizationId ||
		!(expectedSource[classification] as readonly string[]).includes(
			principal.source,
		) ||
		(classification === "tedi" && !principal.tediId) ||
		(classification !== "tedi" && !!principal.tediId) ||
		(["external-agent", "m2m", "service"].includes(classification) &&
			!principal.clientId) ||
		!hasScope(principal.scopes, capability)
	)
		throw new Error(
			"Verified machine identity, organization ownership and read/write permission are required",
		);
	const lifetimeMs = input.lifetimeMs ?? MAX_LIFETIME_MS;
	if (
		!Number.isSafeInteger(lifetimeMs) ||
		lifetimeMs <= 0 ||
		lifetimeMs > MAX_LIFETIME_MS
	)
		throw new Error("Invalid delegation lifetime");
	return envelopeSchema.parse({
		version: 1,
		issuer: "tedix-api",
		audience: "tedi-runtime",
		tediId: input.tediId,
		organizationId: input.organizationId,
		operation: input.operation,
		argumentsDigest: await digestArguments(input.arguments),
		operator: { classification, subject: principal.subject },
		capability,
		issuedAt: input.now,
		expiresAt: input.now + lifetimeMs,
	});
}
function orderedJson(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(orderedJson);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, orderedJson(value[key]!)]),
		);
	return value;
}
function rejectUnsafeJsonKeys(
	value: JsonValue,
	ancestors = new Set<object>(),
): void {
	if (!value || typeof value !== "object") return;
	if (ancestors.has(value)) throw new Error("Cyclic delegation arguments");
	if (Object.hasOwn(value, "__proto__"))
		throw new Error("Unsafe delegation argument key: __proto__");
	ancestors.add(value);
	for (const child of Object.values(value))
		rejectUnsafeJsonKeys(child, ancestors);
	ancestors.delete(value);
}
async function digestArguments(value: JsonValue): Promise<string> {
	// Shared record parsing drops __proto__; reject it before parsing so distinct
	// requests cannot acquire the same digest through silent key removal.
	rejectUnsafeJsonKeys(value);
	const bytes = new TextEncoder().encode(
		JSON.stringify(orderedJson(JsonValueSchema.parse(value))),
	);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Creates request-binding provenance after the owning API's policy and row
 * ownership checks. This is neither authentication nor a signed/one-use grant. */
export async function createDurableCodeDelegation(
	input: DurableCodeRequestBinding & {
		caller: DurableCodeCaller;
		now: number;
		lifetimeMs?: number;
	},
): Promise<DurableCodeDelegation> {
	const { principal } = input.caller;
	const capability = requiredDurableCodeCapability(input.operation);
	if (
		input.caller.classification !== "human" ||
		!principal.authenticated ||
		principal.verified !== true ||
		!["user-jwt", "aih-oauth"].includes(principal.source) ||
		principal.tediId ||
		!principal.subject ||
		!principal.email ||
		principal.orgId !== input.organizationId ||
		!hasScope(principal.scopes, capability)
	) {
		throw new Error(
			"Verified human identity, organization ownership and operation permission are required",
		);
	}
	const lifetimeMs = input.lifetimeMs ?? MAX_LIFETIME_MS;
	if (
		!Number.isSafeInteger(lifetimeMs) ||
		lifetimeMs <= 0 ||
		lifetimeMs > MAX_LIFETIME_MS
	)
		throw new Error("Invalid delegation lifetime");
	return envelopeSchema.parse({
		version: 1,
		issuer: "tedix-api",
		audience: "tedi-runtime",
		tediId: input.tediId,
		organizationId: input.organizationId,
		operation: input.operation,
		argumentsDigest: await digestArguments(input.arguments),
		operator: {
			classification: "human",
			subject: principal.subject,
			email: principal.email,
		},
		capability,
		issuedAt: input.now,
		expiresAt: input.now + lifetimeMs,
	});
}
export type DurableCodeDelegationVerification =
	| { ok: true; delegation: DurableCodeDelegation }
	| {
			ok: false;
			reason:
				| "untrusted_transport"
				| "invalid_envelope"
				| "invalid_time"
				| "binding_mismatch";
	  };

/** Only a named internal binding may establish provenance. The integration
 * must derive transport from its ingress, never from a public header. An
 * envelope can be reused within its lifetime; no replay protection is claimed. */
export async function verifyDurableCodeDelegation(
	input: DurableCodeRequestBinding & {
		transport: "trusted-service-binding" | "public";
		envelope: unknown;
		now: number;
	},
): Promise<DurableCodeDelegationVerification> {
	if (input.transport !== "trusted-service-binding")
		return { ok: false, reason: "untrusted_transport" };
	const parsed = envelopeSchema.safeParse(input.envelope);
	if (!parsed.success) return { ok: false, reason: "invalid_envelope" };
	const envelope = parsed.data;
	if (
		!Number.isSafeInteger(input.now) ||
		input.now < 0 ||
		envelope.issuedAt > input.now + CLOCK_SKEW_MS ||
		envelope.expiresAt <= input.now ||
		envelope.expiresAt <= envelope.issuedAt ||
		envelope.expiresAt - envelope.issuedAt > MAX_LIFETIME_MS
	)
		return { ok: false, reason: "invalid_time" };
	try {
		if (
			(envelope.operator.classification !== "human" &&
				envelope.capability === "mcp:tedis.admin") ||
			envelope.tediId !== input.tediId ||
			envelope.organizationId !== input.organizationId ||
			envelope.operation !== input.operation ||
			envelope.capability !== requiredDurableCodeCapability(input.operation) ||
			envelope.argumentsDigest !== (await digestArguments(input.arguments))
		)
			return { ok: false, reason: "binding_mismatch" };
	} catch {
		return { ok: false, reason: "binding_mismatch" };
	}
	return { ok: true, delegation: envelope };
}
