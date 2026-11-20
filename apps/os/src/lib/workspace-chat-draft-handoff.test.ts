import { describe, expect, it, vi } from "vite-plus/test";
import {
	askedTurnStatus,
	askWorkspaceChat,
	hostWorkspaceChatDrafts,
	noteAskedTurn,
	offerWorkspaceChatDraft,
	receiveWorkspaceChatAsks,
	receiveWorkspaceChatDrafts,
} from "./workspace-chat-draft-handoff";

describe("handing text to the workspace chat", () => {
	it("offers nothing when no page shows that workspace's chat", () => {
		const receive = vi.fn();
		const stop = receiveWorkspaceChatDrafts("ws-none", receive);
		expect(offerWorkspaceChatDraft("ws-none", "Hello")).toBe(false);
		expect(receive).not.toHaveBeenCalled();
		stop();
	});

	it("shows the chat and gives the text to its message box only", () => {
		const reveal = vi.fn();
		const receive = vi.fn();
		const other = vi.fn();
		const stops = [
			hostWorkspaceChatDrafts("ws-a", reveal),
			receiveWorkspaceChatDrafts("ws-a", receive),
			receiveWorkspaceChatDrafts("ws-b", other),
		];
		expect(offerWorkspaceChatDraft("ws-a", "   ")).toBe(false);
		expect(offerWorkspaceChatDraft("ws-a", "The app failed")).toBe(true);
		expect(reveal).toHaveBeenCalledTimes(1);
		expect(receive).toHaveBeenCalledExactlyOnceWith("The app failed");
		expect(other).not.toHaveBeenCalled();
		for (const stop of stops) stop();
		expect(offerWorkspaceChatDraft("ws-a", "Again")).toBe(false);
	});

	it("keeps text for a message box that is not on screen yet", () => {
		const reveal = vi.fn();
		const stopHost = hostWorkspaceChatDrafts("ws-c", reveal);
		expect(offerWorkspaceChatDraft("ws-c", "First")).toBe(true);
		expect(offerWorkspaceChatDraft("ws-c", "Second")).toBe(true);
		const receive = vi.fn();
		const stop = receiveWorkspaceChatDrafts("ws-c", receive);
		expect(receive.mock.calls).toEqual([["First"], ["Second"]]);
		stop();
		// Delivered once: a later message box starts empty.
		const later = vi.fn();
		receiveWorkspaceChatDrafts("ws-c", later)();
		expect(later).not.toHaveBeenCalled();
		// Text nobody took does not outlive the page that showed the chat.
		expect(offerWorkspaceChatDraft("ws-c", "Third")).toBe(true);
		stopHost();
		receiveWorkspaceChatDrafts("ws-c", later)();
		expect(later).not.toHaveBeenCalled();
	});

	it("sends an app's ask once the chat is on screen and reports its turn to that app only", async () => {
		const reveal = vi.fn();
		const stopHost = hostWorkspaceChatDrafts("ws-d", reveal);
		const asked = askWorkspaceChat("ws-d", {
			text: "Summarise these rows",
			conversation: "new",
			fromAppId: "app-1",
		});
		expect(reveal).toHaveBeenCalledOnce();
		const take = vi.fn(() => "turn-1");
		const stop = receiveWorkspaceChatAsks("ws-d", take);
		expect(await asked).toBe("turn-1");
		expect(take).toHaveBeenCalledExactlyOnceWith({
			text: "Summarise these rows",
			conversation: "new",
			fromAppId: "app-1",
		});
		noteAskedTurn("turn-1", { status: "done", text: "Three rows." });
		expect(askedTurnStatus("app-1", "turn-1")).toEqual({
			status: "done",
			text: "Three rows.",
		});
		expect(askedTurnStatus("app-2", "turn-1")).toBeNull();
		stop();
		stopHost();
		expect(
			await askWorkspaceChat("ws-d", {
				text: "Again",
				conversation: "current",
				fromAppId: "app-1",
			}),
		).toBeNull();
	});
});
