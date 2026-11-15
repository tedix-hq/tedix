export const APP_RUNTIME_CALL_METHOD = "tedix/call";
export const APP_RUNTIME_OUTPUTS_CHANGED_METHOD = "tedix/outputs-changed";
export const APP_RUNTIME_TRANSLATE_TEXT_METHOD = "tedix/translate-text";
export const APP_RUNTIME_TRANSLATION_METHOD = "tedix/translation";
export const APP_RUNTIME_LANGUAGE_METHOD = "tedix/language";

export interface AppRuntimeOutputRevision {
	slot: string;
	outputId: string;
	revisionId: string;
	revision: number;
}

export type AppRuntimeHostError =
	| "not_permitted"
	| "unknown_method"
	| "bad_arguments"
	| "slot_unbound"
	| "revision_conflict"
	| "too_large"
	| "host_unavailable";

export type AppRuntimeHostResult =
	| { ok: true; value: unknown }
	| { ok: false; error: AppRuntimeHostError; detail?: string };
