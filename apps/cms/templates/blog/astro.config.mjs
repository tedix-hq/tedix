import { defineConfig, fontProviders } from "astro/config";
import platform from "./cms.config.mjs";

export default defineConfig({
	...platform,
	i18n: { ...platform.i18n, defaultLocale: "en", fallback: {} },
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
});
