import { ProtocolError } from "@modelcontextprotocol/client";

/** Retain upstream protocol codes/data when crossing the same-origin HTTP proxy. */
export async function readWidgetProxyResponse<T = unknown>(
	response: Response,
): Promise<T> {
	const payload = await response.json();
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
