import type {
	WorkspaceUnreadItem,
	WorkspaceUnreadList,
} from "@tedix/api-contract/schemas/workspace-unread";

/**
 * Which workspace events earn a short notice while the person is looking at
 * something else: an agent finished the reply they asked for, or an agent is
 * waiting for their approval.
 *
 * The events come from the unread list. This module remembers three small
 * things the list cannot say: which conversations the person asked in, which
 * events were already handled, and which conversation is on screen right now.
 */

export type WorkspaceToast = {
	/** One per event; an event is never shown twice. */
	key: string;
	kind: "reply" | "approval";
	workspaceId: string;
	workspaceName: string;
	item: WorkspaceUnreadItem;
};

export type ConversationOnScreen = {
	workspaceId: string;
	conversationId: string;
};

const conversationKey = (workspaceId: string, conversationId: string) =>
	`${workspaceId}:${conversationId}`;

/**
 * Pick the notices to show from the unread list.
 *
 * `shown` holds the events already handled, `asked` the conversations the
 * person is waiting for a reply in, and `viewing` the conversation in front
 * of them (null when none is, or the tab is hidden).
 *
 * `events` lists every reply and approval event in the list so the caller can
 * remember them, shown or not. `answered` lists the asked conversations whose
 * reply arrived.
 */
export function workspaceToasts(
	list: WorkspaceUnreadList,
	state: {
		shown: ReadonlySet<string>;
		asked: ReadonlySet<string>;
		viewing: ConversationOnScreen | null;
	},
): { toasts: WorkspaceToast[]; events: string[]; answered: string[] } {
	const toasts: WorkspaceToast[] = [];
	const events: string[] = [];
	const answered = new Set<string>();
	// A conversation gets one notice of each kind, for its newest event.
	const covered = new Set<string>();
	for (const group of list.groups) {
		const { workspaceId, workspaceName } = group;
		for (const item of group.items) {
			if (item.kind !== "agent_reply" && item.kind !== "needs_decision")
				continue;
			const key = `${workspaceId}:${item.kind}:${item.id}`;
			events.push(key);
			if (state.shown.has(key)) continue;
			const conversation = conversationKey(
				workspaceId,
				item.conversationId ?? "",
			);
			const kind = item.kind === "agent_reply" ? "reply" : "approval";
			if (kind === "reply") {
				// Only a reply the person asked for; other people's turns stay quiet.
				if (!state.asked.has(conversation)) continue;
				answered.add(conversation);
			}
			const onScreen =
				state.viewing?.workspaceId === workspaceId &&
				(!item.conversationId ||
					item.conversationId === state.viewing.conversationId);
			if (onScreen || covered.has(`${conversation}:${kind}`)) continue;
			covered.add(`${conversation}:${kind}`);
			toasts.push({ key, kind, workspaceId, workspaceName, item });
		}
	}
	return { toasts, events, answered: [...answered] };
}

/** How long a question keeps waiting for its reply notice. */
const ASK_KEPT_MS = 12 * 60 * 60_000;
/** How long after a question the reply is looked for more often. */
const ASK_FRESH_MS = 10 * 60_000;
const SHOWN_LIMIT = 200;
const ASKED_LIMIT = 50;
const STORAGE_KEY = "tedix:workspace-toasts";

type Remembered = {
	/** Conversation key to the time the person last asked there. */
	asked: Record<string, number>;
	/** Handled event keys, oldest first. */
	shown: string[];
};

let memory: Remembered = { asked: {}, shown: [] };

/** Shared between tabs when the browser allows it, so one event is shown once. */
function recall(): Remembered {
	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
		if (stored && typeof stored === "object")
			memory = {
				asked:
					stored.asked && typeof stored.asked === "object" ? stored.asked : {},
				shown: Array.isArray(stored.shown) ? stored.shown : [],
			};
	} catch {
		// Storage is unavailable or holds something else; this tab's memory stands.
	}
	return memory;
}

function remember(next: Remembered) {
	memory = next;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// This tab still remembers.
	}
}

/** The person posted in a workspace conversation and is owed a reply. */
export function noteChatAsked(
	workspaceId: string,
	conversationId: string,
	now = Date.now(),
) {
	const current = recall();
	const asked = Object.fromEntries(
		Object.entries({
			...current.asked,
			[conversationKey(workspaceId, conversationId)]: now,
		})
			.filter(([, at]) => now - at < ASK_KEPT_MS)
			.sort((a, b) => b[1] - a[1])
			.slice(0, ASKED_LIMIT),
	);
	remember({ ...current, asked });
}

/** Conversations the person is still waiting for a reply in. */
export function askedConversations(now = Date.now()): Set<string> {
	return new Set(
		Object.entries(recall().asked)
			.filter(([, at]) => now - at < ASK_KEPT_MS)
			.map(([key]) => key),
	);
}

export function shownEvents(): Set<string> {
	return new Set(recall().shown);
}

/** Record handled events and the conversations whose reply arrived. */
export function rememberHandled(
	events: readonly string[],
	answered: readonly string[],
) {
	const current = recall();
	const asked = { ...current.asked };
	for (const key of answered) delete asked[key];
	remember({
		asked,
		shown: [...new Set([...current.shown, ...events])].slice(-SHOWN_LIMIT),
	});
}

let onScreen: ConversationOnScreen | null = null;

/**
 * Say which conversation the workspace page is showing. Call the returned
 * function when it stops showing it.
 */
export function showConversationOnScreen(
	conversation: ConversationOnScreen,
): () => void {
	onScreen = conversation;
	return () => {
		if (onScreen === conversation) onScreen = null;
	};
}

/** The conversation in front of the person, or null when the tab is hidden. */
export function conversationOnScreen(): ConversationOnScreen | null {
	return document.visibilityState === "visible" ? onScreen : null;
}

/**
 * True while the person recently asked something in a conversation they are
 * no longer looking at, so the reply is worth checking for more often.
 */
export function waitingForReplyElsewhere(now = Date.now()): boolean {
	const viewing = conversationOnScreen();
	const viewed = viewing
		? conversationKey(viewing.workspaceId, viewing.conversationId)
		: null;
	return Object.entries(recall().asked).some(
		([key, at]) => key !== viewed && now - at < ASK_FRESH_MS,
	);
}

/** Forget everything; for tests. */
export function resetWorkspaceToasts() {
	onScreen = null;
	memory = { asked: {}, shown: [] };
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Nothing was stored.
	}
}
