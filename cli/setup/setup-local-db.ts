/**
 * Setup Local D1 Database
 *
 * Replays every migration in sql/migrations/ into the local D1 emulator, in
 * order — the same sequence packages/core/test/d1.ts replays to build the
 * schema the tests run against.
 *
 * Usage:
 *   npm run dev:setup              # apply migrations
 *   npm run dev:setup -- --reset   # throw the local database away first
 */

import { execSync } from 'child_process';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');
const migrationsDir = join(rootDir, 'sql', 'migrations');
const workerDir = join(rootDir, 'apps', 'worker');
const stateDir = join(workerDir, '.wrangler', 'state', 'v3', 'd1');

const reset = process.argv.includes('--reset');

/**
 * 0013 backfills every row's user_id to a placeholder, and earlier migrations
 * seed rows, so it needs that user to exist already or it fails the foreign
 * key. Production had one by the time it ran; a fresh local database does not.
 *
 * Turning foreign keys off for the replay — what packages/core/test/d1.ts does
 * — is not available here: D1 runs a `--file` inside a transaction, and
 * `PRAGMA foreign_keys` is a no-op inside one.
 */
const BACKFILL_USER = 'admin-id';
const SEED_USER =
	`INSERT OR IGNORE INTO users (id, email) ` +
	`VALUES ('${BACKFILL_USER}', 'dev@localhost');\n`;

/**
 * Whether anything has been applied to the local database yet.
 *
 * These migrations cannot be replayed over themselves. Several rebuild a table
 * — create `notes_new`, copy, drop, rename — so a second pass runs against a
 * shape the file was not written for and fails with something like "table
 * notes_new has 11 columns but 15 values were supplied". Skipping the ones
 * that error is worse than useless: it half-applies the sequence and the
 * failure surfaces several migrations later, nowhere near its cause.
 *
 * So: apply to an empty database, or rebuild from scratch. There is no third
 * option, and nothing here is worth preserving.
 */
function alreadySetUp(): boolean {
	try {
		const out = execSync(
			`npx wrangler d1 execute DB --local --json --command "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'"`,
			{ cwd: workerDir, stdio: 'pipe' }
		).toString();
		return /"n":\s*[1-9]/.test(out);
	} catch {
		return false;
	}
}

console.log('🗄️  Setting up local D1 database...\n');

if (reset) {
	if (!existsSync(stateDir)) {
		console.log('No local database to remove.\n');
	} else {
		rmSync(stateDir, { recursive: true, force: true });

		// Windows will not delete a file another process holds open, and
		// rmSync with force swallows the refusal. Left unchecked, the replay
		// then runs over the database it was told to throw away and fails
		// somewhere much later with a constraint error that explains nothing.
		if (existsSync(stateDir)) {
			console.error(
				'Could not remove the local database — something is holding it open.\n' +
					'Stop `npm run dev` and run this again.\n'
			);
			process.exit(1);
		}
		console.log('Removed the local database.\n');
	}
}

if (alreadySetUp()) {
	console.log('The local database is already set up.\n');
	console.log('To rebuild it from the migrations:\n');
	console.log('  npm run dev:setup -- --reset\n');
	process.exit(0);
}

const migrations = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort();

if (migrations.length === 0) {
	console.log('No migrations found in sql/migrations/');
	process.exit(0);
}

console.log(`Found ${migrations.length} migration(s):\n`);

const scratch = mkdtempSync(join(tmpdir(), 'alexandria-migrations-'));
const cleanUp = () => rmSync(scratch, { recursive: true, force: true });

let applied = 0;

for (const migration of migrations) {
	process.stdout.write(`  ${migration} … `);

	const sql = readFileSync(join(migrationsDir, migration), 'utf8');
	const staged = join(scratch, migration);
	writeFileSync(staged, sql.includes(BACKFILL_USER) ? SEED_USER + sql : sql);

	try {
		execSync(`npx wrangler d1 execute DB --local --file="${staged}"`, {
			cwd: workerDir,
			stdio: 'pipe',
		});
		console.log('applied');
		applied++;
	} catch (err: unknown) {
		const error = err as {
			stderr?: Buffer;
			stdout?: Buffer;
			message?: string;
		};
		const output = [
			error.stderr?.toString() ?? '',
			error.stdout?.toString() ?? '',
			error.message ?? '',
		].join('\n');

		console.log('failed');
		cleanUp();
		console.error(`\n${output.trim()}\n`);
		console.error(
			`${migration} did not apply to an empty database. That is a bug in\n` +
				'the migration, not in your checkout — the same replay builds the\n' +
				'schema the tests run against, so `npm test` should fail too.\n'
		);
		process.exit(1);
	}
}

cleanUp();

console.log(`\n✅ Local database ready — ${applied} migrations applied.\n`);
console.log('Run `npm run dev` to start the development server.');
