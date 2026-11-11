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
import {
	OsOutputContentSchema,
	OsOutputExportFormatSchema,
	type OsOutputExportFormat,
} from "@tedix/api-contract/schemas/os-workspaces";
import { evaluateWorkbook } from "./workbook-formulas";
import { normalizeSheetContent, projectWorkbook } from "./output-models";
import {
	APP_RUNTIME_THEME_METHOD,
	APP_RUNTIME_THEME_PLACEHOLDER,
	APP_RUNTIME_THEME_STYLE_ID,
} from "./app-runtime-theme";

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
export const APP_RUNTIME_OUTPUTS_CHANGED_METHOD = "tedix/outputs-changed";

export interface AppRuntimeOutputRevision {
	slot: string;
	outputId: string;
	revisionId: string;
	revision: number;
}

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
	| "revision_conflict"
	| "host_unavailable";

export type AppRuntimeHostResult =
	| { ok: true; value: unknown }
	| { ok: false; error: AppRuntimeHostError; detail?: string };

export type AppRuntimeDraft = { revision: number; content: OsOutputContent };

export interface AppRuntimeHostDeps {
	context: AppRuntimeContext;
	resources: readonly OsWorkspaceResource[];
	readOutput: (outputId: string) => Promise<OsOutputContent>;
	/**
	 * Read a granted slot where the host cannot see the workspace's resource
	 * rows (a share-link guest): the server resolves the slot itself.
	 */
	readSlot?: (slot: string) => Promise<OsOutputContent>;
	/** The bound Output and its current revision, read without a server round trip. */
	readOutputRevision?: (
		outputId: string,
	) => Promise<{ output: unknown; revision: unknown }>;
	callServer?: (method: string, args: JsonValue[]) => Promise<JsonValue>;
	operations?: OsGadgetManifest["operations"];
	onWrite?: () => void;
	appRevisionId?: string;
	drafts?: Map<string, AppRuntimeDraft>;
	replaceOutput?: (input: {
		workspaceId: string;
		outputId: string;
		content: OsOutputContent;
		expectedRevision: number;
	}) => Promise<unknown>;
	exportOutput?: (input: {
		workspaceId: string;
		outputId: string;
		format: OsOutputExportFormat;
		expectedRevision: number;
		sheetId?: string;
	}) => Promise<{
		filename: string;
		revision: number;
		format: OsOutputExportFormat;
	}>;
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
		case "app.draft.read":
		case "app.draft.write":
		case "app.draft.clear": {
			if (
				!isRecord(args) ||
				typeof args.slot !== "string" ||
				typeof args.outputId !== "string"
			)
				return { ok: false, error: "bad_arguments" };
			const outputId = outputIdForSlot(
				deps.resources.filter(
					(resource) => resource.workspaceId === context.workspaceId,
				),
				args.slot,
			);
			if (!outputId || outputId !== args.outputId)
				return { ok: false, error: "slot_unbound" };
			const key = `${context.workspaceId}:${context.gadget.id}:${deps.appRevisionId ?? context.gadget.revision}:${outputId}`;
			if (
				!appRuntimePermission({
					role: context.role,
					operation: "outputs.write",
					grants: context.grants,
					slot: args.slot,
				}).allowed ||
				!appRuntimePermission({
					role: context.role,
					operation: "outputs.read",
					grants: context.grants,
					slot: args.slot,
				}).allowed
			) {
				deps.drafts?.delete(key);
				return { ok: false, error: "not_permitted" };
			}
			if (!deps.drafts) return { ok: false, error: "host_unavailable" };
			if (method === "app.draft.clear") {
				deps.drafts.delete(key);
				return { ok: true, value: null };
			}
			if (method === "app.draft.read") {
				try {
					const current = await deps.readOutput(outputId);
					const draft = deps.drafts.get(key);
					if (draft && draft.content.kind !== current.kind) {
						deps.drafts.delete(key);
						return { ok: true, value: null };
					}
					return { ok: true, value: draft ? structuredClone(draft) : null };
				} catch (error) {
					deps.drafts.delete(key);
					throw error;
				}
			}
			if (
				!Number.isInteger(args.revision) ||
				Number(args.revision) < 1 ||
				(JSON.stringify(args.content) ?? "").length > 1_000_000
			)
				return { ok: false, error: "bad_arguments" };
			const content = OsOutputContentSchema.safeParse(args.content);
			if (!content.success) return { ok: false, error: "bad_arguments" };
			deps.drafts.set(key, {
				revision: Number(args.revision),
				content: content.data,
			});
			return { ok: true, value: null };
		}
		case "sheet.evaluate": {
			if (context.role === "viewer")
				return { ok: false, error: "not_permitted" };
			const parsed = OsOutputContentSchema.safeParse(
				isRecord(args) ? args.content : null,
			);
			if (!parsed.success || parsed.data.kind !== "sheet")
				return { ok: false, error: "bad_arguments" };
			const content = normalizeSheetContent(parsed.data);
			return {
				ok: true,
				value: projectWorkbook(evaluateWorkbook(content.workbook!)),
			};
		}
		case "outputs.replace": {
			if (
				!isRecord(args) ||
				typeof args.slot !== "string" ||
				!Number.isInteger(args.expectedRevision) ||
				Number(args.expectedRevision) < 1 ||
				new TextEncoder().encode(JSON.stringify(args.content) ?? "").length >
					1_000_000
			)
				return { ok: false, error: "bad_arguments" };
			const content = OsOutputContentSchema.safeParse(args.content);
			if (!content.success) return { ok: false, error: "bad_arguments" };
			const permission = appRuntimePermission({
				role: context.role,
				operation: "outputs.write",
				grants: context.grants,
				slot: args.slot,
			});
			if (!permission.allowed)
				return { ok: false, error: "not_permitted", detail: permission.reason };
			const outputId = outputIdForSlot(
				deps.resources.filter((row) => row.workspaceId === context.workspaceId),
				args.slot,
			);
			if (!outputId) return { ok: false, error: "slot_unbound" };
			if (!deps.replaceOutput) return { ok: false, error: "host_unavailable" };
			let value: unknown;
			try {
				value = await deps.replaceOutput({
					workspaceId: context.workspaceId,
					outputId,
					content: content.data,
					expectedRevision: Number(args.expectedRevision),
				});
			} catch (error) {
				if (
					isRecord(error) &&
					error.code === "CONFLICT" &&
					isRecord(error.data) &&
					error.data.expectedRevision === args.expectedRevision &&
					Number.isSafeInteger(error.data.currentRevision) &&
					Number(error.data.currentRevision) > Number(args.expectedRevision)
				)
					return {
						ok: false,
						error: "revision_conflict",
						detail: `A newer revision (${error.data.currentRevision}) has been saved. Your changes have not replaced it`,
					};
				throw error;
			}
			deps.onWrite?.();
			return { ok: true, value };
		}
		case "app.exportOutput": {
			const format = OsOutputExportFormatSchema.safeParse(
				isRecord(args) ? args.format : null,
			);
			if (
				!isRecord(args) ||
				typeof args.slot !== "string" ||
				!format.success ||
				!Number.isInteger(args.expectedRevision) ||
				Number(args.expectedRevision) < 1 ||
				(args.sheetId !== undefined &&
					(typeof args.sheetId !== "string" ||
						!args.sheetId ||
						args.sheetId.length > 80))
			)
				return { ok: false, error: "bad_arguments" };
			const permission = appRuntimePermission({
				role: context.role,
				operation: "outputs.read",
				grants: context.grants,
				slot: args.slot,
			});
			if (!permission.allowed)
				return { ok: false, error: "not_permitted", detail: permission.reason };
			const outputId = outputIdForSlot(
				deps.resources.filter((row) => row.workspaceId === context.workspaceId),
				args.slot,
			);
			if (!outputId) return { ok: false, error: "slot_unbound" };
			if (!deps.exportOutput) return { ok: false, error: "host_unavailable" };
			return {
				ok: true,
				value: await deps.exportOutput({
					workspaceId: context.workspaceId,
					outputId,
					format: format.data,
					expectedRevision: Number(args.expectedRevision),
					...(typeof args.sheetId === "string"
						? { sheetId: args.sheetId }
						: {}),
				}),
			};
		}
		case "app.download": {
			if (context.role === "viewer")
				return { ok: false, error: "not_permitted" };
			if (
				!isRecord(args) ||
				typeof args.filename !== "string" ||
				!args.filename ||
				args.filename.length > 200 ||
				typeof args.text !== "string" ||
				args.text.length > 8_000_000 ||
				typeof args.mimeType !== "string"
			)
				return { ok: false, error: "bad_arguments" };
			const mimeType = args.mimeType.split(";")[0]?.trim().toLowerCase();
			if (
				!mimeType ||
				![
					"text/plain",
					"text/markdown",
					"text/csv",
					"application/json",
				].includes(mimeType)
			)
				return { ok: false, error: "bad_arguments", detail: "mimeType" };
			const filename = args.filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
			const url = URL.createObjectURL(
				new Blob([args.text], { type: `${mimeType};charset=utf-8` }),
			);
			const link = document.createElement("a");
			link.href = url;
			link.download = filename;
			document.body.append(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
			return { ok: true, value: { filename } };
		}
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
		case "outputs.readRevision": {
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
			if (!deps.readOutputRevision)
				return { ok: false, error: "host_unavailable" };
			const outputId = outputIdForSlot(
				deps.resources.filter((row) => row.workspaceId === context.workspaceId),
				args.slot,
			);
			if (!outputId) return { ok: false, error: "slot_unbound" };
			return { ok: true, value: await deps.readOutputRevision(outputId) };
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
			const value = await deps.callServer(name.data, parameters.data);
			const operation = deps.operations?.find(
				(entry) => entry.name === name.data,
			);
			if (operation && operation.effect !== "read") deps.onWrite?.();
			return { ok: true, value };
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
/** App to host, with an id: translate one text with the host's translator. */
export const APP_RUNTIME_TRANSLATE_TEXT_METHOD = "tedix/translate-text";
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
	/** The host holds a translator and answers `tedix/translate-text`. */
	host?: boolean;
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
	// The browser lets a page fetch or open a translator only from the person's
	// click, and that click lands in the host, never in this frame. A host that
	// opened one says so (params.host) and translates each text for the app.
	var hostSeq=0,hostPending=new Map();
	function hostTranslator(source,target){
		return {translate:function(text){
			return new Promise(function(resolve,reject){
				var id="tedix-translate-"+(++hostSeq);
				hostPending.set(id,{resolve:resolve,reject:reject});
				window.parent.postMessage({jsonrpc:"2.0",id:id,method:${JSON.stringify(APP_RUNTIME_TRANSLATE_TEXT_METHOD)},params:{text:text,source:source,target:target}},"*");
			});
		}};
	}
	function translator(source,target,viaHost){
		var pair=(viaHost?"host:":"")+source+">"+target,job=t.pairs.get(pair);
		if(!job){
			job=viaHost?Promise.resolve(hostTranslator(source,target)):Translator.create({sourceLanguage:source,targetLanguage:target,monitor:function(monitor){
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
		if(!params.host&&typeof Translator==="undefined"){status({state:"unavailable",detail:"no_translator"});return;}
		status({state:"translating",language:params.target});
		translator(String(params.source),String(params.target),params.host===true).then(function(created){
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
		var waiting=typeof data.id==="string"&&hostPending.get(data.id);
		if(waiting){
			hostPending.delete(data.id);
			if(typeof data.result==="string")waiting.resolve(data.result);else waiting.reject(new Error("host_translation"));
			return;
		}
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
:root{color-scheme:light dark;font-family:var(--tedix-font,system-ui,sans-serif);font-size:14px;line-height:1.45;accent-color:var(--tedix-primary,auto)}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent;max-width:100%}
body{padding:12px;color:var(--tedix-fg,CanvasText);overflow-wrap:anywhere;overflow-x:hidden}
button{font:inherit}
</style>
${APP_RUNTIME_THEME_PLACEHOLDER}
</head>
<body>
<div id="app"></div>
<script>
(function(){
	var pending=new Map();var seq=0;
	window.addEventListener("message",function(event){
		var data=event.data;
		if(!data||typeof data!=="object"||data.jsonrpc!=="2.0")return;
		if(event.source===window.parent&&data.method===${JSON.stringify(APP_RUNTIME_THEME_METHOD)}&&data.params&&typeof data.params.css==="string"){
			var theme=document.getElementById(${JSON.stringify(APP_RUNTIME_THEME_STYLE_ID)});
			if(theme)theme.textContent=data.params.css;
			return;
		}
		if(data.id===undefined)return;
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
