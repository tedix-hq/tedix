export const localModelProviders = {
	ollama: { label: "Ollama", port: 11434 },
	lmstudio: { label: "LM Studio", port: 1234 },
} as const;

export type LocalModelProvider = keyof typeof localModelProviders;
export type LocalModelServer = { provider: LocalModelProvider; port: number };
export type LocalModelPreferences = {
	ports: Record<LocalModelProvider, number>;
	modelKey: string;
};
export type LocalModelMessage = { role: "user" | "assistant"; content: string };
export type LocalModelRequest = LocalModelServer & {
	model: string;
	messages: LocalModelMessage[];
};

export interface LocalModelChatApi {
	preferences(): Promise<LocalModelPreferences>;
	savePreferences(preferences: LocalModelPreferences): Promise<void>;
	models(server: LocalModelServer): Promise<string[]>;
	reply(request: LocalModelRequest): Promise<string>;
	stop(): Promise<void>;
	onText(listener: (text: string) => void): void;
}

type LocalFetch = (url: string, init: RequestInit) => Promise<Response>;

export function validModelPort(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= 65535
	);
}

function serverOrigin(server: LocalModelServer): string {
	if (
		!Object.hasOwn(localModelProviders, server?.provider) ||
		!validModelPort(server.port)
	)
		throw new Error("Choose a provider and a port between 1 and 65535.");
	return `http://127.0.0.1:${server.port}`;
}

function ollamaCloudModel(id: string): boolean {
	return /(?:^cloud\/|:cloud$|-cloud$)/i.test(id);
}

async function requestLocalModel(
	server: LocalModelServer,
	path: "/v1/models" | "/api/tags" | "/v1/chat/completions",
	init: RequestInit,
	transport: LocalFetch,
) {
	const origin = serverOrigin(server);
	const provider = localModelProviders[server.provider].label;
	let response: Response;
	try {
		response = await transport(origin + path, { ...init, redirect: "error" });
	} catch {
		init.signal?.throwIfAborted();
		throw new Error(
			`Couldn't reach ${provider} on port ${server.port}. Check that its local server is running.`,
		);
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new Error(
			`${provider} couldn't complete the request (HTTP ${response.status}). Check the server and model, then try again.`,
		);
	}
	return response;
}

export async function listLocalModels(
	server: LocalModelServer,
	transport: LocalFetch = fetch,
): Promise<string[]> {
	const ollama = server.provider === "ollama";
	const response = await requestLocalModel(
		server,
		ollama ? "/api/tags" : "/v1/models",
		{ signal: AbortSignal.timeout(5000) },
		transport,
	);
	const body = (await response.json()) as {
		data?: { id?: unknown }[];
		models?: {
			name?: unknown;
			remote_host?: unknown;
			remote_model?: unknown;
		}[];
	};
	const ids = ollama
		? (body.models ?? [])
				.filter((model) => !model.remote_host && !model.remote_model)
				.map((model) => model.name)
		: (body.data ?? []).map((model) => model.id);
	return [
		...new Set(
			ids.filter(
				(id): id is string =>
					typeof id === "string" &&
					id.length > 0 &&
					id.length <= 512 &&
					(ollama ? !ollamaCloudModel(id) : !id.startsWith("text-embedding-")),
			),
		),
	].sort();
}

/** Stream the OpenAI-compatible SSE text shared by Ollama and LM Studio. */
export async function streamLocalModelReply(
	request: LocalModelRequest,
	onText: (text: string) => void,
	signal: AbortSignal,
	transport: LocalFetch = fetch,
): Promise<string> {
	const { model, messages } = request;
	if (
		typeof model !== "string" ||
		!model ||
		model.length > 512 ||
		(request.provider === "ollama" && ollamaCloudModel(model)) ||
		!Array.isArray(messages) ||
		messages.length === 0 ||
		messages.length > 80 ||
		messages.some(
			(message) =>
				(message?.role !== "user" && message?.role !== "assistant") ||
				typeof message.content !== "string" ||
				message.content.length > 48_000,
		)
	)
		throw new Error(
			"Choose a local model and enter a message, or start a shorter chat.",
		);

	const response = await requestLocalModel(
		request,
		"/v1/chat/completions",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify({
				model,
				messages: messages.map(({ role, content }) => ({ role, content })),
				stream: true,
				max_tokens: 4096,
			}),
			signal,
		},
		transport,
	);
	if (
		!response.body ||
		!response.headers.get("content-type")?.includes("text/event-stream")
	) {
		await response.body?.cancel().catch(() => {});
		throw new Error("The model server didn't return a streaming reply.");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let reply = "";
	let finished = false;
	try {
		for (;;) {
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) break;
			buffer += decoder
				.decode(chunk.value, { stream: true })
				.replaceAll("\r", "");
			if (buffer.length > 1_048_576)
				throw new Error("The model sent an oversized event.");
			let boundary: number;
			while ((boundary = buffer.indexOf("\n\n")) !== -1) {
				const event = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const data = event
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (!data) continue;
				if (data === "[DONE]") {
					finished = true;
					break;
				}
				const payload = JSON.parse(data) as {
					error?: unknown;
					choices?: {
						delta?: { content?: unknown };
						finish_reason?: unknown;
					}[];
				};
				if (payload.error)
					throw new Error(
						"The local model reported an error during its reply.",
					);
				const choice = payload.choices?.[0];
				const text = choice?.delta?.content;
				if (typeof text === "string" && text.length > 0) {
					reply += text;
					if (reply.length > 48_000)
						throw new Error("The reply exceeded the chat length limit.");
					onText(text);
				}
				if (typeof choice?.finish_reason === "string") finished = true;
			}
			if (finished) break;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	if (!finished)
		throw new Error("The model connection closed before the reply finished.");
	if (!reply.trim()) throw new Error("The selected model returned no text.");
	return reply;
}
