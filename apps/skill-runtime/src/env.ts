import type { InferEnv, UnwrapConfig } from "cf/config";
import type config from "../cloudflare.config";

/**
 * Bindings inferred from cloudflare.config.ts. The generated `Cloudflare.Env`
 * augmentation is dropped whenever `@cloudflare/workers-types` is also in the
 * program (packages/db references it), so the Worker names this type directly.
 */
export type SkillRuntimeEnv = InferEnv<
	UnwrapConfig<UnwrapConfig<typeof config>["worker"]>
>;
