/**
 * The open connection a machine may keep to Tedix, so a tool call reaches it
 * at once instead of waiting for its next poll.
 *
 * All of it depends on the `MACHINE_CONNECTIONS` Durable Object binding. An
 * installation without the binding has no connection service: no ticket is
 * handed out, the connect route answers "not available", and every call goes
 * through the queue the machine polls.
 *
 * A machine proves who it is on its claim, as it always has. The answer to a
 * claim carries a ticket for that organization, machine and reporter, valid
 * for a minute, which opens the connection.
 */

import type {
	MachineToolInput,
	MachineToolName,
} from "@tedix/api-contract/schemas/machines";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import {
	signKernelWsTokenPayload,
	verifySignedTokenPayload,
} from "../kernel/ws-token";
import type { MachineConnectionDO } from "./machine-connection-do";

const TICKET_SCOPE = "machine:connect";
const TICKET_TTL_MS = 60_000;

export interface MachineConnectionIdentity {
	orgId: string;
	machineName: string;
	reporterId: string;
}

/** What the connection carries to the machine for one call. */
export interface PushedMachineToolCall {
	callId: string;
	tool: MachineToolName;
	input: MachineToolInput;
}

type ConnectionEnv = {
	MACHINE_CONNECTIONS?: DurableObjectNamespace<MachineConnectionDO>;
	PLATFORM_SERVICE_TOKEN?: string;
	API_URL?: string;
};

/** True when this installation has the connection service. */
export const hasMachineConnections = (env: unknown): boolean =>
	Boolean((env as ConnectionEnv).MACHINE_CONNECTIONS);

/** The object that holds one machine's connection, or null without the service. */
export function machineConnectionStub(
	env: unknown,
	machine: { orgId: string; machineName: string },
) {
	const namespace = (env as ConnectionEnv).MACHINE_CONNECTIONS;
	if (!namespace) return null;
	return durableObjectStubByName(
		namespace,
		env,
		`${machine.orgId}:${machine.machineName.toLowerCase()}`,
	);
}

/** True when the machine holds an open connection right now. */
export async function machineConnected(
	env: unknown,
	machine: { orgId: string; machineName: string },
): Promise<boolean> {
	try {
		return (await machineConnectionStub(env, machine)?.connected()) ?? false;
	} catch {
		return false;
	}
}

/**
 * Hands the machine's waiting calls to its connection, when one is open. A
 * failure changes nothing: the calls stay queued for the machine's next poll.
 */
export async function pushMachineToolCalls(
	env: unknown,
	machine: { orgId: string; machineName: string },
): Promise<void> {
	try {
		await machineConnectionStub(env, machine)?.push();
	} catch {
		// The queue still holds the call.
	}
}

/** Where and with what the machine may open its connection; undefined without the service. */
export async function mintMachineConnectionTicket(
	env: unknown,
	identity: MachineConnectionIdentity,
	now = Date.now(),
): Promise<{ url: string; ticket: string; expiresAt: string } | undefined> {
	const { MACHINE_CONNECTIONS, PLATFORM_SERVICE_TOKEN, API_URL } =
		env as ConnectionEnv;
	if (!MACHINE_CONNECTIONS || !PLATFORM_SERVICE_TOKEN || !API_URL)
		return undefined;
	let url: URL;
	try {
		url = new URL("/machines/connect", API_URL);
	} catch {
		return undefined;
	}
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	const expiresAt = now + TICKET_TTL_MS;
	return {
		url: url.toString(),
		ticket: await signKernelWsTokenPayload(
			{ scope: TICKET_SCOPE, ...identity, exp: expiresAt },
			PLATFORM_SERVICE_TOKEN,
		),
		expiresAt: new Date(expiresAt).toISOString(),
	};
}

/** Who a ticket was handed to, or null when it is not a valid, unexpired ticket. */
export async function verifyMachineConnectionTicket(
	env: unknown,
	ticket: string,
	now = Date.now(),
): Promise<MachineConnectionIdentity | null> {
	const payload = await verifySignedTokenPayload(
		ticket,
		(env as ConnectionEnv).PLATFORM_SERVICE_TOKEN ?? "",
	);
	if (
		payload?.scope !== TICKET_SCOPE ||
		typeof payload.exp !== "number" ||
		payload.exp <= now ||
		typeof payload.orgId !== "string" ||
		typeof payload.machineName !== "string" ||
		typeof payload.reporterId !== "string"
	)
		return null;
	return {
		orgId: payload.orgId,
		machineName: payload.machineName,
		reporterId: payload.reporterId,
	};
}
