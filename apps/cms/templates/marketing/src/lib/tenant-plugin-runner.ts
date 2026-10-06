import { env } from "cloudflare:workers";
import type {
	PluginManifest,
	SandboxOptions,
	SandboxRunner,
	SandboxedPluginInstance,
	SerializedRequest,
	SandboxInvocationOptions,
} from "emdash";

type HostResult =
	| { ok: true; value: unknown }
	| { ok: false; error: string; code?: string };

interface PluginHost {
	validateBundle(manifest: PluginManifest, code: string): Promise<HostResult>;
	invokeHook(
		pluginId: string,
		version: string,
		hook: string,
		event: unknown,
	): Promise<HostResult>;
	invokeRoute(
		pluginId: string,
		version: string,
		route: string,
		input: unknown,
		request: SerializedRequest,
	): Promise<HostResult>;
}

function pluginHost(): PluginHost | null {
	const binding = (env as unknown as { PLUGIN_HOST?: PluginHost }).PLUGIN_HOST;
	return binding &&
		typeof binding.validateBundle === "function" &&
		typeof binding.invokeHook === "function" &&
		typeof binding.invokeRoute === "function"
		? binding
		: null;
}

function unwrap(result: HostResult): unknown {
	if (result.ok) return result.value;
	const error = new Error(result.error);
	if (result.code) Object.assign(error, { code: result.code });
	throw error;
}

/** Emdash stays inside the tenant isolate; only the parent can load plugin code. */
class TenantPluginRunner implements SandboxRunner {
	private readonly instances = new Set<TenantPluginInstance>();

	constructor(_options: SandboxOptions) {}

	isAvailable(): boolean {
		return pluginHost() !== null;
	}

	isHealthy(): boolean {
		return this.isAvailable();
	}

	unavailableReason(): string {
		return "the parent PLUGIN_HOST binding is unavailable";
	}

	async validateBundle(manifest: PluginManifest, code: string): Promise<void> {
		const host = pluginHost();
		if (!host) throw new Error(this.unavailableReason());
		unwrap(await host.validateBundle(manifest, code));
	}

	async load(
		manifest: PluginManifest,
		code: string,
	): Promise<SandboxedPluginInstance> {
		await this.validateBundle(manifest, code);
		const instance = new TenantPluginInstance(
			manifest.id,
			manifest.version,
			() => this.instances.delete(instance),
		);
		this.instances.add(instance);
		return instance;
	}

	setEmailSend(): void {
		// Email authority is not granted to registry plugins on this host.
	}

	async terminateAll(): Promise<void> {
		await Promise.all(
			[...this.instances].map((instance) => instance.terminate()),
		);
	}
}

class TenantPluginInstance implements SandboxedPluginInstance {
	readonly id: string;
	private active = true;

	constructor(
		private readonly pluginId: string,
		private readonly version: string,
		private readonly onTerminate: () => void,
	) {
		this.id = `${pluginId}:${version}`;
	}

	private host(): PluginHost {
		if (!this.active) throw new Error("Sandboxed plugin handle is inactive");
		const host = pluginHost();
		if (!host) throw new Error("Parent plugin host is unavailable");
		return host;
	}

	async invokeHook(hookName: string, event: unknown): Promise<unknown> {
		return unwrap(
			await this.host().invokeHook(
				this.pluginId,
				this.version,
				hookName,
				event,
			),
		);
	}

	async invokeRoute(
		routeName: string,
		input: unknown,
		request: SerializedRequest,
		_options?: SandboxInvocationOptions,
	): Promise<unknown> {
		return unwrap(
			await this.host().invokeRoute(
				this.pluginId,
				this.version,
				routeName,
				input,
				request,
			),
		);
	}

	setActive(active: boolean): void {
		this.active = active;
	}

	async terminate(): Promise<void> {
		this.active = false;
		this.onTerminate();
	}
}

export function createSandboxRunner(options: SandboxOptions): SandboxRunner {
	return new TenantPluginRunner(options);
}
