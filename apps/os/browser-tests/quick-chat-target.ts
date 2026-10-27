/**
 * The real widget runtime with a host that answers the way the OS does:
 * `tedi_unavailable` when this person has no allowed tedi, otherwise a
 * session bound to the first allowed one.
 */
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "home-no-tedi";
const script = document.createElement("script");
script.type = "text/plain";
script.dataset.tedixTenant = "demo-target";
document.head.append(script);
await import("../../widget/src/embed/embed.mjs");
const allowed =
	scenario === "home-no-tedi" || scenario === "no-home-no-tedi"
		? []
		: [
				{ id: "tedi-a", name: "Support" },
				{ id: "tedi-b", name: "Sales" },
			];
(window as unknown as { sessionRequests: unknown[] }).sessionRequests = [];
(
	window as unknown as {
		Tedix: { init(options: Record<string, unknown>): void };
	}
).Tedix.init({
	script,
	branding: false,
	locale: "en-US",
	product: "Acme",
	themeMode: params.get("theme") === "dark" ? "dark" : "light",
	preferenceKey: "person-1",
	session: async (request: { selectedTediId?: string }) => {
		(window as unknown as { sessionRequests: unknown[] }).sessionRequests.push(
			request,
		);
		if (!allowed.length)
			throw Object.assign(new Error("No tedi is available to you here."), {
				code: "tedi_unavailable",
			});
		const selected =
			allowed.find((tedi) => tedi.id === request.selectedTediId) ?? allowed[0]!;
		return {
			token: "fixture-token",
			streamUrl: "ws://127.0.0.1:9/embedded",
			expiresAt: Date.now() + 3_600_000,
			tediSelection: { selectedTediId: selected.id, tedis: allowed },
		};
	},
	...(scenario === "no-home-no-tedi"
		? {}
		: { home: { label: "Home", turn: async () => ({ text: "Home answer" }) } }),
});
