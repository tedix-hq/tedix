import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publicJsManifest } from "./public-js-budget.ts";

const { default: config } = await import(
	/* @vite-ignore */ pathToFileURL(resolve("astro.config.mjs")).href
);

export default {
	...config,
	vite: {
		...config.vite,
		plugins: [...(config.vite?.plugins ?? []), publicJsManifest()],
	},
};
