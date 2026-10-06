import type { SessionRotationOwner } from "./index";
import type { SessionIntentOwner } from "./intent-owner";

/**
 * Bindings from cloudflare.config.ts. The config binds the Durable Objects by
 * Worker name, which the generated types cannot resolve to a class, so the
 * namespaces are typed here.
 */
export type BrokerEnv = Omit<
	Cloudflare.Env,
	"SESSION_ROTATION" | "SESSION_INTENTS"
> & {
	SESSION_ROTATION: DurableObjectNamespace<SessionRotationOwner>;
	SESSION_INTENTS: DurableObjectNamespace<SessionIntentOwner>;
};
