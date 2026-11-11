import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { workspaceRoomName } from "@tedix/api-contract/utils/workspace-room";
import {
	subscribeOutputRevisionNotices,
	type OutputRevisionEvent,
} from "./output-revision-notices";
import {
	useWorkspacePresence,
	workspacePresenceDocKey,
} from "./workspace-presence";

const room = vi.hoisted(() => ({ status: "connecting" }));
vi.mock("@/lib/use-collab-doc", () => ({
	useCollabDoc: () => ({ status: room.status, participants: [] }),
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => document.body.replaceChildren());

function Presence({ workspaceId }: { workspaceId: string }) {
	useWorkspacePresence({ workspaceId, location: { surface: "canvas" } });
	return null;
}

describe("the workspace room as the carrier of file change notices", () => {
	it("is the room the API posts notices to", () => {
		expect(
			workspaceRoomName({ tenantSlug: "blueharbor", workspaceId: "ws-1" }),
		).toBe(`blueharbor:ws-1:${workspacePresenceDocKey("ws-1")}`);
	});

	it("asks open editors to check their files every time the connection comes up", () => {
		const events: OutputRevisionEvent[] = [];
		const leave = subscribeOutputRevisionNotices("ws-1", (event) =>
			events.push(event),
		);
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const render = (status: string) => {
			room.status = status;
			act(() => root.render(<Presence workspaceId="ws-1" />));
		};
		render("connecting");
		expect(events).toEqual([]);
		render("connected");
		expect(events).toEqual([{ type: "resync", workspaceId: "ws-1" }]);
		// A drop and a return: notices sent in between are gone, so check again.
		render("disconnected");
		render("connected");
		expect(events).toHaveLength(2);
		act(() => root.unmount());
		leave();
	});
});
