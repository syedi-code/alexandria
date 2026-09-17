import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: [
			'packages/**/*.test.ts',
			'apps/**/*.test.ts',
			'cli/**/*.test.ts',
		],
		environment: 'node',
	},
});
