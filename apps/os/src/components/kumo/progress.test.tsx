import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Progress, ProgressIndicator, ProgressTrack } from "./progress";

describe("Kumo Progress adapter", () => {
	it("renders a default track and never duplicates a caller-supplied one", () => {
		const defaults = renderToStaticMarkup(<Progress value={40} />);
		expect(defaults.match(/data-slot="progress-track"/g)).toHaveLength(1);
		expect(defaults.match(/data-slot="progress-indicator"/g)).toHaveLength(1);

		const custom = renderToStaticMarkup(
			<Progress value={40}>
				<ProgressTrack data-testid="custom-track">
					<ProgressIndicator />
				</ProgressTrack>
			</Progress>,
		);
		expect(custom.match(/data-slot="progress-track"/g)).toHaveLength(1);
		expect(custom).toContain('data-testid="custom-track"');
	});
});
