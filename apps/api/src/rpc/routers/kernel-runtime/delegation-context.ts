import type { BaseContext } from "../../orpc";
import { buildInternalServiceBindingContext } from "../kernel/runtime-shared";

export function internalDelegationContext(
	context: BaseContext,
	organizationId: string,
): BaseContext {
	return buildInternalServiceBindingContext(context, organizationId);
}
