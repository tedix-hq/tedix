import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
	APP_RUNTIME_TRANSLATE_METHOD,
	APP_RUNTIME_TRANSLATE_TEXT_METHOD,
	APP_RUNTIME_TRANSLATION_METHOD,
	APP_RUNTIME_TRANSLATION_SCRIPT,
	appRuntimeGlossary,
} from "./app-runtime-host";

const statuses: unknown[] = [];
const hostRequests: { id: string; params: { text: string } }[] = [];
const translate = vi.fn(async (text: string) => `[en] ${text}`);
const fakeTranslator = {
	create: vi.fn(
		async (options: {
			monitor?: (monitor: EventTarget) => void;
		}): Promise<{ translate: typeof translate }> => {
			const monitor = new EventTarget();
			options.monitor?.(monitor);
			monitor.dispatchEvent(
				Object.assign(new Event("downloadprogress"), { loaded: 0.5 }),
			);
			return { translate };
		},
	),
};

function send(params: Record<string, unknown>) {
	window.dispatchEvent(
		new MessageEvent("message", {
			data: { jsonrpc: "2.0", method: APP_RUNTIME_TRANSLATE_METHOD, params },
			source: window,
		}),
	);
}

const last = () => statuses.at(-1);

beforeAll(() => {
	vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
		const message = data as { method?: string; params?: unknown };
		if (message.method === APP_RUNTIME_TRANSLATION_METHOD)
			statuses.push(message.params);
		if (message.method === APP_RUNTIME_TRANSLATE_TEXT_METHOD)
			hostRequests.push(data as (typeof hostRequests)[number]);
	});
	new Function(APP_RUNTIME_TRANSLATION_SCRIPT)();
});

afterEach(() => {
	send({ source: "de", target: null });
	Reflect.deleteProperty(globalThis, "Translator");
	statuses.length = 0;
	translate.mockClear();
	document.body.innerHTML = "";
});

describe("runtime app translation", () => {
	it("swaps visible text and placeholders, keeps glossary wording and untranslatable nodes, and restores", async () => {
		Object.assign(globalThis, { Translator: fakeTranslator });
		document.body.innerHTML = `<div id="app"><h1>  Karte  </h1><p>Langer Text</p><span translate="no">r/Finanzen</span><b>90 / 100</b><textarea placeholder="Warum?"></textarea><style>p{color:red}</style></div>`;
		send({ source: "de", target: "en", glossary: { Karte: "Card", bad: 3 } });
		await vi.waitFor(() =>
			expect(last()).toEqual({ state: "translated", language: "en" }),
		);
		expect(statuses).toContainEqual({ state: "downloading", progress: 0.5 });
		expect(document.querySelector("h1")?.textContent).toBe("  Card  ");
		expect(document.querySelector("p")?.textContent).toBe("[en] Langer Text");
		expect(document.querySelector("span")?.textContent).toBe("r/Finanzen");
		expect(document.querySelector("b")?.textContent).toBe("90 / 100");
		expect(document.querySelector("style")?.textContent).toBe("p{color:red}");
		expect(document.querySelector("textarea")?.placeholder).toBe("[en] Warum?");
		expect(translate).not.toHaveBeenCalledWith("Karte");

		send({ source: "de", target: null });
		expect(last()).toEqual({ state: "original" });
		expect(document.querySelector("h1")?.textContent).toBe("  Karte  ");
		expect(document.querySelector("p")?.textContent).toBe("Langer Text");
		expect(document.querySelector("textarea")?.placeholder).toBe("Warum?");
	});

	it("follows the app's re-renders and reuses translated text", async () => {
		Object.assign(globalThis, { Translator: fakeTranslator });
		document.body.innerHTML = `<div id="app"><p>Seite eins</p></div>`;
		send({ source: "de", target: "en" });
		await vi.waitFor(() =>
			expect(last()).toMatchObject({ state: "translated" }),
		);
		const app = document.getElementById("app")!;
		const next = document.createElement("p");
		next.textContent = "Seite zwei";
		const again = document.createElement("p");
		again.textContent = "Seite eins";
		app.replaceChildren(next, again);
		await vi.waitFor(() =>
			expect(app.textContent).toBe("[en] Seite zwei[en] Seite eins"),
		);
		expect(translate.mock.calls.map(([text]) => text)).toEqual([
			"Seite eins",
			"Seite zwei",
		]);
	});

	it("translates through the host when the host holds the translator", async () => {
		document.body.innerHTML = `<p>Hallo Welt</p>`;
		send({ source: "de", target: "en", host: true });
		await vi.waitFor(() => expect(hostRequests).toHaveLength(1));
		const [request] = hostRequests;
		expect(request?.params).toEqual({
			text: "Hallo Welt",
			source: "de",
			target: "en",
		});
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { jsonrpc: "2.0", id: request?.id, result: "Hello world" },
				source: window,
			}),
		);
		await vi.waitFor(() =>
			expect(last()).toEqual({ state: "translated", language: "en" }),
		);
		expect(document.body.textContent).toBe("Hello world");
		hostRequests.length = 0;
	});

	it("reports an unavailable translator and leaves the text alone", () => {
		document.body.innerHTML = `<p>Hallo</p>`;
		send({ source: "de", target: "en" });
		expect(last()).toEqual({ state: "unavailable", detail: "no_translator" });
		expect(document.body.textContent).toBe("Hallo");
	});

	it("ignores requests from anyone but the host frame", () => {
		Object.assign(globalThis, { Translator: fakeTranslator });
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					jsonrpc: "2.0",
					method: APP_RUNTIME_TRANSLATE_METHOD,
					params: { source: "de", target: "en" },
				},
			}),
		);
		expect(statuses).toEqual([]);
	});
});

describe("appRuntimeGlossary", () => {
	it("reads string entries for the target only", () => {
		expect(
			appRuntimeGlossary(
				{ glossary: { en: { Karte: "Card", n: 1 }, fr: { Karte: "Carte" } } },
				"en",
			),
		).toEqual({ Karte: "Card" });
		expect(appRuntimeGlossary({}, "en")).toEqual({});
	});
});
