import type { ModelCatalogModel } from "@tedix/api-contract/schemas/model-catalog-projection";

type PickerModel = Pick<ModelCatalogModel, "allowed" | "ref" | "selectable">;

/** Models whose catalog lifecycle still permits a new selection. */
export function modelsForNewSelection<T extends PickerModel>(
	models: readonly T[],
): T[] {
	return models.filter((model) => model.selectable);
}

/**
 * Resolve the initial composer/create choice without turning catalog lifecycle
 * into an authorization rule. An existing routed ref may be superseded and is
 * therefore preserved when it remains allowed; fallback defaults must be both
 * allowed and selectable.
 */
export function initialModelRef(
	models: readonly PickerModel[],
	routedRef: string | null | undefined,
): string | null {
	const routed = models.find(
		(model) => model.ref === routedRef && model.allowed,
	);
	if (routed) return routed.ref;
	return models.find((model) => model.allowed && model.selectable)?.ref ?? null;
}

/**
 * Settings hide superseded refs from new choices but retain the current stored
 * ref as a disabled option so the operator can see what will keep resolving.
 */
export function modelsForSettings<T extends PickerModel>(
	models: readonly T[],
	currentRef: string,
): T[] {
	return models.filter((model) => model.selectable || model.ref === currentRef);
}
