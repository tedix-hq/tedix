import {
	APP_RUNTIME_CLIENT_MODULE,
	AppRuntimeMethodSchema,
	AppRuntimeArgumentsSchema,
	type AppRuntimeFiles,
	type AppRuntimeRole,
} from "@tedix/api-contract/schemas/os-app-runtime";
import type {
	OsGadgetManifest,
	OsOutputContent,
	OsWorkspaceResource,
} from "@tedix/api-contract/schemas/os-workspaces";
import { appRuntimePermission } from "@tedix/api-contract/utils/app-runtime";
import type { JsonValue } from "@tedix/api-contract/schemas/common";

/**
 * The browser half of the workspace app host. `client.js` runs in the OS
 * sandbox and can only talk to this module; this module decides what the app
 * may ask for (the shared role x operation matrix plus the manifest's grants)
 * and performs the allowed reads with the signed-in person's own session. The
 * app never sees a cookie, a token or another app's data.
 *
 * Server-side calls (`app.call`) belong to the app's own isolated instance,
 * served by the runtime through a signed session pinned to the displayed revision.
 */

/** A resource slot that names an Output the app may read: `providerId` tedix, `resourceType` output. */
export const APP_RUNTIME_OUTPUT_RESOURCE = {
	providerId: "tedix",
	resourceType: "output",
} as const;

export const APP_RUNTIME_CALL_METHOD = "tedix/call";

export interface AppRuntimeContext {
	workspaceId: string;
	gadget: { id: string; name: string; revision: number };
	role: AppRuntimeRole;
	/** `config.settings` from the manifest: the tenant's data, never code. */
	settings: Record<string, JsonValue>;
	/** Slots the app may read or write, with the operations each allows. */
	grants: ReadonlyArray<{ slot: string; operations: readonly string[] }>;
}

export type AppRuntimeHostError =
	| "not_permitted"
	| "unknown_method"
	| "bad_arguments"
	| "slot_unbound"
	| "host_unavailable";

export type AppRuntimeHostResult =
	| { ok: true; value: unknown }
	| { ok: false; error: AppRuntimeHostError; detail?: string };

