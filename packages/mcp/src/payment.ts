import { isRecord } from "@tedix/api-contract/utils/is-record";

export const TEDIX_PAYMENT_REQUIRED_META_KEY = "x-tedix/payment-required";
export const X402_PAYMENT_ERROR_META_KEY = "x402/error";
export const X402_PAYMENT_META_KEY = "x402/payment";
export const X402_PAYMENT_RESPONSE_META_KEY = "x402/payment-response";

export interface X402ExactPaymentRequirements {
	scheme: "exact";
	network: string;
	asset: string;
	amount: string;
	payTo: string;
	maxTimeoutSeconds: number;
	extra: Record<string, unknown>;
}

export interface X402PaymentRequiredResponse {
	x402Version: 2;
	error?: string;
	resource: {
		url: string;
		description?: string;
		mimeType?: string;
	};
	accepts: X402ExactPaymentRequirements[];
	extensions?: Record<string, unknown>;
}

export interface TedixPaymentRequiredMeta {
	protocol: "x402";
	toolId: string;
	requirementId: string;
	requirements: X402PaymentRequiredResponse;
}

export interface TedixPaymentRequiredResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError: true;
	_meta: {
		[TEDIX_PAYMENT_REQUIRED_META_KEY]: TedixPaymentRequiredMeta;
		[X402_PAYMENT_ERROR_META_KEY]: X402PaymentRequiredResponse;
	};
}

export function buildPaymentRequiredResult(
	meta: TedixPaymentRequiredMeta,
): TedixPaymentRequiredResult {
	return {
		content: [
			{
				type: "text",
				text: `Payment required for tool "${meta.toolId}". Retry with _meta["${X402_PAYMENT_META_KEY}"].`,
			},
		],
		isError: true,
		_meta: {
			[TEDIX_PAYMENT_REQUIRED_META_KEY]: meta,
			[X402_PAYMENT_ERROR_META_KEY]: meta.requirements,
		},
	};
}

export function getPaymentRequiredMeta(
	value: unknown,
): TedixPaymentRequiredMeta | null {
	if (!isRecord(value)) return null;
	const result = value.result;
	if (!isRecord(result)) return null;
	const meta = result._meta;
	if (!isRecord(meta)) return null;
	const payment = meta[TEDIX_PAYMENT_REQUIRED_META_KEY];
	if (
		isRecord(payment) &&
		payment.protocol === "x402" &&
		typeof payment.toolId === "string" &&
		typeof payment.requirementId === "string" &&
		isRecord(payment.requirements)
	) {
		return payment as unknown as TedixPaymentRequiredMeta;
	}
	const challenge = meta[X402_PAYMENT_ERROR_META_KEY];
	if (!isRecord(challenge) || challenge.x402Version !== 2) return null;
	const accepts = challenge.accepts;
	if (!Array.isArray(accepts) || !isRecord(accepts[0])) return null;
	const extra = accepts[0].extra;
	if (!isRecord(extra)) return null;
	if (typeof extra.toolId !== "string") return null;
	if (typeof extra.requirementId !== "string") return null;
	return {
		protocol: "x402",
		toolId: extra.toolId,
		requirementId: extra.requirementId,
		requirements: challenge as unknown as X402PaymentRequiredResponse,
	};
}
