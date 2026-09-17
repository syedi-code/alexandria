import 'dotenv/config';
import { exec } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { enrichYouTube } from '@alexandria/core';

const execAsync = promisify(exec);

const scriptDir = new URL('.', import.meta.url).pathname.replace(
	/^\/([A-Z]:)/,
	'$1'
);
const repoRoot = resolve(scriptDir, '..', '..');
const workerDir = resolve(repoRoot, 'apps', 'worker');

interface D1QueryResult<T> {
	success: boolean;
	results: T[];
}

async function executeQuery<T>(query: string): Promise<T[]> {
	const normalizedQuery = query.replace(/\s+/g, ' ').trim();
	const escapedQuery = normalizedQuery.replace(/"/g, '\\"');
	const command = `npx wrangler d1 execute antisocial-media --remote --json --command="${escapedQuery}"`;

	const { stdout } = await execAsync(command, {
		cwd: workerDir,
		maxBuffer: 50 * 1024 * 1024,
	});

	const parsed: D1QueryResult<T>[] = JSON.parse(stdout);
	return parsed[0]?.results || [];
}

async function main() {
	const dbUrl =
		process.env.NEON_CONNECTION_STRING_SCRIPTS_ROLE ||
		process.env.NEON_DATABASE_URL;
	if (!dbUrl) {
		console.error(
			'Error: NEON_CONNECTION_STRING_SCRIPTS_ROLE (or NEON_DATABASE_URL) is not set.'
		);
		process.exit(1);
	}

	console.log('Fetching rows with potential YouTube links from D1...');

	const mediaRows = await executeQuery<{ id: string; url: string }>(`
		SELECT id, url FROM media
		WHERE url LIKE '%youtube.com%' OR url LIKE '%youtu.be%'
	`);

	const linkRows = await executeQuery<{ id: string; url: string }>(`
		SELECT id, url FROM links
		WHERE url LIKE '%youtube.com%' OR url LIKE '%youtu.be%'
	`);

	const rows = [...mediaRows, ...linkRows];
	const total = rows.length;
	console.log(`Found ${total} rows to check (${mediaRows.length} media, ${linkRows.length} links).`);

	let processed = 0;
	let hits = 0;
	let misses = 0;
	let errors = 0;
	let skipped = 0;

	for (const row of rows) {
		processed++;
		process.stdout.write(
			`\r[enrichment] processed ${processed} / ${total} URLs`
		);

		const url = row.url;
		if (!url) {
			skipped++;
			continue;
		}

		const result = await enrichYouTube(dbUrl, url);

		if (result.status === 'hit') hits++;
		else if (result.status === 'miss') misses++;
		else if (result.status === 'error') errors++;
		else skipped++;
	}

	process.stdout.write('\n');
	console.log(
		`${misses} cache misses | ${hits} cache hits | ${errors} errors | ${skipped} skipped`
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
