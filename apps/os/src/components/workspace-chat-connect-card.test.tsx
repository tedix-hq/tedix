import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ChatConnectionRequest } from "@/lib/workspace-chat-state";
import {
	ConnectionRequestCard,
	connectionRequestHref,
} from "./workspace-chat-connect-card";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const personal: ChatConnectionRequest = {
	requestId: "t1:calendar",
	resourceId: "calendar",
	resourceName: "Team calendar",
	providerId: "example-calendar",
	service: "Example Calendar",
	connectionScope: "personal",
	reason: "To check the dates of the open challenges.",
};
const shared: ChatConnectionRequest = {
	requestId: "t1:crm",
	resourceId: "crm",
	resourceName: "Partner accounts",
	providerId: "example crm/eu",
	service: "Example CRM",
	connectionScope: "organization",
};

function render(request: ChatConnectionRequest) {
	act(() => root.render(<ConnectionRequestCard request={request} />));
	const card = host.querySelector<HTMLElement>(
		'[data-testid="workspace-chat-connect"]',
	);
	const link = host.querySelector<HTMLAnchorElement>(
		'[data-testid="workspace-chat-connect-link"]',
	);
	if (!card || !link) throw new Error("The Connect card did not render");
	return { card, link };
}

describe("the Connect card in workspace chat", () => {
	it("sends a personal source to the person's own accounts", () => {
		expect(connectionRequestHref(personal)).toBe(
			"/account/connections?connect=example-calendar",
		);
		const { card, link } = render(personal);
		expect(card.dataset.scope).toBe("personal");
		expect(card.textContent).toContain("Connect Example Calendar");
		expect(card.textContent).toContain("Team calendar");
		expect(card.textContent).toContain(
			"To check the dates of the open challenges.",
		);
		expect(card.textContent).toContain("Connect yours to use it here.");
		expect(link.tagName).toBe("A");
		expect(link.getAttribute("href")).toBe(
			"/account/connections?connect=example-calendar",
		);
		expect(link.textContent).toBe("Connect account");
	});

	it("sends an organization source to the organization's connections", () => {
		expect(connectionRequestHref(shared)).toBe(
			"/admin/connections?connect=example+crm%2Feu",
		);
		const { card, link } = render(shared);
		expect(card.dataset.scope).toBe("organization");
		expect(card.textContent).toContain("Connect Example CRM");
		expect(card.textContent).toContain("An organization admin connects it.");
		expect(link.getAttribute("href")).toBe(
			"/admin/connections?connect=example+crm%2Feu",
		);
		expect(link.textContent).toBe("Open connections");
	});
});
