import { NativeContainerSandbox } from "@tedix/container-runtime/sandbox";
import { logDocsFailure } from "../log";

interface DocsBuildEnv {
	ENVIRONMENT?: string;
}

export class DocsBuildSandbox extends NativeContainerSandbox<DocsBuildEnv> {
	protected get containerTelemetrySurface(): string {
		return "docs";
	}
	protected override get inactivityTimeoutMs(): number {
		return 10 * 60 * 1000;
	}

	protected startOptions(): ContainerStartupOptions {
		return {
			image: this.container.images.sandbox,
			instance: "standard-1",
			enableInternet: true,
			labels: {
				siteId: this.ctx.id.name ?? this.ctx.id.toString(),
				platform: "tedix-docs",
				env: this.env.ENVIRONMENT ?? "production",
			},
		};
	}

	override async destroy(): Promise<void> {
		try {
			await super.destroy();
		} catch (error) {
			logDocsFailure("docs.build_container_failed", error);
			throw error;
		}
	}
}
