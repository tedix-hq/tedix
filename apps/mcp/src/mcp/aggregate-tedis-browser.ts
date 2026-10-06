// Cloudflare Browser Rendering tool specs for the tedis aggregate.
//
// The browser surface currently exposes no aggregate tools; the schemas that
// used to live here fed tools that were removed. Keep the exported (empty)
// array so `aggregate-tedis.ts` composition stays stable.
import type { TediToolSpec } from "./aggregate-tedis-shared";

export const BROWSER_TOOLS: TediToolSpec[] = [];
