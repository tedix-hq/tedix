/**
 * `GET /machines/connect`: a machine opens its connection here with the
 * ticket its last claim returned, sent as `Authorization: Bearer <ticket>` or
 * as the `bearer-<ticket>` WebSocket protocol. The ticket names the
 * organization, machine and reporter the claim was checked for; nothing in the
 * request can name another.
 */

import {
	extractBearerToken,
	extractWebSocketBearerToken,
	pickEchoableSubprotocol,
} from "@tedix/worker-kit/request-auth";
import { MACHINE_CONNECTION_IDENTITY_HEADER } from "./machine-connection-do";
import {
	hasMachineConnections,
	machineConnectionStub,
	verifyMachineConnectionTicket,
} from "./machine-connections";

const refuse = (status: number, error: string, message: string) =>
	Response.json({ error, message }, { status });

export async function handleMachineConnect(
	request: Request,
	env: CloudflareEnv,
): Promise<Response> {
	if (!hasMachineConnections(env))
		return refuse(
			503,
			"not_available",
			"This installation has no machine connection service; poll for calls instead",
		);
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
		return refuse(426, "upgrade_required", "Open this as a WebSocket");
	const protocols = request.headers.get("Sec-WebSocket-Protocol");
	const ticket =
		extractBearerToken(request.headers.get("Authorization")) ??
		extractWebSocketBearerToken(protocols);
	const identity = ticket
		? await verifyMachineConnectionTicket(env, ticket)
		: null;
	if (!identity)
		return refuse(
			401,
			"unauthorized",
			"The connection ticket is missing, wrong or expired",
		);
	const headers = new Headers(request.headers);
	headers.delete("Authorization");
	headers.set(
		MACHINE_CONNECTION_IDENTITY_HEADER,
		encodeURIComponent(JSON.stringify(identity)),
	);
	const response = await machineConnectionStub(env, identity)!.fetch(
		new Request(request.url, { ...request, headers }),
	);
	// A client that offered a protocol closes unless exactly one is echoed.
	const echoed = pickEchoableSubprotocol(protocols);
	if (!echoed || response.status !== 101 || !response.webSocket)
		return response;
	const echoedHeaders = new Headers(response.headers);
	echoedHeaders.set("Sec-WebSocket-Protocol", echoed);
	return new Response(null, {
		status: 101,
		headers: echoedHeaders,
		webSocket: response.webSocket,
	});
}
