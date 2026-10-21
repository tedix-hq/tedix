import {
	loadDescopeMcpServer,
	type searchDescopeMcpServerClients,
} from "@tedix/auth/aih-client";

/**
 * Short-lived, isolate-local memory of what the identity provider said.
 *
 * Only complete, successful answers are stored: a failed read, a denial or a
 * pending read is never kept, so each request that misses asks the provider
 * itself. Entries expire after {@link PROVIDER_FACTS_TTL_MS}; a change made
 * only at the provider takes effect within that time, and Tedix revoke paths
 * forget the affected entries at once.
 */
export const PROVIDER_FACTS_TTL_MS = 30_000;
const PROVIDER_FACTS_MAX_ENTRIES = 500;

export class ProviderFactsCache<T> {
	readonly #entries = new Map<string, { value: T; expiresAt: number }>();

	get(key: string, now = Date.now()): T | null {
		const entry = this.#entries.get(key);
		if (!entry) return null;
		if (entry.expiresAt > now) return entry.value;
		this.#entries.delete(key);
		return null;
	}

	set(key: string, value: T, now = Date.now()): void {
		this.#entries.delete(key);
		this.#entries.set(key, { value, expiresAt: now + PROVIDER_FACTS_TTL_MS });
		while (this.#entries.size > PROVIDER_FACTS_MAX_ENTRIES) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
	}

	/** Forget every entry whose key matches, or all entries. */
	forget(matches?: (key: string) => boolean): void {
		if (!matches) {
			this.#entries.clear();
			return;
		}
		for (const key of [...this.#entries.keys()]) {
			if (matches(key)) this.#entries.delete(key);
		}
	}
}

type McpServerRegistration = Awaited<ReturnType<typeof loadDescopeMcpServer>>;

const registrations = new ProviderFactsCache<McpServerRegistration>();

/**
 * The provider's registration of one MCP server (audience, approved scopes).
 * `fresh` always asks the provider, for callers that must not act on a
 * remembered answer (platform administration).
 */
export async function loadMcpServerRegistration(
	env: Parameters<typeof loadDescopeMcpServer>[0],
	mcpServerId: string,
	options: { fresh?: boolean } = {},
): Promise<McpServerRegistration> {
	if (!options.fresh) {
		const known = registrations.get(mcpServerId);
		if (known) return known;
	}
	const server = await loadDescopeMcpServer(env, mcpServerId);
	if (server?.id === mcpServerId) registrations.set(mcpServerId, server);
	return server;
}

/** Forget remembered MCP server registrations (one server, or all). */
export function forgetMcpServerRegistrations(mcpServerId?: string): void {
	registrations.forget(
		mcpServerId === undefined ? undefined : (key) => key === mcpServerId,
	);
}

type McpServerClient = Awaited<
	ReturnType<typeof searchDescopeMcpServerClients>
>[number];

const serverClients = new ProviderFactsCache<McpServerClient>();

function serverClientKey(mcpServerId: string, clientRecordId: string) {
	return JSON.stringify([mcpServerId, clientRecordId]);
}

/** Remembered verified registrations of these clients on one MCP server. */
export function rememberedMcpServerClients(
	mcpServerId: string,
	clientRecordIds: readonly string[],
): McpServerClient[] {
	return clientRecordIds.flatMap((id) => {
		const client = serverClients.get(serverClientKey(mcpServerId, id));
		return client ? [client] : [];
	});
}

/**
 * Keep the verified registrations among `clients` whose ids are listed. A
 * client in any other state is not kept, so it is looked up again next time.
 */
export function rememberMcpServerClients(
	mcpServerId: string,
	clients: readonly McpServerClient[],
	clientRecordIds: readonly string[],
): void {
	for (const client of clients) {
		if (
			client.status === "verified" &&
			client.mcpServerId === mcpServerId &&
			clientRecordIds.includes(client.id)
		)
			serverClients.set(serverClientKey(mcpServerId, client.id), client);
	}
}

/** Forget remembered client registrations (one client, one server, or all). */
export function forgetMcpServerClients(
	mcpServerId?: string,
	clientRecordId?: string,
): void {
	serverClients.forget(
		mcpServerId === undefined
			? undefined
			: (key) => {
					const [server, id] = JSON.parse(key) as string[];
					return (
						server === mcpServerId &&
						(clientRecordId === undefined || id === clientRecordId)
					);
				},
	);
}
