/** Purpose-bound runtime application assertions. These do not attest a provider or independently observe a DO. */
import * as z from "zod";
import { JsonValueSchema } from "@tedix/api-contract/schemas/common";
import {
	ProviderExecutionIdentitySchema,
	ProviderExecutionOriginSchema,
	type ProviderExecutionOrigin,
} from "@tedix/api-contract/schemas/provider-execution";
import {
	BillingSettlementModeSchema,
	RuntimeEntitlementUsageSourceSchema,
} from "@tedix/api-contract/schemas/runtime-entitlements";
import {
	deriveHkdfHmacKey,
	hmacSha256,
	sha256Hex,
	timingSafeEqual,
} from "@tedix/worker-kit/crypto";

const PURPOSE = "tedix.runtime-inference-origin.v1";
const ISSUER = "tedix:tedi-runtime";
const AUDIENCE = "tedix:api/runtime-inference-admission";
const MAX_TOKEN_BYTES = 16_384;
const MAX_REQUEST_BYTES = 32_768;
const TTL_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;

/** Signed projection is deliberately independent of the signature and of the remote contract's activation. */
export const NativeInferenceRequestProjectionSchema = z.strictObject({
	organizationId: z.string().min(1),
	tediId: z.string().min(1).nullable().default(null),
	settlementMode: BillingSettlementModeSchema,
	source: RuntimeEntitlementUsageSourceSchema,
	execution: ProviderExecutionIdentitySchema,
	workItemId: z.string().max(300).nullable(),
	estimatedInputTokens: z.number().int().min(0).max(10_000_000),
	estimatedOutputTokens: z.number().int().min(0).max(2_000_000),
	runId: z.string().max(300).nullable().default(null),
	traceId: z.string().max(300).nullable().default(null),
	idempotencyKey: z.string().min(8).max(300),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});
export type NativeInferenceRequestProjection = z.infer<
	typeof NativeInferenceRequestProjectionSchema
>;
const EnvelopeSchema = z.strictObject({
	purpose: z.literal(PURPOSE),
	issuer: z.literal(ISSUER),
	audience: z.literal(AUDIENCE),
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
	origin: ProviderExecutionOriginSchema,
	issuedAt: z.number().int().nonnegative().safe(),
	expiresAt: z.number().int().positive().safe(),
	nonce: z.uuid(),
});
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => [k, canonical(v)]),
		);
	return value;
}
function bounded(value: string, limit: number): string {
	if (new TextEncoder().encode(value).byteLength > limit)
		throw new Error("Runtime inference assertion exceeds its bound");
	return value;
}
function b64url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}
function signatureHex(value: Uint8Array): string {
	return Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function signature(secret: string, payload: string): Promise<string> {
	if (!secret)
		throw new Error("Runtime inference assertion requires a signing secret");
	return signatureHex(
		await hmacSha256(await deriveHkdfHmacKey(secret, PURPOSE), payload),
	);
}
function bindOrigin(
	request: NativeInferenceRequestProjection,
	origin: ProviderExecutionOrigin,
): void {
	if (
		request.organizationId !== origin.root.owner.orgId ||
		request.tediId !== origin.root.owner.tediId ||
		(origin.kind === "accepted_native" &&
			request.runId !== origin.root.accepted.runId)
	)
		throw new Error(
			"Runtime inference assertion owner or original run differs",
		);
}
async function requestHash(
	request: unknown,
): Promise<{ request: NativeInferenceRequestProjection; hash: string }> {
	const parsed = NativeInferenceRequestProjectionSchema.parse(request);
	return {
		request: parsed,
		hash: await sha256Hex(
			bounded(JSON.stringify(canonical(parsed)), MAX_REQUEST_BYTES),
		),
	};
}
/** A retry may reuse this assertion only for the exact original request; admission preserves its original receipt. */
export async function signRuntimeInferenceOrigin(input: {
	secret: string;
	request: unknown;
	origin: unknown;
	nowMs?: number;
}): Promise<string> {
	const { request, hash } = await requestHash(input.request);
	const origin = ProviderExecutionOriginSchema.parse(input.origin);
	bindOrigin(request, origin);
	const issuedAt = Math.floor((input.nowMs ?? Date.now()) / 1000);
	const envelope = EnvelopeSchema.parse({
		purpose: PURPOSE,
		issuer: ISSUER,
		audience: AUDIENCE,
		requestHash: hash,
		origin,
		issuedAt,
		expiresAt: issuedAt + TTL_SECONDS,
		nonce: crypto.randomUUID(),
	});
	const payload = b64url(bounded(JSON.stringify(envelope), MAX_TOKEN_BYTES));
	return bounded(
		`${payload}.${await signature(input.secret, payload)}`,
		MAX_TOKEN_BYTES,
	);
}
/** Signature proves this trusted application's assertion, not fresh custody outside that application. */
export async function verifyRuntimeInferenceOrigin(input: {
	secret: string;
	request: unknown;
	token: string;
	nowMs?: number;
}): Promise<ProviderExecutionOrigin> {
	bounded(input.token, MAX_TOKEN_BYTES);
	const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(input.token);
	if (
		!match ||
		!timingSafeEqual(match[2]!, await signature(input.secret, match[1]!))
	)
		throw new Error("Invalid runtime inference assertion signature");
	const payload = Buffer.from(match[1]!, "base64url").toString("utf8");
	if (b64url(payload) !== match[1])
		throw new Error("Noncanonical runtime inference assertion encoding");
	const envelope = EnvelopeSchema.parse(JSON.parse(payload));
	const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
	if (!Number.isSafeInteger(now) || now < 0)
		throw new Error("Invalid runtime inference assertion verification time");
	if (
		envelope.issuedAt > now + CLOCK_SKEW_SECONDS ||
		now >= envelope.expiresAt ||
		envelope.expiresAt <= envelope.issuedAt ||
		envelope.expiresAt - envelope.issuedAt > TTL_SECONDS ||
		now - envelope.issuedAt > TTL_SECONDS
	)
		throw new Error("Expired or invalid runtime inference assertion time");
	const { request, hash } = await requestHash(input.request);
	if (!timingSafeEqual(envelope.requestHash, hash))
		throw new Error("Runtime inference assertion request differs");
	bindOrigin(request, envelope.origin);
	return envelope.origin;
}
