import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { BoardError } from "./work-identity";

/** Admission codes are more specific than the transport's CONFLICT code. */
export function workErrorReason(error: unknown): string | undefined {
	if (!isRecord(error)) return undefined;
	const data = isRecord(error.data) ? error.data : undefined;
	for (const value of [data?.rejectionCode, error.reason, error.code]) {
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

export function workErrorDetails(error: BoardError, id?: string) {
	const reason = workErrorReason(error) ?? "WORK_ERROR";
	let nextCommands: string[];
	if (
		/verified external-agent session/i.test(error.message) ||
		/identity|session_required/i.test(reason)
	) {
		nextCommands = ["tedix agent status --json", "tedix agent start --help"];
	} else if (!id) {
		nextCommands = ["tedix work --help"];
	} else if (/stale_attempt|invalid_lease|attempt_expired/i.test(reason)) {
		nextCommands = [`tedix work context ${id}`, `tedix work start ${id}`];
	} else {
		nextCommands = [`tedix work readiness ${id}`, `tedix work context ${id}`];
	}
	return { reason, message: error.message, nextCommands };
}
