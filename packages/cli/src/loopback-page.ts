/**
 * Minimal branded page served by the CLI's local loopback listeners. These
 * render for a second or two in the operator's browser between the hosted auth
 * surfaces and the terminal, so they match Tedix OS's dark account styling
 * instead of default user-agent HTML.
 */
export function renderLoopbackPage(options: {
	title: string;
	heading: string;
	body: string;
	tone?: "ok" | "error";
}): string {
	const escapeHtml = (value: string) =>
		value.replace(
			/[&<>"']/g,
			(character) =>
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;",
				})[character]!,
		);
	const tone = options.tone ?? "ok";
	const markColor = tone === "ok" ? "#8b7bf7" : "#e5484d";
	const markGlyph = tone === "ok" ? "✓" : "✕";
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
	body {
		margin: 0;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 14px;
		min-height: 100dvh;
		padding: 24px;
		background: #0b0a10;
		color: #ebe9f2;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
		text-align: center;
	}
	.mark {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border-radius: 50%;
		background: color-mix(in srgb, ${markColor} 18%, transparent);
		color: ${markColor};
		font-size: 22px;
		font-weight: 700;
	}
	.eyebrow {
		margin: 0;
		color: #8f8ba0;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.14em;
	}
	h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -0.2px; }
	p { margin: 0; max-width: 42ch; color: #a6a2b5; font-size: 14px; line-height: 1.5; }
</style>
</head>
<body>
<div class="mark" aria-hidden="true">${markGlyph}</div>
<p class="eyebrow">TEDIX CLI</p>
<h1>${escapeHtml(options.heading)}</h1>
<p>${escapeHtml(options.body)}</p>
</body>
</html>`;
}
