import { convertToTokenAmount } from "@x402/core/utils";
import {
	X402_PAYMENT_META_KEY,
	type X402ExactPaymentRequirementsV2,
	type X402PaymentRequiredResponse,
	type X402PaymentRequirementsResponseV2,
} from "@tedix/mcp-shared/payment";
import type { AppTool, ServerContext } from "./server-context";
import {
	buildFacilitatorChallenge,
	decodeFacilitatorPaymentToken,
} from "./x402-facilitator";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	DEFAULT_PAYMENT_TTL_SECONDS,
	type TedixToolPaymentPolicy,
} from "./payments-policy";

interface MockPaymentProof {
	requirementId?: string;
	toolId?: string;
	mockPaid?: boolean;
	amount?: string;
	network?: string;
}

export type PaymentProof = MockPaymentProof | string;

export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export async function buildRequirementId(
	agent: ServerContext,
	tool: AppTool,
	args: Record<string, unknown>,
): Promise<string> {
	const hash = await sha256Hex(
		stableStringify({
			appId: agent.appId,
			toolId: tool.toolId,
			args,
		}),
	);
	return `tedix-x402-${hash.slice(0, 24)}`;
}

function buildMockRequirements(params: {
	agent: ServerContext;
	tool: AppTool;
	policy: TedixToolPaymentPolicy;
	requirementId: string;
	paymentRequestId?: string;
}): X402PaymentRequirementsResponseV2 {
	if (!/^\d+(?:\.\d{1,6})?$/.test(params.policy.amount)) {
		throw new Error("Mock x402 v2 amount must have at most six decimal places");
	}
	const resource = `mcp://${params.agent.appSlug}/tools/${params.tool.toolId}#${params.requirementId}`;
	const legacyNetworks: Record<string, string> = {
		"solana-devnet": "solana:devnet",
		"solana-mainnet": "solana:mainnet",
		"base-sepolia": "eip155:84532",
		base: "eip155:8453",
		ethereum: "eip155:1",
		sepolia: "eip155:11155111",
	};
	const requirement: X402ExactPaymentRequirementsV2 = {
		scheme: "exact",
		network:
			legacyNetworks[params.policy.network] ??
			(params.policy.network.includes(":")
				? params.policy.network
				: `mock:${params.policy.network}`),
		asset: params.policy.asset ?? params.policy.currency ?? "USDC",
		amount: convertToTokenAmount(params.policy.amount, 6),
		payTo: params.policy.recipient,
		maxTimeoutSeconds: params.policy.ttlSeconds ?? DEFAULT_PAYMENT_TTL_SECONDS,
		extra: {
			displayAmount: params.policy.amount,
			currency: params.policy.currency ?? "USDC",
			amountDecimals: 6,
			requirementId: params.requirementId,
			toolId: params.tool.toolId,
			appId: params.agent.appId,
			appSlug: params.agent.appSlug,
			mode: params.policy.mode ?? "mock",
			...(params.paymentRequestId
				? { paymentRequestId: params.paymentRequestId }
				: {}),
			...(params.policy.facilitatorUrl
				? { facilitatorUrl: params.policy.facilitatorUrl }
				: {}),
		},
	};
	return {
		x402Version: 2,
		resource: {
			url: resource,
			description:
				params.policy.description ??
				`Pay ${params.policy.amount} ${params.policy.currency ?? "USDC"} to call ${params.tool.toolId}`,
			mimeType: "application/json",
		},
		accepts: [requirement],
	};
}

export async function buildPaymentRequirements(params: {
	agent: ServerContext;
	tool: AppTool;
	policy: TedixToolPaymentPolicy;
	requirementId: string;
	paymentRequestId: string;
}): Promise<X402PaymentRequiredResponse> {
	if (params.policy.mode !== "facilitator") {
		return buildMockRequirements(params);
	}
	if (!params.policy.facilitatorUrl) {
		throw new Error("Facilitator mode requires facilitatorUrl");
	}
	if ((params.policy.currency ?? "USDC").toUpperCase() !== "USDC") {
		throw new Error(
			"Facilitator mode currently supports USD-denominated USDC payments only",
		);
	}
	const resource = `mcp://${params.agent.appSlug}/tools/${params.tool.toolId}#${params.requirementId}`;
	const challenge = await buildFacilitatorChallenge({
		facilitatorUrl: params.policy.facilitatorUrl,
		network: params.policy.network,
		recipient: params.policy.recipient,
		amount: params.policy.amount,
		maxTimeoutSeconds: params.policy.ttlSeconds ?? DEFAULT_PAYMENT_TTL_SECONDS,
		resource,
		description:
			params.policy.description ??
			`Pay ${params.policy.amount} ${params.policy.currency ?? "USDC"} to call ${params.tool.toolId}`,
		extra: {
			requirementId: params.requirementId,
			toolId: params.tool.toolId,
			appId: params.agent.appId,
			appSlug: params.agent.appSlug,
			mode: "facilitator",
			paymentRequestId: params.paymentRequestId,
		},
	});
	if (challenge.x402Version !== 2) {
		throw new Error(
			`Facilitator negotiated unsupported x402 version ${challenge.x402Version}`,
		);
	}
	if (
		params.policy.asset &&
		params.policy.asset.toUpperCase() !== "USDC" &&
		!challenge.accepts.some(
			(requirement) =>
				requirement.asset.toLowerCase() === params.policy.asset?.toLowerCase(),
		)
	) {
		throw new Error(
			"Configured facilitator asset does not match the negotiated USDC asset",
		);
	}
	return challenge as X402PaymentRequiredResponse;
}

export function getPaymentProof(
	extra: { _meta?: Record<string, unknown> } | undefined,
): PaymentProof | null {
	const proof = extra?._meta?.[X402_PAYMENT_META_KEY];
	if (typeof proof === "string" && proof.trim()) return proof;
	if (!isRecord(proof)) return null;
	return proof as MockPaymentProof;
}

export function isMockPaymentValid(params: {
	proof: PaymentProof | null;
	tool: AppTool;
	policy: TedixToolPaymentPolicy;
	requirementId: string;
}): boolean {
	const { proof, tool, policy, requirementId } = params;
	if (!proof || typeof proof === "string") return false;
	if (!proof?.mockPaid) return false;
	if (proof.requirementId !== requirementId) return false;
	if (proof.toolId !== undefined && proof.toolId !== tool.toolId) return false;
	if (proof.amount !== undefined && proof.amount !== policy.amount)
		return false;
	if (proof.network !== undefined && proof.network !== policy.network) {
		return false;
	}
	return true;
}

export function getRequirementsResource(
	requirements: X402PaymentRequiredResponse,
): string | null {
	if (requirements.x402Version === 2) return requirements.resource.url;
	const first = requirements.accepts[0];
	return typeof first?.resource === "string" ? first.resource : null;
}

export async function redactedPaymentProof(
	proof: PaymentProof | null,
): Promise<Record<string, unknown> | null> {
	if (!proof) return null;
	if (typeof proof === "string") {
		let x402Version: number | undefined;
		try {
			x402Version = decodeFacilitatorPaymentToken(proof).x402Version;
		} catch {
			// The facilitator rejection path still records a non-sensitive hash.
		}
		return {
			format: "payment-signature",
			paymentPayloadHash: await sha256Hex(proof),
			...(x402Version ? { x402Version } : {}),
		};
	}
	return {
		requirementId: proof.requirementId,
		toolId: proof.toolId,
		mockPaid: proof.mockPaid === true,
		amount: proof.amount,
		network: proof.network,
	};
}
