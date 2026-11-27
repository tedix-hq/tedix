import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createElement,
	renderToStaticMarkup,
	templateI18n,
	withTemplateI18n,
} from "./test-utils/template-react";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	fields,
	pages,
} from "../templates/tedix/src/plugins/tedix-site-builder/admin";
import { createPlugin } from "../templates/tedix/src/plugins/tedix-site-builder/index";

vi.mock("emdash", () => ({ definePlugin: (plugin: unknown) => plugin }));
beforeEach(() => templateI18n.loadAndActivate({ locale: "en", messages: {} }));
afterEach(() => vi.unstubAllGlobals());

describe("native generated search text widget", () => {
	it("renders generated text collapsed and read-only without calling onChange", () => {
		const onChange = vi.fn();
		const markup = renderToStaticMarkup(
			withTemplateI18n(
				createElement(fields["derived-search-text"], {
					value: "<script>not executable</script>",
					onChange,
				} as never),
			),
		);
		expect(markup).toContain("<details>");
		expect(markup).toContain("&lt;script&gt;not executable&lt;/script&gt;");
		expect(markup).not.toMatch(
			/<(input|textarea)|contenteditable|<details open/,
		);
		expect(onChange).not.toHaveBeenCalled();
	});
	it("registers the text widget in the plugin and both native descriptors", () => {
		expect(createPlugin().admin?.fieldWidgets).toContainEqual({
			name: "derived-search-text",
			label: "Generated search text",
			fieldTypes: ["text"],
		});
		for (const template of ["tedix", "marketing"]) {
			const config = readFileSync(
				new URL(`../templates/${template}/astro.config.mjs`, import.meta.url),
				"utf8",
			);
			expect(config).toMatch(
				/fieldWidgets:\s*\[\s*\{\s*name:\s*"derived-search-text"/,
			);
		}
	});
});

describe("native editing navigation", () => {
	it("keeps code management separate from native preview and editing", () => {
		vi.stubGlobal("__TEDIX_OS_SITES_URL__", "https://acme.os.tedix.dev/sites");
		const markup = renderToStaticMarkup(
			withTemplateI18n(createElement(pages["/development"])),
		);
		expect(markup).toContain("Code and deployments");
		expect(markup).toContain("https://acme.os.tedix.dev/sites");
		expect(markup).not.toContain("<iframe");
		expect(createPlugin().admin?.pages).toEqual([
			{ path: "/back-to-tedix", label: "Back to Tedix", icon: "arrow-left" },
			{ path: "/development", label: "Code and deployments", icon: "code" },
		]);
		expect(createPlugin().admin).not.toHaveProperty("widgets");
	});
});

it("restores plugin catalogs before navigation and pages render on boot and locale switches", () => {
	vi.stubGlobal("__TEDIX_OS_SITES_URL__", "https://acme.os.tedix.dev/sites");
	const require = createRequire(
		new URL("../templates/tedix/package.json", import.meta.url),
	);
	const directory = dirname(require.resolve("@emdash-cms/admin"));
	const chunk = readdirSync(directory).find(
		(name) => name.startsWith("App-") && name.endsWith(".js"),
	)!;
	const host = readFileSync(`${directory}/${chunk}`, "utf8");
	const resolver = host.match(
		/function resolvePluginPageLabel[\s\S]+?(?=\n\/\*\*)/,
	)?.[0];
	const translator = host.match(
		/function declaredLabelTranslator[\s\S]+?(?=\n\/\*\*)/,
	)?.[0];
	if (!resolver || !translator)
		throw new Error("Installed host label translation path not found");
	const translateLabel = new Function(
		"i18n",
		`${resolver}; ${translator}; return (label) => resolvePluginPageLabel(label, "tedix-site-builder", declaredLabelTranslator(i18n, id => i18n._(id)));`,
	)(templateI18n);
	for (const [locale, title, empty] of [
		["de", "Code und Bereitstellungen", "Noch kein Suchtext vorhanden."],
		["en", "Code and deployments", "No search text yet."],
		["ar", "البرمجة والنشر", "لا يوجد نص بحث بعد."],
		["de", "Code und Bereitstellungen", "Noch kein Suchtext vorhanden."],
	] as const) {
		templateI18n.loadAndActivate({
			locale,
			messages: { host: ["Host message"] },
		});
		expect(templateI18n._("host")).toBe("Host message");
		expect(translateLabel(createPlugin().admin!.pages![1]!.label)).toBe(title);
		const page = renderToStaticMarkup(
			withTemplateI18n(createElement(pages["/development"])),
		);
		const widget = renderToStaticMarkup(
			withTemplateI18n(
				createElement(fields["derived-search-text"], { value: "" }),
			),
		);
		expect(page).toContain(`<h1>${title}</h1>`);
		expect(widget).toContain(empty);
	}
});

describe("registry declarative field widget", () => {
	it("publishes active registry metadata, resolves and renders the native JSON editor, preserving sibling values", async () => {
		const require = createRequire(
			new URL("../templates/tedix/package.json", import.meta.url),
		);
		const readChunk = (
			directory: string,
			prefix: string,
			extension: string,
		) => {
			const file = readdirSync(directory).find(
				(name) => name.startsWith(prefix) && name.endsWith(extension),
			);
			if (!file) throw new Error(`Installed ${prefix} chunk not found`);
			return readFileSync(`${directory}/${file}`, "utf8");
		};
		const runtime = readChunk(
			dirname(require.resolve("emdash")),
			"emdash-runtime-",
			".mjs",
		);
		const admin = readChunk(
			dirname(require.resolve("@emdash-cms/admin")),
			"App-",
			".js",
		);
		// These private functions are not exported. Execute the installed code,
		// rather than reproducing the manifest publisher or the editor in a fixture.
		const publisher = runtime.match(
			/for \(const \[pluginId, meta\] of marketplaceManifestCache\)[\s\S]+?(?=\n\t\tlet manifestTaxonomies)/,
		)?.[0];
		const resolver = admin.match(
			/function resolvePluginFieldWidget[\s\S]+?(?=\nfunction resolveEditorBylines)/,
		)?.[0];
		const renderer = admin.match(
			/function BlockKitFieldWidget[\s\S]+?(?=\n\/\/#endregion)/,
		)?.[0];
		if (!publisher || !resolver || !renderer)
			throw new Error("Installed registry editor path not found");
		const widget = {
			name: "caption",
			label: "Caption details",
			fieldTypes: ["json"],
			elements: [
				{
					type: "text_input",
					action_id: "caption",
					label: "<Caption>",
					placeholder: "Enter caption",
				},
			],
		};
		const publish = new Function(
			"marketplaceManifestCache",
			`
			const manifestPlugins = {};
			${publisher}
			return { plugins: manifestPlugins };
		`,
		);
		const meta = new Map([
			[
				"caption-plugin",
				{ version: "1.0.0", admin: { fieldWidgets: [widget] } },
			],
		]);
		const manifest = publish.call(
			{ pluginStates: new Map([["caption-plugin", "active"]]) },
			meta,
		);
		const resolveWidget = new Function(
			`${resolver}; return resolvePluginFieldWidget;`,
		)();
		const resolved = resolveWidget("caption-plugin:caption", {}, manifest);
		expect(resolved).toEqual({ type: "sandboxed", elements: widget.elements });
		expect(resolveWidget("caption-plugin:other", {}, manifest)).toBeNull();
		expect(
			resolveWidget(
				"caption-plugin:caption",
				{},
				publish.call({ pluginStates: new Map() }, new Map()),
			),
		).toBeNull();
		expect(
			resolveWidget(
				"caption-plugin:caption",
				{},
				publish.call(
					{ pluginStates: new Map([["caption-plugin", "disabled"]]) },
					meta,
				),
			),
		).toBeNull();

		const react = await import(pathToFileURL(require.resolve("react")).href);
		const { Input } = await import(
			new URL(
				"../templates/tedix/node_modules/@cloudflare/kumo/dist/components/input.js",
				import.meta.url,
			).href
		);
		let change: ((event: { target: { value: string } }) => void) | undefined;
		const Widget = new Function(
			"React$1",
			"jsx",
			"jsxs",
			"Input",
			"useLingui",
			`${renderer}; return BlockKitFieldWidget;`,
		)(
			react,
			createElement,
			createElement,
			(props: { onChange: typeof change }) => {
				change = props.onChange;
				return createElement(Input, props);
			},
			() => ({ _: () => "" }),
		);
		const onChange = vi.fn();
		const markup = renderToStaticMarkup(
			createElement(Widget, {
				label: widget.label,
				elements: resolved.elements,
				value: { caption: "<script>not executable</script>", sibling: "keep" },
				onChange,
			}),
		);
		expect(markup).toContain("<input");
		expect(markup).toContain("&lt;Caption&gt;");
		expect(markup).toContain("&lt;script&gt;not executable&lt;/script&gt;");
		expect(markup).not.toContain("<script>");
		expect(onChange).not.toHaveBeenCalled();
		expect(change).toBeTypeOf("function");
		change!({ target: { value: "Updated caption" } });
		expect(onChange).toHaveBeenCalledWith({
			caption: "Updated caption",
			sibling: "keep",
		});
	});
});
