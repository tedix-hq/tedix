import type { CoreStoreEnv } from "@tedix/db/core-store/client";
import { isD1CoreStore } from "@tedix/db/core-store/scope";

/** True when the core store binding this Worker needs is present. */
export function coreStoreReady(env: CoreStoreEnv): boolean {
	return isD1CoreStore(env) ? Boolean(env.DB) : Boolean(env.CORE_HYPERDRIVE);
}
