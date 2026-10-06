import { fileURLToPath } from "node:url";
import { getViteConfig } from "./templates/marketing/node_modules/astro/dist/config/entrypoint.js";
import react from "./templates/marketing/node_modules/@astrojs/react/dist/index.js";

const template = fileURLToPath(
	new URL("./templates/marketing/", import.meta.url),
);
const formEmbed = fileURLToPath(
	new URL(
		"./templates/marketing/node_modules/@emdash-cms/plugin-forms/src/astro/FormEmbed.astro",
		import.meta.url,
	),
);
const stubs = {
	"virtual:emdash/wait-until": "export const waitUntil = undefined;",
	"virtual:emdash/config": "export default {};",
	"virtual:emdash/env": "export const env = undefined;",
	"virtual:emdash/scheduler": "export const createScheduler = null;",
	"virtual:emdash/build": "export const buildTime = 0;",
	"virtual:emdash/media-providers": "export const mediaProviders = [];",
	"virtual:emdash/block-components": `import FormEmbed from ${JSON.stringify(formEmbed)}; export const pluginBlockComponents = { "emdash-form": FormEmbed };`,
};

export default getViteConfig(
	{
		plugins: [
			{
				name: "cms-render-fixtures",
				resolveId(id) {
					return Object.hasOwn(stubs, id) ? `\0${id}` : null;
				},
				load(id) {
					return stubs[id.startsWith("\0") ? id.slice(1) : id] ?? null;
				},
			},
		],
		ssr: { noExternal: ["emdash", "astro-portabletext"] },
		test: { include: ["../../tests-render/*.render.ts"], environment: "node" },
	},
	{
		root: template,
		configFile: false,
		integrations: [react()],
		image: { service: { entrypoint: "astro/assets/services/noop" } },
	},
);
