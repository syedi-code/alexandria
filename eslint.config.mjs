import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

/**
 * The boundary rule (plan D4).
 *
 * works/ is true regardless of who is reading; writing/ is one person's
 * opinion about it, and conversations/ is one person's exchanges with Scribe
 * about it. Both may import Works; Works imports neither, the two never import
 * each other, and platform/ imports none of them. Nothing fails at runtime
 * when this is violated — this rule is the only thing holding the seam, and the
 * only thing keeping a future repo split possible. Do not disable it.
 */
const BOUNDARY = 'The dependency runs one way: writing points at works, works never points back. Import @alexandria/core/works or @alexandria/core/platform — the package root re-exports both domains.';

/**
 * `paths` matches a module specifier exactly; `patterns` uses gitignore
 * semantics, where naming a directory also bans everything beneath it. The
 * package root therefore has to be a path, or it would ban its own subpaths.
 */
const domain = (name) => [`**/${name}`, `**/${name}/**`];

const forbid = (patterns, message) => ({
	'no-restricted-imports': [
		'error',
		{
			paths: [{ name: '@alexandria/core', message }],
			patterns: [{ group: patterns, message }],
		},
	],
});

export default tseslint.config(
	{
		ignores: [
			'**/node_modules/**',
			'**/dist/**',
			'**/.wrangler/**',
			'**/*.d.ts',
			'local/**',
			'mockups/**',
			'sql/**',
			'coverage/**',
		],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	eslintConfigPrettier,
	{
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					vars: 'all', // include imports
					varsIgnorePattern: '^_', // allow `_ignored` vars/imports
				},
			],
		},
	},
	{
		// The MCP server exposes Works and nothing else.
		files: [
			'packages/core/works/**/*.ts',
			'apps/worker/api/works/**/*.ts',
			'apps/worker/api/mcp/**/*.ts',
		],
		rules: forbid(
			[...domain('writing'), ...domain('conversations')],
			`works/ may not import writing/ or conversations/. ${BOUNDARY}`
		),
	},
	{
		files: ['packages/core/writing/**/*.ts'],
		rules: forbid(
			domain('conversations'),
			'writing/ and conversations/ both stand on works/; neither imports the other.'
		),
	},
	{
		files: [
			'packages/core/conversations/**/*.ts',
			'apps/worker/api/conversations/**/*.ts',
		],
		rules: forbid(
			domain('writing'),
			'writing/ and conversations/ both stand on works/; neither imports the other.'
		),
	},
	{
		files: ['packages/core/platform/**/*.ts'],
		rules: forbid(
			[
				...domain('works'),
				...domain('writing'),
				...domain('conversations'),
			],
			'platform/ is the substrate every domain stands on, so it may import none of them.'
		),
	}
);
