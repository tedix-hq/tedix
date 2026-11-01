// @emdash-cms/cloudflare/db/do-sql imports EmDashConfigurationError from the
// root `emdash` package, which bundles it into the same chunk as emdash's
// Astro content/plugin-loader code — the only place that ever touches
// virtual:emdash/config, virtual:emdash/seed, virtual:emdash/dialect, and
// astro:content. @emdash-cms/cloudflare/sandbox also lazily imports
// emdash/middleware (the Astro request middleware) for plugin email without a
// provider. This Worker never calls that Astro-only code (it only uses do-sql's
// Durable Object SQL binding and the sandbox bridge), but the bundler resolves
// those specifiers eagerly and fails without a target. vite.config.ts aliases
// all of them to this stub; a real invocation throws instead of silently
// misbehaving.
function unreachable(name: string): never {
	throw new Error(
		`emdash "${name}" is only available inside an Astro build — unreachable in @tedix/cms-runtime, which never invokes emdash's Astro content/plugin-loader code paths.`,
	);
}

export default new Proxy(
	{},
	{ get: (_target, prop) => unreachable(`default.${String(prop)}`) },
);

export function createDialect(): never {
	return unreachable("createDialect");
}

export function withEmDashRuntime(): never {
	return unreachable("withEmDashRuntime");
}

export function runScheduledTasks(): never {
	return unreachable("runScheduledTasks");
}

export function getLiveCollection(): never {
	return unreachable("getLiveCollection");
}
