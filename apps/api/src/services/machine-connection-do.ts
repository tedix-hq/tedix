/**
 * Holds one machine's open connection: one object per organization and
 * machine name. A call queued for the machine is pushed over the socket and
 * its answer comes back on it. Claiming and storing go through the same round
 * a polling machine uses, so nothing about a call differs by path.
 *
 * The socket is accepted for hibernation and pings are answered without
 * waking the object, so a connection with no calls costs nothing.
 *
 * This file is loaded at Worker startup: it imports the database and the
 * round only when a call or an answer arrives.
 */

import { DurableObject } from "cloudflare:workers";
import type {
	MachineConnectionIdentity,
	PushedMachineToolCall,
} from "./machine-connections";

export const MACHINE_CONNECTION_IDENTITY_HEADER = "X-Tedix-Machine-Connection";
/** The machine pings every 30 s; silence makes it unavailable for pushes. */
const SILENT_MS = 100_000;

type Attachment = MachineConnectionIdentity & { openedAt: number };
type Outcome = { callId: string; ok: boolean; result?: string; error?: string };

export class MachineConnectionDO extends DurableObject<CloudflareEnv> {
	readonly #state: DurableObjectState;
	readonly #bindings: CloudflareEnv;

	constructor(state: DurableObjectState, env: CloudflareEnv) {
		super(state, env);
		this.#state = state;
		this.#bindings = env;
	}

	/** The upgrade, already checked by the connect route, which names the machine. */
	override async fetch(request: Request): Promise<Response> {
		const stamped = request.headers.get(MACHINE_CONNECTION_IDENTITY_HEADER);
		if (
			request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
			!stamped
		)
			return new Response("Expected a WebSocket upgrade", { status: 426 });
		const identity = JSON.parse(
			decodeURIComponent(stamped),
		) as MachineConnectionIdentity;
		// One connection per machine: a new one replaces the old.
		for (const old of this.#state.getWebSockets())
			old.close(4001, "Replaced by a newer connection");
		const { 0: client, 1: server } = new WebSocketPair();
		this.#state.acceptWebSocket(server);
		server.serializeAttachment({
			...identity,
			openedAt: Date.now(),
		} satisfies Attachment);
		this.#state.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair("ping", "pong"),
		);
		// Calls that waited while the machine was away go out at once.
		this.#state.waitUntil(this.push().catch(() => false));
		return new Response(null, { status: 101, webSocket: client });
	}

	#open(): { socket: WebSocket; identity: Attachment } | null {
		for (const socket of this.#state.getWebSockets()) {
			const identity = socket.deserializeAttachment() as Attachment | null;
			if (!identity) continue;
			const heardAt =
				this.#state.getWebSocketAutoResponseTimestamp(socket)?.getTime() ??
				identity.openedAt;
			if (Date.now() - heardAt <= SILENT_MS) return { socket, identity };
			// A sleeping machine is unavailable for pushes, but its next ping
			// can resume this socket. The client detects an unresponsive peer.
		}
		return null;
	}

	async #round(
		socket: WebSocket,
		identity: MachineConnectionIdentity,
		results?: Outcome[],
	): Promise<void> {
		const [{ createDbClient }, { runMachineClaimRound }] = await Promise.all([
			import("@tedix/db/client"),
			import("./machine-claim-round"),
		]);
		const calls: PushedMachineToolCall[] = await runMachineClaimRound(
			createDbClient(this.#bindings.DB),
			{
				orgId: identity.orgId,
				machineName: identity.machineName,
				reporterId: identity.reporterId,
				limit: 10,
				results,
			},
		);
		for (const call of calls) socket.send(JSON.stringify(call));
	}

	/** True while the machine holds a connection that still pings. */
	async connected(): Promise<boolean> {
		return this.#open() !== null;
	}

	/** Claims the machine's waiting calls and sends them; false when no connection is open. */
	async push(): Promise<boolean> {
		const open = this.#open();
		if (!open) return false;
		await this.#round(open.socket, open.identity);
		return true;
	}

	/** An answer from the machine: `{ callId, ok, result | error }`. */
	override async webSocketMessage(
		socket: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		const identity = socket.deserializeAttachment() as Attachment | null;
		if (!identity || typeof message !== "string") return;
		const { MachineToolCallOutcomeSchema } =
			await import("@tedix/api-contract/schemas/machines");
		let outcome: Outcome;
		try {
			outcome = MachineToolCallOutcomeSchema.parse(JSON.parse(message));
		} catch {
			return;
		}
		try {
			await this.#round(socket, identity, [outcome]);
			// Until it hears this, the machine keeps the answer to send again.
			socket.send(JSON.stringify({ answered: outcome.callId }));
		} catch (error) {
			console.warn("[machine-connection] storing an answer failed", {
				name: error instanceof Error ? error.name : "unknown",
			});
		}
	}

	override async webSocketClose(
		socket: WebSocket,
		code: number,
	): Promise<void> {
		try {
			socket.close(code === 1005 || code === 1006 ? 1000 : code);
		} catch {
			// Already closed.
		}
	}
}
