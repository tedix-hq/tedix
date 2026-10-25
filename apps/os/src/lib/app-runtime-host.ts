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

/** The grants and settings an app context carries, read from its manifest. */
export function appRuntimeContextFromManifest(
	manifest: OsGadgetManifest,
	base: Omit<AppRuntimeContext, "settings" | "grants">,
): AppRuntimeContext {
	const config = isRecord(manifest.config) ? manifest.config : {};
	const settings = isRecord(config.settings)
		? (config.settings as Record<string, JsonValue>)
		: {};
	return {
		...base,
		settings,
		grants: (manifest.resourceGrants ?? []).map((grant) => ({
			slot: grant.slot,
			operations: grant.operations,
		})),
	};
}

const escapeScript = (source: string) =>
	source.replace(/<\/script/gi, "<\\/script");

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
</script>
<script type="module">
${escapeScript(client)}
</script>
</body>
</html>`;
}
