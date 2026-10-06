export interface MessengerAuthor {
	userId: string;
	userName?: string;
	fullName?: string;
	isBot?: boolean | "unknown";
}
export interface MessengerContext {
	provider: string;
	messengerId: string;
	kind: string;
	capabilities?: {
		canEditMessages?: boolean;
		canStream?: boolean;
		maxMessageLength?: number;
		supportsActions?: boolean;
		supportsAttachments?: boolean;
		supportsEphemeral?: boolean;
	};
	thread: {
		id: string;
		providerThreadId?: string;
		channelId?: string;
		isDirectMessage: boolean;
	};
	author?: MessengerAuthor;
	message?: { author: MessengerAuthor };
	action?: { user?: MessengerAuthor };
}

export function messengerSessionKey(
	context: MessengerContext | undefined,
): string | null {
	if (!context) return null;
	const chatId = context.thread.providerThreadId || context.thread.id;
	if (!chatId) return null;
	return `${context.provider}:${chatId}`;
}

/** Build the server-owned, serialization-safe channel turn metadata. */
export function buildMessengerTurnMetadata(
	context: MessengerContext,
	existing: Record<string, unknown> = {},
): Record<string, unknown> {
	const author =
		context.author ?? context.message?.author ?? context.action?.user;
	return {
		...existing,
		surface: "messenger",
		sessionKey: messengerSessionKey(context),
		provider: context.provider,
		messengerId: context.messengerId,
		kind: context.kind,
		thread: {
			id: context.thread.id,
			providerThreadId: context.thread.providerThreadId,
			...(context.thread.channelId
				? { channelId: context.thread.channelId }
				: {}),
			isDirectMessage: context.thread.isDirectMessage,
		},
		...(author
			? {
					principal: {
						id: author.userId,
						...(author.userName ? { userName: author.userName } : {}),
						...(author.fullName ? { fullName: author.fullName } : {}),
						...(author.isBot !== undefined ? { isBot: author.isBot } : {}),
					},
				}
			: {}),
	};
}
