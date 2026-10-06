import { defineConfig, fontProviders } from "astro/config";
import platform from "./cms.config.mjs";

export default defineConfig({
	...platform,
	i18n: { ...platform.i18n, defaultLocale: "en", fallback: {} },
	fonts: [],
});
