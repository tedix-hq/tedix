/**
 * Versioned paid-inference correlation packed into one AI Gateway metadata
 * string. Cloudflare limits custom metadata to five flat primitive entries, so
 * run/work correlation shares this envelope while `tediId`, `orgId`, `source`,
 * and `sessionKeyHash` remain independently filterable.
 */
export interface AiGatewayAttribution {
	runId: string;
	workItemId: string;
	/** Canonical D1 billing reservation correlated to this provider call. */
	billingReservationId?: string;
	executionId?: string;
}

interface AiGatewayAttributionV1 {
	v: 1;
	r: string;
	w: string;
}

interface AiGatewayAttributionV2 {
	v: 2;
	r: string;
	w: string;
	b: string;
}

export function encodeAiGatewayAttribution(
	value: AiGatewayAttribution,
): string {
	if (value.executionId)
		return JSON.stringify({
			v: 3,
			r: value.runId,
			w: value.workItemId,
			e: value.executionId,
			...(value.billingReservationId ? { b: value.billingReservationId } : {}),
		});
	if (value.billingReservationId) {
		return JSON.stringify({
			v: 2,
			r: value.runId,
			w: value.workItemId,
			b: value.billingReservationId,
		} satisfies AiGatewayAttributionV2);
	}
	return JSON.stringify({
		v: 1,
		r: value.runId,
		w: value.workItemId,
	} satisfies AiGatewayAttributionV1);
}

export function decodeAiGatewayAttribution(
	value: unknown,
): AiGatewayAttribution | null {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const parsed = JSON.parse(value) as
			| Partial<AiGatewayAttributionV1>
			| Partial<AiGatewayAttributionV2>
			| { v?: 3; r?: string; w?: string; e?: string; b?: string };
		if (
			(parsed.v !== 1 && parsed.v !== 2 && parsed.v !== 3) ||
			typeof parsed.r !== "string" ||
			parsed.r.length === 0 ||
			typeof parsed.w !== "string" ||
			parsed.w.length === 0
		) {
			return null;
		}
		const decoded: AiGatewayAttribution = {
			runId: parsed.r,
			workItemId: parsed.w,
		};
		if (
			(parsed.v === 2 || parsed.v === 3) &&
			"b" in parsed &&
			typeof parsed.b === "string" &&
			parsed.b.length > 0
		) {
			decoded.billingReservationId = parsed.b;
		}
		if (parsed.v === 3) {
			if (!parsed.e || typeof parsed.e !== "string") return null;
			decoded.executionId = parsed.e;
		}
		return decoded;
	} catch {
		return null;
	}
}
