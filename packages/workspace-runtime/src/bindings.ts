import {
	assertWorkspaceBindingName,
	formatWorkspaceBindingDescription,
	type WorkspaceBinding,
	type WorkspaceBindingSummary,
	type WorkspaceBindings,
} from "./index";

/**
 * The registry of `env.NAME` capabilities a workspace exposes to sandboxed
 * code. Registration validates the name once; `env()` builds the plain object
 * the loader accepts (never a null-prototype object: the loader's serializer
 * rejects it).
 */
export class WorkspaceBindingRegistry implements WorkspaceBindings {
	private readonly bindings = new Map<string, WorkspaceBinding>();

	register(binding: WorkspaceBinding): void {
		assertWorkspaceBindingName(binding.name);
		if (!binding.declaration.trim()) {
			throw new Error(`Binding ${binding.name} needs a declaration`);
		}
		this.bindings.set(binding.name, binding);
	}

	unregister(name: string): boolean {
		return this.bindings.delete(name);
	}

	has(name: string): boolean {
		return this.bindings.has(name);
	}

	list(): WorkspaceBindingSummary[] {
		return [...this.bindings.values()]
			.map(({ name, description }) => ({ name, description }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	describe(name: string): string {
		const binding = this.bindings.get(name);
		if (!binding) {
			const known = this.list()
				.map((b) => b.name)
				.join(", ");
			throw new Error(
				`No binding named ${JSON.stringify(name)}. Registered: ${known || "none"}`,
			);
		}
		return formatWorkspaceBindingDescription(binding);
	}

	catalog(): string {
		const entries = this.list();
		if (entries.length === 0) return "No bindings are registered.";
		return (
			"Bindings available as `env.NAME` inside the sandbox:\n" +
			entries.map((b) => `- env.${b.name}: ${b.description}`).join("\n") +
			"\nCall describe(name) for a binding's full TypeScript declaration."
		);
	}

	/** The loader env for `names`, or for every binding when omitted. */
	env(names?: readonly string[]): Record<string, unknown> {
		const env: Record<string, unknown> = {};
		const selected = names ?? [...this.bindings.keys()];
		for (const name of selected) {
			const binding = this.bindings.get(name);
			if (!binding) {
				throw new Error(`No binding named ${JSON.stringify(name)}`);
			}
			env[name] = binding.stub;
		}
		return env;
	}
}
