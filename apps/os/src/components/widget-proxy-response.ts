import { ProtocolError } from "@modelcontextprotocol/client";

/** Retain upstream protocol codes/data when crossing the same-origin HTTP proxy. */
export async function readWidgetProxyResponse<T = unknown>(
	response: Response,
): Promise<T> {
	// A host that does not serve views answers with a page, not JSON.
	const payload = await response.json().catch(() => null);
	if (payload === null) throw new Error("This view could not be loaded.");
	if (response.ok) return payload as T;
	const error = payload?.error;
	const rpc = error?.rpc;
	if (rpc && typeof rpc.code === "number" && typeof rpc.message === "string") {
		throw new ProtocolError(rpc.code, rpc.message, rpc.data);
	}
	throw new Error(
		`${typeof error?.message === "string" ? error.message : "Widget request failed"} (${response.status}).`,
	);
}
