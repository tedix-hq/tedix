import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { SystemMapConfigSchema } from "@tedix/api-contract/schemas/os-system-map";
import type { SystemMapSources } from "@/lib/system-map";
import { describeFinding, SystemMapView } from "./system-map-app";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SKILL_ID = "5b0f1e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const sources: SystemMapSources = {
	tedis: [
		{
			id: "t1",
			name: "miles",
			displayName: "Miles",
			installedSkills: [SKILL_ID],
		},
		{ id: "t2", name: "juno" },
	],
	skills: [{ id: "s1", title: "Revenue report", tediId: "t2", appId: "shop" }],
	connections: [
		{
			id: "gmail",
			name: "Gmail",
			accountState: "expired",
			referenceAppIds: ["shop"],
		},
	],
	workspaces: [],
};

let container: HTMLDivElement | undefined;
afterEach(() => {
	container?.remove();
	container = undefined;
});

function render(value: SystemMapSources) {
	container = document.createElement("div");
	document.body.append(container);
	act(() => {
		createRoot(container!).render(<SystemMapView sources={value} />);
	});
	return container;
}

it("parses the config with defaults", () => {
	expect(SystemMapConfigSchema.parse({ version: 1 })).toEqual({
		version: 1,
		showSharedWorkspaces: false,
	});
});

it("lists each tedi and explains problems without raw ids", () => {
	const root = render(sources);
	expect(root.querySelectorAll('[data-testid="system-map-tedi"]')).toHaveLength(
		2,
	);
	const text = root.textContent ?? "";
	expect(text).toContain("Miles");
	expect(text).toContain("juno1 skill · 1 connection");
	expect(text).toContain("which no longer exists");
	expect(text).toContain("Miles lists a skill, which no longer exists");
	expect(text).not.toContain(SKILL_ID);
});

it("shows the empty organization", () => {
	const root = render({
		tedis: [],
		skills: [],
		connections: [],
		workspaces: [],
	});
	expect(root.textContent).toContain("No tedis yet");
	expect(root.textContent).toContain("Everything is linked");
});

it("describes an orphan connection", () => {
	expect(
		describeFinding({
			kind: "orphan_node",
			node: { id: "connection:x", kind: "connection", label: "Notion" },
		}),
	).toBe("Notion is not needed by any skill.");
});
