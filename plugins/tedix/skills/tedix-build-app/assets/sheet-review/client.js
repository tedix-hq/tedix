const style = document.createElement("style");
style.textContent = `
:root{color-scheme:light;--page:#f5f4f0;--surface:#fff;--ink:#20251f;--muted:#52604f;--line:#c4ccbf;--accent:#245b35;--on-accent:#fff;background:var(--page);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
body{color:var(--ink);background:var(--page);padding:16px}
main{max-width:640px;margin:auto}h1{font-size:1.6rem;margin:0}p{white-space:pre-wrap;overflow-wrap:anywhere}
header,.tabs,.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:16px 0}
button{min-height:44px;min-width:44px;padding:10px 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);cursor:pointer;white-space:normal}
button[aria-selected=true],.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
button:disabled{opacity:.6;cursor:wait}button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
article{padding:20px;border:1px solid var(--line);border-radius:18px;background:var(--surface)}h2{font-size:1.25rem;margin:8px 0}.muted{color:var(--muted)}[role=alert]{color:#8d2525}
`;
document.head.append(style);
document.documentElement.lang = "de";
const root = document.getElementById("app");
let cards = [];
let tab = "open";
let busy = false;
let message = "Karten werden geladen …";
let failure = "";
let confirmingReset = false;

function element(tag, text, className) {
	const node = document.createElement(tag);
	if (text) node.textContent = text;
	if (className) node.className = className;
	return node;
}
function button(label, action, primary = false) {
	const node = element("button", label, primary ? "primary" : "");
	node.type = "button";
	node.disabled = busy;
	node.onclick = action;
	return node;
}
async function call(method, args = []) {
	return tedix.call("app.call", { method, args });
}
async function run(action) {
	if (busy) return;
	busy = true;
	failure = "";
	render();
	try {
		await action();
	} catch (error) {
		const messages = {
			not_permitted: "Du hast dafür keinen Zugriff.",
			slot_unbound: "Bitte die Tabelle verbinden.",
			host_unavailable: "Die App ist gerade nicht erreichbar.",
		};
		failure =
			messages[error.code] ?? "Das hat nicht geklappt. Bitte erneut versuchen.";
	} finally {
		busy = false;
		render();
	}
}
async function load() {
	const context = await tedix.call("context");
	if (!context.settings.slot) throw new Error("slot_unbound");
	cards = await call("cards");
	message =
		"Bewertungen werden in dieser App gemeinsam gespeichert. Die Tabelle bleibt unverändert.";
}
function render() {
	const main = element("main");
	const header = element("header");
	header.append(element("h1", "Karten prüfen"));
	header.append(button("Neu laden", () => run(load)));
	main.append(header);
	const status = element("p", message, "muted");
	status.setAttribute("role", "status");
	main.append(status);
	const tabs = element("div", "", "tabs");
	tabs.setAttribute("role", "tablist");
	tabs.setAttribute("aria-label", "Karten filtern");
	for (const [value, label] of [
		["open", "Offen"],
		["reviewed", "Bewertet"],
	]) {
		const node = button(label, () => {
			tab = value;
			render();
		});
		node.setAttribute("role", "tab");
		node.id = `tab-${value}`;
		node.setAttribute("aria-controls", "cards");
		node.setAttribute("aria-selected", String(tab === value));
		node.onkeydown = (event) => {
			if (
				!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
				busy
			)
				return;
			event.preventDefault();
			tab =
				event.key === "Home"
					? "open"
					: event.key === "End"
						? "reviewed"
						: tab === "open"
							? "reviewed"
							: "open";
			render();
			document.getElementById(`tab-${tab}`).focus();
		};
		node.tabIndex = tab === value ? 0 : -1;
		tabs.append(node);
	}
	main.append(tabs);
	const panel = element("section");
	panel.id = "cards";
	panel.setAttribute("role", "tabpanel");
	panel.setAttribute("aria-labelledby", `tab-${tab}`);
	const visible = cards.filter((card) =>
		tab === "open" ? !card.verdict : card.verdict,
	);
	panel.append(element("p", `${visible.length} Karten`, "muted"));
	const card = visible[0];
	if (card) {
		const article = element("article");
		article.append(
			element("p", card.category, "muted"),
			element("h2", card.title),
			element("p", card.body),
		);
		if (card.verdict)
			article.append(
				element(
					"p",
					card.verdict === "useful" ? "Hilfreich" : "Nicht hilfreich",
				),
			);
		const actions = element("div", "", "actions");
		for (const [verdict, label] of [
			["useful", "Hilfreich"],
			["not_useful", "Nicht hilfreich"],
		]) {
			actions.append(
				button(
					label,
					() =>
						run(async () => {
							await call("rate", [card.id, verdict]);
							await load();
						}),
					verdict === "useful",
				),
			);
		}
		actions.append(
			button("Weiter", () => {
				cards = [...cards.filter((item) => item.id !== card.id), card];
				render();
			}),
		);
		article.append(actions);
		panel.append(article);
	} else if (!busy && !failure)
		panel.append(
			element(
				"p",
				tab === "open" ? "Alles geprüft. Danke!" : "Noch keine Bewertungen.",
			),
		);
	main.append(panel);
	main.append(
		button("Bewertungen zurücksetzen", () => {
			confirmingReset = true;
			render();
		}),
	);
	if (confirmingReset) {
		const confirmation = element("section");
		confirmation.setAttribute("aria-label", "Zurücksetzen bestätigen");
		confirmation.append(
			element("p", "Alle gemeinsamen Bewertungen dieser App zurücksetzen?"),
		);
		confirmation.append(
			button("Abbrechen", () => {
				confirmingReset = false;
				render();
			}),
		);
		confirmation.append(
			button("Ja, zurücksetzen", () =>
				run(async () => {
					await call("reset");
					confirmingReset = false;
					tab = "open";
					await load();
				}),
			),
		);
		main.append(confirmation);
	}
	if (failure) {
		const alert = element("p", failure);
		alert.setAttribute("role", "alert");
		main.append(alert);
	}
	root.replaceChildren(main);
}
await run(load);
