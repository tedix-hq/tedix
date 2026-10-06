// Local-only synthetic harness. Never contacts tenant or Tedix services.
const port = Number(process.env.TEDI_PREVIEW_PORT || 4179);
const origin = `http://127.0.0.1:${port}`;
const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tedi widget — local synthetic preview</title><style>body{margin:0;background:#f4f5f7;color:#18181b;font:14px system-ui}header{padding:24px;background:white;border-bottom:1px solid #ddd}main{padding:32px;max-width:900px}h1{font-size:24px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{padding:24px;border:1px solid #ddd;border-radius:16px;background:white}strong{font-size:28px;display:block;margin-top:16px}.notice{padding:12px;background:#fff4d6;border-radius:8px;margin-bottom:24px}</style></head><body><header>Example host · Tedi embed preview</header><main><div class="notice">LOCAL SYNTHETIC DATA — no live tenant, no external requests</div><h1>Panel de operaciones</h1><div class="cards"><div class="card">Órdenes de ejemplo<strong>24</strong></div><div class="card">En proceso<strong>8</strong></div><div class="card">Listas para entregar<strong>4</strong></div></div></main><script src="/embed.js" data-tedix-tenant="preview" data-tedix-title="Tedi" data-tedix-subtitle="Tu compañero de operaciones"></script></body></html>`;

const event = (id, body) =>
	`id: preview-run:${id}\ndata: ${JSON.stringify(body)}\n\n`;
Bun.serve({
	port,
	hostname: "127.0.0.1",
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/embed.js") {
			return new Response(
				Bun.file(new URL("../public/embed.js", import.meta.url)),
				{
					headers: {
						"Content-Type": "text/javascript",
						"Cache-Control": "no-store",
					},
				},
			);
		}
		if (url.pathname === "/r/tedi/session") {
			return Response.json({
				token: "local-synthetic",
				streamUrl: `${origin}/chat`,
				expiresAt: Date.now() + 60_000,
			});
		}
		if (url.pathname === "/chat/approvals") return Response.json({ data: [] });
		if (url.pathname.startsWith("/chat/approvals/"))
			return Response.json({ ok: true });
		if (url.pathname === "/chat/cancel") return Response.json({ ok: true });
		if (url.pathname === "/chat") {
			const answer =
				"## Resumen de ejemplo\nHay **24 órdenes** en este panel de prueba.\n- 8 están en proceso\n- 4 están listas para entregar\n\nPuedo ayudarte a revisar el siguiente paso. No he cambiado ningún dato.";
			return new Response(
				event(1, {
					kind: "chunk",
					body: {
						type: "tool-input-available",
						toolCallId: "preview-status",
						toolName: "get_order_status",
					},
				}) +
					event(2, {
						kind: "chunk",
						body: {
							type: "tool-output-available",
							toolCallId: "preview-status",
							toolName: "get_order_status",
							output: { total: 24 },
						},
					}) +
					event(3, { kind: "done", text: answer }),
				{
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-store",
					},
				},
			);
		}
		return new Response(html, { headers: { "Content-Type": "text/html" } });
	},
});
console.log(`Synthetic Tedi widget preview: ${origin}/m/dashboard`);
