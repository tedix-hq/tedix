import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";

const execute = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const template = path.join(repo, "apps/cms/templates/tedix");
const component = path.join(
	template,
	"src/components/EditorialPortableText.astro",
);

it("renders native keyed and unkeyed editorial anchors independently per body", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "cms-native-headings-"));
	const fixture = path.join(directory, "headings.render.ts");
	const pair = path.join(directory, "Pair.astro");
	const config = path.join(directory, "render.config.mjs");
	const results = path.join(directory, "results.json");
	try {
		await writeFile(
			pair,
			`---\nimport Editorial from ${JSON.stringify(component)};\nconst { bodies } = Astro.props;\n---\n{bodies.map(value => <Editorial {value} />)}\n`,
		);
		await writeFile(
			fixture,
			`
import { experimental_AstroContainer as Container } from ${JSON.stringify(path.join(template, "node_modules/astro/dist/container/index.js"))};
import { it } from ${JSON.stringify(path.join(repo, "node_modules/vite-plus/dist/test/index.js"))};
import { writeFileSync } from 'node:fs';
import Editorial from ${JSON.stringify(component)};
import Pair from ${JSON.stringify(pair)};
const heading=(text,style='h2',key)=>({_type:'block',...(key?{_key:key}:{}),style,markDefs:[],children:[{_type:'span',text,marks:['strong']}]});
const list={_type:'block',_key:'list',style:'normal',listItem:'bullet',level:1,markDefs:[],children:[{_type:'span',text:'Before headings',marks:[]}]};
it('renders through installed Emdash PortableText list and mark normalization',async()=>{
 const bodies=[
  [list,heading('Nuestra Historia'),heading('Nuestra Historia','h3'),heading('   '),heading('Después','h2','last')],
  [heading('Other body','h2','first'),heading('Other body','h3','second')]
 ];
 const before=JSON.stringify(bodies);
 const c=await Container.create();
 const unkeyed=await c.renderToString(Editorial,{props:{value:bodies[0]},locals:{}});
 const keyed=await c.renderToString(Editorial,{props:{value:bodies[1]},locals:{}});
 const paired=await c.renderToString(Pair,{props:{bodies},locals:{}});
 writeFileSync(${JSON.stringify(results)},JSON.stringify({unkeyed,keyed,paired,unchanged:before===JSON.stringify(bodies)}));
});`,
		);
		const stubs = {
			"virtual:emdash/wait-until": "export const waitUntil = undefined;",
			"virtual:emdash/config": "export default {};",
			"virtual:emdash/env": "export const env = undefined;",
			"virtual:emdash/scheduler": "export const createScheduler = null;",
			"virtual:emdash/build": "export const buildTime = 0;",
			"virtual:emdash/media-providers": "export const mediaProviders = [];",
			"virtual:emdash/block-components":
				"export const pluginBlockComponents = {};",
		};
		await writeFile(
			config,
			`import { getViteConfig } from ${JSON.stringify(path.join(template, "node_modules/astro/dist/config/entrypoint.js"))};
const stubs=${JSON.stringify(stubs)};
export default getViteConfig({plugins:[{name:'native-heading-fixtures',resolveId(id){return Object.hasOwn(stubs,id)?'\\0'+id:null},load(id){return stubs[id.startsWith('\\0')?id.slice(1):id]??null}}],ssr:{noExternal:['emdash','astro-portabletext']},test:{include:[${JSON.stringify(fixture)}],environment:'node'}},{root:${JSON.stringify(template)},configFile:false,image:{service:{entrypoint:'astro/assets/services/noop'}}});`,
		);
		await execute(
			path.join(repo, "node_modules/.bin/vp"),
			["test", "run", "--config", config],
			{ cwd: repo, timeout: 60_000 },
		);
		const rendered = JSON.parse(await readFile(results, "utf8")) as {
			unkeyed: string;
			keyed: string;
			paired: string;
			unchanged: boolean;
		};
		const ids = (html: string) =>
			[...html.matchAll(/<h[23]\b[^>]*\bid="([^"]+)"/g)].map(
				(match) => match[1],
			);
		expect(ids(rendered.unkeyed)).toEqual([
			"nuestra-historia",
			"nuestra-historia-2",
			"despues",
		]);
		expect(ids(rendered.keyed)).toEqual(["other-body", "other-body-2"]);
		expect(ids(rendered.paired)).toEqual([
			...ids(rendered.unkeyed),
			...ids(rendered.keyed),
		]);
		expect(rendered.unkeyed).toContain("<ul>");
		expect(rendered.unkeyed).toContain("<strong>Nuestra Historia</strong>");
		expect(rendered.unchanged).toBe(true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 70_000);
