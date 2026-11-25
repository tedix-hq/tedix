import {
	app,
	type BaseWindow,
	BrowserWindow,
	dialog,
	session,
	WebContentsView,
} from "electron";
import {
	listLocalModels,
	localModelProviders,
	type LocalModelProvider,
} from "./local-model-client";
import { openLocalModelChat } from "./local-model-window";
import {
	localOrigin,
	localPageAllowed,
	localRequestAllowed,
} from "./local-origin";
import {
	bundledLocalAvailable,
	bundledLocalRunning,
	cloudflareAccounts,
	type CloudflareAccount,
	demoCloudflare,
	type DemoCloudflare,
	signInToCloudflare,
	startBundledLocal,
} from "./local-service";
import { settings } from "./setup";

const PARTITION = "persist:tedix-local";
const demoOrigin = "http://localhost:3030";
const samplePath = "/workspace/00000000-0000-4000-8000-000000000007";
const actionOrigin = "tedix-local:";
const toolbarHeight = 52;
let window: BrowserWindow | undefined;
let workspace: WebContentsView | undefined;
let origin = demoOrigin;
let guarded = false;
let bundled = false;
let setupPage = "";
let busy = false;
let startupMessage = "";
let accounts: CloudflareAccount[] = [];
let returnToSetup: (() => void) | undefined;

