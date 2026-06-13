import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@opsy\/agent$/, replacement: agentSrcIndex },
			{ find: /^@opsy\/tui$/, replacement: tuiSrcIndex },
		],
	},
});
