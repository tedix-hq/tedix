import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import "./zod-jitless";

describe("zod-jitless", () => {
	it("disables the JIT object compiler that needs new Function", () => {
		// The app's CSP has no 'unsafe-eval'. Zod would still work without this
		// (it catches the blocked probe and interprets instead) but every route
		// parsing an object schema reports a `script-src ← eval` violation.
		expect(z.config().jitless).toBe(true);
	});

	it("still parses object schemas correctly on the interpreted path", () => {
		const schema = z.object({ id: z.string(), n: z.number() });
		expect(schema.parse({ id: "a", n: 1 })).toEqual({ id: "a", n: 1 });
		expect(() => schema.parse({ id: "a", n: "no" })).toThrow();
	});
});