function escape(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function action(name: string, label: string, primary = false) {
	return `<a class="${primary ? "primary" : ""}" href="${actionOrigin}//${name}">${label}</a>`;
}

function showPage(body: string) {
	const html = `<!doctype html><meta charset="utf-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action tedix-local:">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>Tedix Demo</title><style>
		:root{color-scheme:light dark}
		body{margin:0;font:15px/1.5 system-ui;color:CanvasText;background:Canvas}
		main{max-width:38rem;margin:10vh auto;padding:0 1.5rem}
		h1{font-size:2rem;line-height:1.17;letter-spacing:-.03em;margin:0 0 .6rem}
		p{margin:.5rem 0 1.15rem}
		a,button{display:inline-block;padding:.5rem .8rem;border:1px solid color-mix(in srgb,CanvasText 24%,Canvas);border-radius:.6rem;text-decoration:none;color:CanvasText;background:Canvas;font:inherit;font-weight:600;cursor:pointer}
		a.primary,button.primary{color:white;background:#3c50c9;border-color:#3c50c9}
		a:focus-visible,button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #5267ea;outline-offset:3px}
		nav,.actions{display:flex;gap:.55rem;align-items:center;flex-wrap:wrap}
		nav{height:52px;box-sizing:border-box;padding:0 12px;border-bottom:1px solid color-mix(in srgb,CanvasText 20%,Canvas)}
		nav span{margin-right:auto;font-weight:600} nav a{padding:.26rem .6rem}
		label{display:grid;gap:.25rem;margin:.75rem 0}
		input,select{padding:.45rem;font:inherit;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 35%,Canvas);border-radius:.4rem}
		.track{height:5px;border-radius:8px;overflow:hidden;background:color-mix(in srgb,#5368ec 24%,Canvas);margin:1.25rem 0}
		.track::before{content:"";display:block;width:35%;height:100%;background:#5368ec;border-radius:8px;animation:sweep 1.65s ease-in-out infinite alternate}
		@keyframes sweep{to{transform:translateX(186%)}}
		@media(prefers-reduced-motion:reduce){.track::before{animation:none}}
		</style>${body}`;
	setupPage = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
	void window?.loadURL(setupPage).catch(() => {});
}

function showProgress(
	message: string,
	detail = "The demo can take a few minutes to open the first time.",
) {
	showPage(
		`<main><h1>Opening your demo</h1><div role="status"><p>${escape(message)}…</p><div class="track" aria-hidden="true"></div><p>${escape(detail)}</p></div>${action("back", "Back to setup")}</main>`,
	);
}

function showError(message: string) {
	showPage(
		`<main><h1>Couldn’t open the demo</h1><p>${escape(message)}</p><div class="actions">${action("choose", "Try again", true)}${action("back", "Back to setup")}</div></main>`,
	);
}

function hideWorkspace() {
	if (!workspace) return;
	window?.contentView.removeChildView(workspace);
	workspace.webContents.close();
	workspace = undefined;
}

async function chooseDemo() {
	hideWorkspace();
	accounts = [];
	const owner = window;
	const render = (message: string) =>
		showPage(`<main><h1>Try Tedix on this Mac</h1><p>Explore a sample project and its files. Chat in the demo needs an AI model: use one already on this Mac (from Ollama or LM Studio), or connect a Cloudflare account to use the AI models Cloudflare offers.</p>
		<p role="status">${escape(message)}</p>
		<div class="actions">${action("start", "Explore sample", true)}${action("models", "Chat on this Mac")}${action("cloudflare", "Connect Cloudflare")}${action("back", "Back to setup")}</div></main>`);
	render("Looking for models on this Mac…");
	const page = setupPage;
	const ports = settings().localModels?.ports;
	const labels = await Promise.all(
		(Object.keys(localModelProviders) as LocalModelProvider[]).map(
			async (provider) => {
				const { label, port } = localModelProviders[provider];
				try {
					const models = await listLocalModels({
						provider,
						port: ports?.[provider] ?? port,
					});
					return models.length ? label : "";
				} catch {
					return "";
				}
			},
		),
	);
	if (window !== owner || setupPage !== page) return;
	const found = labels.filter(Boolean);
	render(
		found.length
			? `Found models in ${found.join(" and ")}.`
			: "No local models found. Start Ollama or LM Studio with a chat model to use one.",
	);
}

function selectCloudflare(signedOut = false) {
	const title = "Use Cloudflare for chat";
	const notice =
		"Chat requests send prompts and any content used for the reply to Cloudflare. Cloudflare may charge your account for these requests, including in the demo.";
	const back = action("choose", "Back to demo options");
	const form = signedOut
		? `<p>Sign in to your Cloudflare account in your browser, then come back here.</p><div class="actions">${action("cloudflare-sign-in", "Sign in to Cloudflare", true)}${back}</div>`
		: `<form action="${actionOrigin}//cloudflare-start">
			<label>Cloudflare account<select name="account" required>${accounts.map(({ id, name }) => `<option value="${id}">${escape(name)}</option>`).join("")}</select></label>
			<label>AI Gateway name (optional)<input name="gateway" maxlength="64" pattern="[a-z0-9\\-]{1,64}" placeholder="For example, default"></label>
			<p>Leave the gateway blank to use Workers AI directly. AI Gateway limits and logging only apply when you choose a gateway.</p>
			<div class="actions"><button class="primary" type="submit">Enable billable chat</button>${back}</div>
		</form>`;
	showPage(`<main><h1>${title}</h1><p>${notice}</p>${form}</main>`);
}

async function loadCloudflare(signIn = false) {
	const owner = window;
	const message = signIn
		? "Finish signing in in your browser"
		: "Getting Cloudflare setup ready";
	showProgress(
		message,
		"This connects Cloudflare for chat in your sample workspace.",
	);
	const page = setupPage;
	try {
		if (signIn) await signInToCloudflare();
		accounts = await cloudflareAccounts();
		if (window !== owner || setupPage !== page) return;
		if (!accounts.length)
			return showError(
				"No Cloudflare accounts are available to this sign-in. Choose an account with Workers AI access.",
			);
		selectCloudflare();
	} catch {
		if (window !== owner || setupPage !== page) return;
		if (signIn)
			showError(
				"Cloudflare sign-in did not finish. Try again from the demo options.",
			);
		else selectCloudflare(true);
	}
}

function openSample(inference: DemoCloudflare | null) {
	if (busy) return;
	busy = true;
	hideWorkspace();
	startupMessage = "Getting the demo ready on this Mac";
	showProgress(startupMessage);
	void startBundledLocal((message) => {
		startupMessage = message;
		if (window && bundled) showProgress(message);
	}, inference)
		.then(
			() => {
				if (window && bundled) loadWorkspace();
			},
			() => {
				if (window && bundled)
					showError(
						inference
							? "Check that your Cloudflare account has Workers AI access and the gateway name is correct, then try again."
							: "Try again. If it still won’t open, quit and reopen Tedix.",
					);
			},
		)
		.finally(() => {
			busy = false;
		});
}

function handleAction(url: URL) {
	switch (url.host) {
		case "back":
			window?.close();
			break;
		case "choose":
			void chooseDemo();
			break;
		case "start":
			openSample(null);
			break;
		case "models":
			openLocalModelChat();
			break;
		case "cloudflare":
			void loadCloudflare();
			break;
		case "cloudflare-sign-in":
			void loadCloudflare(true);
			break;
		case "cloudflare-start": {
			const accountId = url.searchParams.get("account") ?? "";
			const gateway = url.searchParams.get("gateway")?.trim() ?? "";
			if (
				!accounts.some(({ id }) => id === accountId) ||
				(gateway && !/^[a-z0-9-]{1,64}$/.test(gateway))
			)
				return;
			accounts = [];
			openSample({ accountId, gateway });
			break;
		}
	}
}

function layOutWorkspace() {
	if (!window || !workspace) return;
	const { width, height } = window.getContentBounds();
	const y = bundled ? toolbarHeight : 0;
	workspace.setBounds({ x: 0, y, width, height: Math.max(0, height - y) });
}

function loadWorkspace() {
	if (!window) return;
	if (bundled) {
		const chat = demoCloudflare()
			? "Cloudflare chat is on"
			: "Chat is off in this workspace";
		showPage(
			`<nav><span>Demo · ${chat}</span>${action("models", "Chat on this Mac")}${action("choose", "Demo and chat options")}${action("back", "Back to setup")}</nav>`,
		);
	}
	hideWorkspace();
	const view = new WebContentsView({
		webPreferences: {
			session: session.fromPartition(PARTITION),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	workspace = view;
	window.contentView.addChildView(view);
	layOutWorkspace();
	const contents = view.webContents;
	if (bundled)
		contents.setUserAgent(
			`${contents.getUserAgent()} TedixDesktop/${app.getVersion()}`,
		);
	const inside = (url: string) => localPageAllowed(url, origin);
	const guard = (event: Electron.Event, url: string) => {
		if (!inside(url)) event.preventDefault();
	};
	contents.on("will-navigate", guard);
	contents.on("will-redirect", guard);
	contents.setWindowOpenHandler(({ url }) => {
		if (inside(url)) void contents.loadURL(url).catch(() => {});
		return { action: "deny" };
	});
	contents.on("did-fail-load", (_event, code, _name, url, isMainFrame) => {
		if (!isMainFrame || code === -3 || !inside(url)) return;
		hideWorkspace();
		if (!bundled) {
			showPage(
				`<main><h1>Couldn’t open the local workspace</h1><p>Check that it’s running, then use View → Reload.</p></main>`,
			);
			return;
		}
		showError("Try again. If it still won’t open, quit and reopen Tedix.");
	});
	const page = bundled
		? `${samplePath}${demoCloudflare() ? "" : "?pane=resources"}`
		: "/chat";
	void contents.loadURL(origin + page).catch(() => {});
}

export function reloadLocalTedix(focused: BaseWindow | undefined): boolean {
	if (!window || window !== focused || window.isDestroyed()) return false;
	if (workspace) workspace.webContents.reloadIgnoringCache();
	else if (!bundled) loadWorkspace();
	else if (!busy) void chooseDemo();
	return true;
}

/** Local content runs in its own session, below the trusted demo controls. */
export function openLocalTedix(
	args: readonly string[] = [],
	onReturn?: () => void,
): void {
	const requested = localOrigin(args);
	if (requested === null) {
		dialog.showErrorBox(
			"Invalid local port",
			"Use --local for port 3030, or --local=PORT with a port from 1 to 65535.",
		);
		return;
	}
	const next = requested ?? demoOrigin;
	const useBundle = requested === undefined && bundledLocalAvailable();
	const redraw = next !== origin || useBundle !== bundled;
	origin = next;
	bundled = useBundle;
	if (onReturn) returnToSetup = onReturn;
	if (!guarded) {
		guarded = true;
		session
			.fromPartition(PARTITION)
			.webRequest.onBeforeRequest(({ url }, reply) =>
				reply({ cancel: !localRequestAllowed(url) }),
			);
	}
	if (!window || window.isDestroyed()) {
		window = new BrowserWindow({
			title: bundled ? "Tedix Demo" : "Tedix Local",
			width: 1120,
			height: 820,
			minWidth: 610,
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
		});
		const contents = window.webContents;
		contents.setWindowOpenHandler(() => ({ action: "deny" }));
		contents.on("will-navigate", (event, url) => {
			event.preventDefault();
			const target = URL.parse(url);
			if (
				bundled &&
				target?.protocol === actionOrigin &&
				contents.getURL() === setupPage
			)
				handleAction(target);
		});
		window.on("resize", layOutWorkspace);
		window.on("close", hideWorkspace);
		window.on("closed", () => {
			window = undefined;
			accounts = [];
			const back = returnToSetup;
			returnToSetup = undefined;
			if (bundled) back?.();
		});
	} else if (!redraw && !onReturn) {
		window.show();
		window.focus();
		return;
	}
	void app.dock?.show();
	if (bundled && busy) showProgress(startupMessage);
	else if (bundled && (!bundledLocalRunning() || onReturn)) void chooseDemo();
	else loadWorkspace();
	window.show();
	window.focus();
}
