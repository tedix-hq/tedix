import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type {
	PaymentPayload,
	PaymentRequired,
	PaymentRequirements,
	SettleResponse,
	VerifyResponse,
} from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { validateUrl } from "@tedix/ssrf-guard";
import { setBoundedCacheEntry } from "../lib/bounded-cache";

const FACILITATOR_TIMEOUT_MS = 30_000;
const FACILITATOR_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHED_FACILITATORS = 16;

const LEGACY_EVM_NETWORKS: Record<string, `eip155:${string}`> = {
	base: "eip155:8453",
	"base-sepolia": "eip155:84532",
	ethereum: "eip155:1",
	sepolia: "eip155:11155111",
};

const serverCache = new Map<
	string,
	{ server: Promise<x402ResourceServer>; expiresAt: number }
>();

export interface FacilitatorChallengeParams {
	facilitatorUrl: string;
	network: string;
	recipient: string;
	amount: string;
	maxTimeoutSeconds: number;
	resource: string;
	description: string;
	extra: Record<string, unknown>;
}

export interface VerifiedFacilitatorPayment {
	facilitatorUrl: string;
	challenge: PaymentRequired;
	paymentToken: string;
	paymentPayload: PaymentPayload;
	paymentRequirements: PaymentRequirements;
	verification: VerifyResponse;
}

function normalizeNetwork(network: string): `eip155:${string}` {
	const normalized = LEGACY_EVM_NETWORKS[network] ?? network;
	if (!/^eip155:\d+$/.test(normalized)) {
		throw new Error(
			`Facilitator mode currently supports EVM CAIP-2 networks only, received ${network}`,
		);
	}
	return normalized as `eip155:${string}`;
}

export function normalizeFacilitatorUrl(value: string): string {
	const validationError = validateUrl(value);
	if (validationError) {
		throw new Error(`Invalid x402 facilitator URL: ${validationError}`);
	}
	const url = new URL(value);
	if (url.protocol !== "https:") {
		throw new Error("x402 facilitator URL must use HTTPS");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error(
			"x402 facilitator URL cannot contain credentials, query parameters, or a fragment",
		);
	}
	return url.toString().replace(/\/$/, "");
}

async function createResourceServer(
	facilitatorUrl: string,
): Promise<x402ResourceServer> {
	const server = new x402ResourceServer(
		new HTTPFacilitatorClient({
			url: facilitatorUrl,
			timeoutMs: FACILITATOR_TIMEOUT_MS,
		}),
	);
	registerExactEvmScheme(server);
	await server.initialize();
	return server;
}

async function getResourceServer(
	facilitatorUrl: string,
): Promise<x402ResourceServer> {
	const normalized = normalizeFacilitatorUrl(facilitatorUrl);
	const cached = serverCache.get(normalized);
	if (cached && cached.expiresAt > Date.now()) return cached.server;
	if (cached) serverCache.delete(normalized);

	let server: Promise<x402ResourceServer>;
	server = createResourceServer(normalized).catch((error) => {
		if (serverCache.get(normalized)?.server === server) {
			serverCache.delete(normalized);
		}
		throw error;
	});
	setBoundedCacheEntry(
		serverCache,
		normalized,
		{ server, expiresAt: Date.now() + FACILITATOR_CACHE_TTL_MS },
		MAX_CACHED_FACILITATORS,
	);
	return server;
}

export function decodeFacilitatorPaymentToken(token: string): PaymentPayload {
	const payload = decodePaymentSignatureHeader(token);
	if (payload.x402Version !== 2) {
		throw new Error(
			`Facilitator mode requires x402 v2 payment payloads, received v${payload.x402Version}`,
		);
	}
	return payload;
}

export async function buildFacilitatorChallenge(
	params: FacilitatorChallengeParams,
): Promise<PaymentRequired> {
	const server = await getResourceServer(params.facilitatorUrl);
	const accepts = await server.buildPaymentRequirements({
		scheme: "exact",
		payTo: params.recipient,
		price: params.amount,
		network: normalizeNetwork(params.network),
		maxTimeoutSeconds: params.maxTimeoutSeconds,
		extra: params.extra,
	});
	return server.createPaymentRequiredResponse(accepts, {
		url: params.resource,
		description: params.description,
		mimeType: "application/json",
	});
}

export async function verifyFacilitatorPayment(params: {
	challenge: PaymentRequired;
	facilitatorUrl: string;
	paymentToken: string;
}): Promise<VerifiedFacilitatorPayment> {
	const server = await getResourceServer(params.facilitatorUrl);
	const paymentPayload = decodeFacilitatorPaymentToken(params.paymentToken);
	const paymentRequirements = server.findMatchingRequirements(
		params.challenge.accepts,
		paymentPayload,
	);
	if (!paymentRequirements) {
		throw new Error(
			"Payment payload does not match the issued x402 requirements",
		);
	}
	const verification = await server.verifyPayment(
		paymentPayload,
		paymentRequirements,
		params.challenge.extensions,
	);
	if (!verification.isValid) {
		throw new Error(
			verification.invalidReason ??
				verification.invalidMessage ??
				"Facilitator rejected the payment payload",
		);
	}
	return {
		facilitatorUrl: normalizeFacilitatorUrl(params.facilitatorUrl),
		challenge: params.challenge,
		paymentToken: params.paymentToken,
		paymentPayload,
		paymentRequirements,
		verification,
	};
}

export async function settleFacilitatorPayment(
	verified: VerifiedFacilitatorPayment,
): Promise<SettleResponse> {
	const server = await getResourceServer(verified.facilitatorUrl);
	const settlement = await server.settlePayment(
		verified.paymentPayload,
		verified.paymentRequirements,
		verified.paymentPayload.extensions,
	);
	if (!settlement.success) {
		throw new Error(
			settlement.errorReason ??
				settlement.errorMessage ??
				"Facilitator settlement failed",
		);
	}
	return settlement;
}

/** @internal */
export function clearFacilitatorCacheForTests(): void {
	serverCache.clear();
}
