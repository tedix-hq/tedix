export const BROWSER_TAKEOVER_GATE_KEY = "browser:takeover:gate";

export interface BrowserTakeoverGate {
	approvalRequestId: string;
	expiresAt: string;
	sessionId: string;
}

export type BrowserTakeoverGateDecision =
	| { action: "allow"; reason: "approved" }
	| { action: "wait"; reason: "pending" }
	| {
			action: "close";
			reason:
				| "expired"
				| "invalid_approval"
				| "rejected"
				| "cancelled"
				| "unknown_status";
	  };

export function decideBrowserTakeoverGate(input: {
	gate: BrowserTakeoverGate;
	now?: number;
	row: {
		payload: string;
		status: string;
		tediId: string;
	} | null;
	tediId: string | undefined;
}): BrowserTakeoverGateDecision {
	let kind: unknown;
	let sessionId: unknown;
	try {
		const payload = JSON.parse(input.row?.payload ?? "") as {
			kind?: unknown;
			sessionId?: unknown;
		};
		kind = payload.kind;
		sessionId = payload.sessionId;
	} catch {
		return { action: "close", reason: "invalid_approval" };
	}
	if (
		!input.tediId ||
		input.row?.tediId !== input.tediId ||
		kind !== "browser_live_view_takeover" ||
		sessionId !== input.gate.sessionId
	) {
		return { action: "close", reason: "invalid_approval" };
	}
	const expiresAt = Date.parse(input.gate.expiresAt);
	if (!Number.isFinite(expiresAt) || expiresAt <= (input.now ?? Date.now())) {
		return { action: "close", reason: "expired" };
	}
	switch (input.row.status) {
		case "approved":
			return { action: "allow", reason: "approved" };
		case "pending":
			return { action: "wait", reason: "pending" };
		case "rejected":
			return { action: "close", reason: "rejected" };
		case "cancelled":
		case "expired":
			return { action: "close", reason: "cancelled" };
		default:
			return { action: "close", reason: "unknown_status" };
	}
}
