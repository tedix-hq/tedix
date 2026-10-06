import type { InferEnv, UnwrapConfig } from "cf/config";
import type config from "../cloudflare.config";

/**
 * Bindings inferred from cloudflare.config.ts. The generated `Cloudflare.Env`
 * augmentation is dropped whenever `@cloudflare/workers-types` is also in the
 * program (packages/db references it), so the Worker declares its global env
 * names from this type.
 */
type LaneEnv = InferEnv<UnwrapConfig<UnwrapConfig<typeof config>["worker"]>>;
// Config inference merges lane bindings and marks lane-specific names optional.
// This Worker runs against the deployed lane, which declares those bindings.
// Text values differ per lane, so they are typed as `string`.
type DeployedEnv = Required<LaneEnv>;
type McpEnv = {
	-readonly [
		Name in keyof DeployedEnv as Name extends "AGGREGATE_EPOCH_KV"
			? never
			: Name
	]: DeployedEnv[Name] extends string ? string : DeployedEnv[Name];
} & {
	// KV Instant is private beta. The binding is absent until an account-enabled
	// namespace id is supplied while evaluating cloudflare.config.ts.
	AGGREGATE_EPOCH_KV?: KVNamespace;
};

declare global {
	interface CloudflareEnv extends McpEnv {}
}
