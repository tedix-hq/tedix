/** Public, credential-free viewer shell for governed Tedix OS share links. */

const VIEWER_CSP = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"connect-src 'self'",
	"img-src data:",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>Shared with Tedix</title>
  <link rel="stylesheet" href="/os-shared/viewer.css">
</head>
<body>
  <header><span class="mark">T</span><strong>Tedix OS</strong><span class="badge">Governed share</span></header>
  <main id="root" aria-live="polite"><div class="loading">Opening shared resource…</div></main>
  <script src="/os-shared/viewer.js" defer></script>
</body>
</html>`;

const VIEWER_CSS = `:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f7f8;color:#202124}*{box-sizing:border-box}body{margin:0;min-height:100vh}header{height:56px;display:flex;align-items:center;gap:10px;padding:0 20px;border-bottom:1px solid #dddde2;background:#fff;position:sticky;top:0;z-index:2}.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#202124;color:#fff;font-weight:700}.badge{margin-left:auto;border:1px solid #d7d7dc;border-radius:999px;padding:4px 9px;color:#68686f;font-size:12px}main{width:min(1120px,calc(100% - 32px));margin:32px auto}.loading,.error{border:1px solid #dddde2;border-radius:16px;background:#fff;padding:28px;color:#68686f}.error h1{margin:0 0 8px;color:#202124;font-size:20px}.meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:16px;color:#68686f;font-size:12px}.meta h1{width:100%;margin:0;color:#202124;font-size:26px}.kind{border-radius:999px;background:#ececef;padding:4px 8px}.paper,.resource-card{border:1px solid #dddde2;border-radius:18px;background:#fff;padding:clamp(22px,5vw,64px);box-shadow:0 12px 40px #0000000a;overflow:auto}.resource-card{padding:20px;margin-bottom:12px}.resource-card h2{margin:0 0 6px}.resource-card p{color:#68686f}.paper h1,.paper h2,.paper h3,.paper h4{line-height:1.2}.paper p,.paper li,.paper blockquote{line-height:1.65}.paper blockquote{border-left:3px solid #8b5cf6;margin-left:0;padding-left:18px;color:#555}.paper pre,.resource-card pre{overflow:auto;border-radius:10px;background:#f2f2f4;padding:14px}.grid{border-collapse:collapse;min-width:720px;width:100%;font-size:13px}.grid th,.grid td{border:1px solid #dddde2;padding:8px 10px;text-align:left;white-space:nowrap}.grid th{background:#f2f2f4}.slides{display:grid;gap:18px}.slide{aspect-ratio:16/9;border:1px solid #dddde2;border-radius:14px;background:#fff;padding:6%;box-shadow:0 8px 28px #0000000a}.slide h2{margin-top:0;font-size:clamp(22px,4vw,48px)}@media(prefers-color-scheme:dark){:root{background:#171719;color:#ececef}header,.paper,.resource-card,.loading,.error,.slide{background:#202023;border-color:#3a3a40}.mark{background:#ececef;color:#202124}.meta h1,.error h1{color:#ececef}.badge,.kind{border-color:#44444a;background:#2b2b2f;color:#b7b7bf}.paper blockquote{color:#c4c4cb}.paper pre,.resource-card pre,.grid th{background:#2b2b2f}.grid th,.grid td{border-color:#44444a}}`;

const VIEWER_JS = `(() => {
  const root = document.getElementById("root");
  const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value ?? ""; if (className) node.className = className; return node; };
  const fail = () => { root.replaceChildren(); const box = text("section", "", "error"); box.append(text("h1", "This share link is unavailable"), text("p", "It may have expired, been revoked, or never existed.")); root.append(box); };
  const renderDocument = (content) => { const paper = text("article", "", "paper"); for (const block of content.blocks || []) { if (block.type === "heading") paper.append(text("h" + Math.min(4, Math.max(1, block.level || 2)), block.text)); else if (block.type === "list") { const list = document.createElement(block.ordered ? "ol" : "ul"); for (const item of block.items || []) list.append(text("li", item)); paper.append(list); } else if (block.type === "code") paper.append(text("pre", block.text)); else if (block.type === "quote") paper.append(text("blockquote", block.text)); else paper.append(text("p", block.text)); } return paper; };
  const renderSheet = (content) => { const paper = text("section", "", "paper"); const table = text("table", "", "grid"); const head = document.createElement("thead"); const header = document.createElement("tr"); for (const column of content.columns || []) header.append(text("th", column)); head.append(header); table.append(head); const body = document.createElement("tbody"); for (const row of content.rows || []) { const tr = document.createElement("tr"); for (const cell of row) tr.append(text("td", cell == null ? "" : String(cell))); body.append(tr); } table.append(body); paper.append(table); return paper; };
  const renderSlides = (content) => { const deck = text("section", "", "slides"); for (const slide of content.slides || []) { const card = text("article", "", "slide"); card.append(text("h2", slide.title)); if (slide.bullets?.length) { const list = document.createElement("ul"); for (const bullet of slide.bullets) list.append(text("li", bullet)); card.append(list); } deck.append(card); } return deck; };
  const gadgetCard = (gadget, role) => { const card = text("article", "", "resource-card"); card.append(text("h2", gadget.name), text("p", gadget.description || "Shared Gadget")); if (gadget.revision) { card.append(text("span", "Revision " + gadget.revision.revision, "kind")); const manifest = gadget.revision.manifest || {}; if (manifest.entry) card.append(text("p", manifest.entry)); if (role === "build") card.append(text("pre", JSON.stringify(manifest, null, 2))); } return card; };
  const render = (data) => { root.replaceChildren(); const resource = data.resource; const share = data.share; const title = resource.type === "output" ? resource.output.title : resource.type === "gadget" ? resource.gadget.name : resource.workspace.name; const meta = text("section", "", "meta"); meta.append(text("h1", title), text("span", share.effectiveRole + " access", "kind"), text("span", share.revisionMode + " revision")); if (share.policyReason) meta.append(text("span", "Policy limited: " + share.policyReason)); root.append(meta); if (resource.type === "output") { const content = resource.revision.content; root.append(content.kind === "sheet" ? renderSheet(content) : content.kind === "presentation" ? renderSlides(content) : renderDocument(content)); } else if (resource.type === "gadget") root.append(gadgetCard({ ...resource.gadget, revision: resource.revision }, share.effectiveRole)); else for (const gadget of resource.gadgets || []) root.append(gadgetCard(gadget, share.effectiveRole)); document.title = title + " — Shared with Tedix"; };
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token");
  history.replaceState(null, "", location.pathname + location.search);
  if (!token) return fail();
  let sessionToken = null;
  fetch("/os-shared/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
    .then((response) => response.ok ? response.json() : Promise.reject())
    .then((data) => { sessionToken = data.sessionToken; render(data); window.setInterval(() => { if (!sessionToken) return; fetch("/os-shared/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionToken }) }).then((response) => response.ok ? response.json() : Promise.reject()).then(render, () => { sessionToken = null; fail(); }); }, 3000); }, fail);
})();`;

function response(body: string, contentType: string): Response {
	return new Response(body, {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"Content-Security-Policy": VIEWER_CSP,
		},
	});
}

export function handleOsShareViewer(): Response {
	return response(VIEWER_HTML, "text/html; charset=utf-8");
}

export function handleOsShareViewerScript(): Response {
	return response(VIEWER_JS, "text/javascript; charset=utf-8");
}

export function handleOsShareViewerStyles(): Response {
	return response(VIEWER_CSS, "text/css; charset=utf-8");
}