export interface AppRuntimeHostDeps {
	context: AppRuntimeContext;
	resources: readonly OsWorkspaceResource[];
	readOutput: (outputId: string) => Promise<OsOutputContent>;
	/**
	 * Read a granted slot where the host cannot see the workspace's resource
	 * rows (a share-link guest): the server resolves the slot itself.
	 */
	readSlot?: (slot: string) => Promise<OsOutputContent>;
	callServer?: (method: string, args: JsonValue[]) => Promise<JsonValue>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a granted slot to the Output it is bound to in this workspace. */
export function outputIdForSlot(
	resources: readonly OsWorkspaceResource[],
	slot: string,
): string | null {
	const resource = resources.find(
		(candidate) =>
			candidate.slot === slot &&
			candidate.status === "active" &&
			candidate.providerId === APP_RUNTIME_OUTPUT_RESOURCE.providerId &&
			candidate.resourceType === APP_RUNTIME_OUTPUT_RESOURCE.resourceType,
	);
	return resource?.providerResourceId ?? null;
}

/** Answer one call from the sandboxed client. Every branch is the matrix's decision, not the app's. */
export async function handleAppRuntimeCall(
	deps: AppRuntimeHostDeps,
	method: unknown,
	args: unknown,
): Promise<AppRuntimeHostResult> {
	const { context } = deps;
	switch (method) {
		case "context":
			return { ok: true, value: context };
		case "outputs.read": {
			if (!isRecord(args) || typeof args.slot !== "string")
				return { ok: false, error: "bad_arguments", detail: "slot" };
			const permission = appRuntimePermission({
				role: context.role,
				operation: "outputs.read",
				grants: context.grants,
				slot: args.slot,
			});
			if (!permission.allowed)
				return { ok: false, error: "not_permitted", detail: permission.reason };
			if (deps.readSlot)
				return { ok: true, value: await deps.readSlot(args.slot) };
			const outputId = outputIdForSlot(deps.resources, args.slot);
			if (!outputId) return { ok: false, error: "slot_unbound" };
			return { ok: true, value: await deps.readOutput(outputId) };
		}
		case "app.call": {
			const permission = appRuntimePermission({
				role: context.role,
				operation: "app.call",
				grants: context.grants,
			});
			if (!permission.allowed)
				return { ok: false, error: "not_permitted", detail: permission.reason };
			if (!isRecord(args)) return { ok: false, error: "bad_arguments" };
			const name = AppRuntimeMethodSchema.safeParse(args.method);
			const parameters = AppRuntimeArgumentsSchema.safeParse(args.args ?? []);
			if (!name.success || !parameters.success)
				return { ok: false, error: "bad_arguments" };
			if (!deps.callServer) return { ok: false, error: "host_unavailable" };
			return {
				ok: true,
				value: await deps.callServer(name.data, parameters.data),
			};
		}
		default:
			return { ok: false, error: "unknown_method" };
	}
}

/** `config.settings` from an app manifest, or none. */
export function appRuntimeSettings(
	manifest: OsGadgetManifest | undefined,
): Record<string, JsonValue> {
	const config = isRecord(manifest?.config) ? manifest.config : {};
	return isRecord(config.settings)
		? (config.settings as Record<string, JsonValue>)
		: {};
}

/** The grants and settings an app context carries, read from its manifest. */
export function appRuntimeContextFromManifest(
	manifest: OsGadgetManifest,
	base: Omit<AppRuntimeContext, "settings" | "grants">,
): AppRuntimeContext {
	return {
		...base,
		settings: appRuntimeSettings(manifest),
		grants: (manifest.resourceGrants ?? []).map((grant) => ({
			slot: grant.slot,
			operations: grant.operations,
		})),
	};
}

const escapeScript = (source: string) =>
	source.replace(/<\/script/gi, "<\\/script");

/** Host to app: translate the visible text (`target`) or show the original (`target: null`). */
export const APP_RUNTIME_TRANSLATE_METHOD = "tedix/translate";
/** Host to app: name the language of the text the app shows. */
export const APP_RUNTIME_DETECT_LANGUAGE_METHOD = "tedix/detect-language";
/** App to host: progress and result of a translate request. */
export const APP_RUNTIME_TRANSLATION_METHOD = "tedix/translation";
/** App to host: the detected language, or null. */
export const APP_RUNTIME_LANGUAGE_METHOD = "tedix/language";

export interface AppRuntimeTranslateParams {
	/** BCP 47 code of the app's own text. */
	source: string;
	/** Target language, or null to restore the original text. */
	target: string | null;
	/** Fixed wording for whole texts, keyed by the trimmed original. */
	glossary?: Record<string, string>;
}

export type AppRuntimeTranslationStatus =
	| { state: "downloading"; progress: number }
	| { state: "translating" | "translated"; language: string }
	| { state: "original" }
	| { state: "unavailable"; detail?: string };

/** The fixed wording `settings.glossary[target]` names, strings only. */
export function appRuntimeGlossary(
	settings: Record<string, JsonValue>,
	target: string,
): Record<string, string> {
	const glossary = settings.glossary;
	const entries = isRecord(glossary) ? glossary[target] : undefined;
	if (!isRecord(entries)) return {};
	return Object.fromEntries(
		Object.entries(entries).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

/**
 * Translation inside the app document, driven only by the host. It swaps the
 * visible text and placeholders in place with the browser's on-device
 * translator, keeps the app's own nodes (so its handlers and state survive),
 * follows re-renders, and restores the original on request. Elements marked
 * `translate="no"` and texts without letters stay as they are; the app's code
 * and data are never changed, so copies and server calls keep the original.
 */
export const APP_RUNTIME_TRANSLATION_SCRIPT = `(function(){
	var post=function(method,params){window.parent.postMessage({jsonrpc:"2.0",method:method,params:params},"*");};
	var status=function(params){post(${JSON.stringify(APP_RUNTIME_TRANSLATION_METHOD)},params);};
	var letters=/\\p{L}/u;
	var t={run:0,target:null,translator:null,glossary:{},pair:null,done:new Map(),pending:new Map(),pairs:new Map(),tracked:new Map()};
	function items(){
		var out=[];
		var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:function(node){
			var parent=node.parentElement;
			return !parent||parent.closest("script,style,noscript,[translate=no]")||!letters.test(node.nodeValue)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;
		}});
		for(var node=walker.nextNode();node;node=walker.nextNode())out.push([node,"nodeValue"]);
		document.body.querySelectorAll("input[placeholder],textarea[placeholder]").forEach(function(field){
			if(!field.closest("[translate=no]")&&letters.test(field.placeholder))out.push([field,"placeholder"]);
		});
		return out;
	}
	function write(node,key,original,value){
		t.tracked.set(node,{key:key,original:original,written:value});
		node[key]=value;
	}
	function translate(text){
		var job=t.pending.get(text);
		if(!job){
			job=t.translator.translate(text).then(function(result){t.done.set(text,result);return result;});
			job.catch(function(){t.pending.delete(text);});
			t.pending.set(text,job);
		}
		return job;
	}
	// Swap known texts in at once, then fetch the rest. A text the app changed
	// meanwhile is left for the next pass.
	function pass(){
		var run=t.run;
		if(!t.target)return Promise.resolve();
		t.tracked.forEach(function(seen,node){if(!node.isConnected)t.tracked.delete(node);});
		var jobs=[];
		items().forEach(function(item){
			var node=item[0],key=item[1],value=node[key],seen=t.tracked.get(node);
			if(seen&&seen.written===value)return;
			var parts=/^(\\s*)([\\s\\S]*?)(\\s*)$/.exec(value);
			var known=Object.prototype.hasOwnProperty.call(t.glossary,parts[2])?t.glossary[parts[2]]:t.done.get(parts[2]);
			if(known!==undefined){write(node,key,value,parts[1]+known+parts[3]);return;}
			jobs.push(translate(parts[2]).then(function(result){
				if(run===t.run&&node.isConnected&&node[key]===value)write(node,key,value,parts[1]+result+parts[3]);
			},function(){}));
		});
		return Promise.all(jobs);
	}
	var observer=new MutationObserver(function(){pass();});
	function restore(){
		observer.disconnect();
		t.tracked.forEach(function(seen,node){if(node[seen.key]===seen.written)node[seen.key]=seen.original;});
		t.tracked.clear();
		t.target=null;
	}
	function translator(source,target){
		var pair=source+">"+target,job=t.pairs.get(pair);
		if(!job){
			job=Translator.create({sourceLanguage:source,targetLanguage:target,monitor:function(monitor){
				monitor.addEventListener("downloadprogress",function(event){status({state:"downloading",progress:event.loaded});});
			}});
			job.catch(function(){t.pairs.delete(pair);});
			t.pairs.set(pair,job);
		}
		return job.then(function(created){
			if(t.pair!==pair){t.pair=pair;t.done=new Map();t.pending=new Map();}
			return created;
		});
	}
	function setLanguage(params){
		var run=++t.run;
		restore();
		if(!params.target){status({state:"original"});return;}
		if(typeof Translator==="undefined"){status({state:"unavailable",detail:"no_translator"});return;}
		status({state:"translating",language:params.target});
		translator(String(params.source),String(params.target)).then(function(created){
			if(run!==t.run)return;
			var glossary={};
			if(params.glossary&&typeof params.glossary==="object")Object.keys(params.glossary).forEach(function(key){
				if(typeof params.glossary[key]==="string")glossary[key]=params.glossary[key];
			});
			t.target=params.target;t.translator=created;t.glossary=glossary;
			observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["placeholder"]});
			return pass().then(function(){if(run===t.run)status({state:"translated",language:params.target});});
		},function(error){
			if(run===t.run)status({state:"unavailable",detail:error&&error.name||"failed"});
		});
	}
	// An app that is still loading gets a few seconds to show its first text.
	function detect(waited){
		var text=document.body.innerText.trim();
		if(!letters.test(text)&&!waited&&typeof LanguageDetector!=="undefined"){
			var wait=new MutationObserver(function(){if(letters.test(document.body.innerText)){wait.disconnect();clearTimeout(timer);detect(true);}});
			var timer=setTimeout(function(){wait.disconnect();detect(true);},5000);
			wait.observe(document.body,{subtree:true,childList:true,characterData:true});
			return;
		}
		if(typeof LanguageDetector==="undefined"||!letters.test(text)){post(${JSON.stringify(APP_RUNTIME_LANGUAGE_METHOD)},{language:null});return;}
		LanguageDetector.create().then(function(detector){return detector.detect(text.slice(0,2000));}).then(function(results){
			var best=results&&results[0];
			post(${JSON.stringify(APP_RUNTIME_LANGUAGE_METHOD)},{language:best&&best.detectedLanguage!=="und"&&best.confidence>=0.5?best.detectedLanguage:null});
		},function(){post(${JSON.stringify(APP_RUNTIME_LANGUAGE_METHOD)},{language:null});});
	}
	window.addEventListener("message",function(event){
		var data=event.data;
		if(event.source!==window.parent||!data||typeof data!=="object"||data.jsonrpc!=="2.0")return;
		if(data.method===${JSON.stringify(APP_RUNTIME_TRANSLATE_METHOD)}&&data.params&&typeof data.params==="object")setLanguage(data.params);
		else if(data.method===${JSON.stringify(APP_RUNTIME_DETECT_LANGUAGE_METHOD)})detect(false);
	});
})();`;

/**
 * The document the sandbox runs: a small `tedix` object that turns
 * `tedix.call(method, args)` into a JSON-RPC message for the host, then the
 * app's `client.js` as an inline module. The proxy adds the CSP; the app has
 * no network and no origin of its own.
 */
export function buildAppRuntimeDocument(files: AppRuntimeFiles): string {
	const client = files[APP_RUNTIME_CLIENT_MODULE] ?? "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;font-size:14px;line-height:1.45}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent;max-width:100%}
body{padding:12px;color:CanvasText;overflow-wrap:anywhere;overflow-x:hidden}
button{font:inherit}
</style>
</head>
<body>
<div id="app"></div>
<script>
(function(){
	var pending=new Map();var seq=0;
	window.addEventListener("message",function(event){
		var data=event.data;
		if(!data||typeof data!=="object"||data.jsonrpc!=="2.0"||data.id===undefined)return;
		var entry=pending.get(data.id);if(!entry)return;pending.delete(data.id);
		if(data.error)entry.reject(Object.assign(new Error(data.error.message||data.error.code),{code:data.error.code,detail:data.error.data}));
		else entry.resolve(data.result);
	});
	window.tedix={
		call:function(method,args){
			var id=++seq;
			return new Promise(function(resolve,reject){
				pending.set(id,{resolve:resolve,reject:reject});
				window.parent.postMessage({jsonrpc:"2.0",id:id,method:${JSON.stringify(APP_RUNTIME_CALL_METHOD)},params:{method:method,args:args===undefined?null:args}},"*");
			});
		},
		resize:function(height){window.parent.postMessage({jsonrpc:"2.0",method:"tedix/resize",params:{height:height}},"*");}
	};
	new ResizeObserver(function(){window.tedix.resize(document.documentElement.scrollHeight);}).observe(document.body);
})();
${APP_RUNTIME_TRANSLATION_SCRIPT}
</script>
<script type="module">
${escapeScript(client)}
</script>
</body>
</html>`;
}
