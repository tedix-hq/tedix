const script = document.createElement("script");
script.type = "text/plain";
script.dataset.tedixTenant = "demo-model-picker";
document.head.append(script);
await import("../../widget/src/embed/embed.mjs");
(
	window as unknown as {
		Tedix: { init(options: Record<string, unknown>): void };
	}
).Tedix.init({
	script,
	branding: false,
	locale: "en-US",
	session: async () => ({
		token: "fixture-token",
		streamUrl: "ws://127.0.0.1:9/embedded",
		expiresAt: Date.now() + 3_600_000,
		modelSelection: {
			models: [
				{ ref: "cloudflare/auto", label: "Cloudflare Auto" },
				{ ref: "fast", label: "Fast" },
			],
			defaultRef: "fast",
		},
	}),
	home: { label: "Home", turn: async () => ({ text: "Fixture answer" }) },
});
