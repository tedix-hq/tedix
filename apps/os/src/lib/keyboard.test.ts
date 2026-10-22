import { describe, expect, it } from "vite-plus/test";
import { isImeComposing, isTypingEvent } from "./keyboard";

function keyFrom(node: Node, init: KeyboardEventInit = { key: "j" }) {
	let typing: boolean | undefined;
	const listen = (event: Event) => {
		typing = isTypingEvent(event as KeyboardEvent);
	};
	document.addEventListener("keydown", listen);
	node.dispatchEvent(
		new KeyboardEvent("keydown", { ...init, bubbles: true, composed: true }),
	);
	document.removeEventListener("keydown", listen);
	return typing;
}

describe("isTypingEvent", () => {
	it("sees text fields inside an open shadow root", () => {
		const host = document.body.appendChild(document.createElement("div"));
		const input = host
			.attachShadow({ mode: "open" })
			.appendChild(document.createElement("textarea"));
		expect(keyFrom(input)).toBe(true);
		host.remove();
	});

	it("sees light DOM editables and IME composition", () => {
		const editor = document.body.appendChild(document.createElement("div"));
		editor.setAttribute("contenteditable", "true");
		const child = editor.appendChild(document.createElement("span"));
		expect(keyFrom(child)).toBe(true);
		const button = document.body.appendChild(document.createElement("button"));
		expect(keyFrom(button)).toBe(false);
		expect(keyFrom(button, { key: "j", isComposing: true })).toBe(true);
		editor.remove();
		button.remove();
	});
});

describe("isImeComposing", () => {
	it("recognizes native composition events", () => {
		expect(
			isImeComposing({ nativeEvent: { isComposing: true, keyCode: 13 } }),
		).toBe(true);
	});

	it("recognizes the legacy IME process key", () => {
		expect(
			isImeComposing({ nativeEvent: { isComposing: false, keyCode: 229 } }),
		).toBe(true);
	});

	it("leaves ordinary Enter events available to commit", () => {
		expect(
			isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } }),
		).toBe(false);
	});
});
