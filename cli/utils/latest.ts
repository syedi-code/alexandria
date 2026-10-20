/**
 * Latest versions only, for the extract scripts.
 *
 * Notes, quotes and essays are versioned: an edit inserts a row whose
 * `replaces` names the row before it. Thoughts are not — a reworded thought,
 * or one mirrored from Discord to the web, is a second row with nothing linking
 * it to the first. Those are found by wording.
 */

export interface VersionLink {
	id: string;
	replaces: string | null;
}

/** Maps every id in a `replaces` chain to the newest id in that chain. */
export function latestIds(links: VersionLink[]): Map<string, string> {
	const successor = new Map<string, string>();
	for (const { id, replaces } of links) {
		if (replaces) successor.set(replaces, id);
	}

	const latest = new Map<string, string>();
	for (const start of successor.keys()) {
		let head = start;
		const seen = new Set<string>();
		while (successor.has(head) && !seen.has(head)) {
			seen.add(head);
			head = successor.get(head)!;
		}
		latest.set(start, head);
	}
	return latest;
}

export interface Revisable {
	id: string;
	content: string;
	created_at: string;
}

// Two thoughts are one thought revised when most of their word pairs agree.
// Short entries are left alone: "Went to work." recurs on many days and each
// is its own entry.
const SAME_THOUGHT = 0.65;
const MIN_WORD_PAIRS = 6;

function wordPairs(text: string): Set<string> {
	const words = text
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.split(/\s+/)
		.filter(Boolean);
	const pairs = new Set<string>();
	for (let i = 0; i < words.length - 1; i++) {
		pairs.add(`${words[i]} ${words[i + 1]}`);
	}
	return pairs;
}

function similarity(a: Set<string>, b: Set<string>): number {
	let shared = 0;
	for (const pair of a) if (b.has(pair)) shared++;
	return (2 * shared) / (a.size + b.size);
}

/**
 * Keeps the newest row of each group of revisions, in the input order.
 * `latestOf` maps each left-out id to the id kept in its place.
 */
export function latestRevisions<T extends Revisable>(
	rows: T[]
): { latest: T[]; latestOf: Map<string, string> } {
	const pairs = rows.map((r) => wordPairs(r.content));
	const parent = rows.map((_, i) => i);
	const root = (i: number): number =>
		parent[i] === i ? i : (parent[i] = root(parent[i]));

	for (let i = 0; i < rows.length; i++) {
		if (pairs[i].size < MIN_WORD_PAIRS) continue;
		for (let j = i + 1; j < rows.length; j++) {
			if (pairs[j].size < MIN_WORD_PAIRS) continue;
			if (similarity(pairs[i], pairs[j]) >= SAME_THOUGHT) {
				parent[root(i)] = root(j);
			}
		}
	}

	const newest = new Map<number, T>();
	rows.forEach((row, i) => {
		const group = root(i);
		const kept = newest.get(group);
		if (!kept || isNewer(row, kept)) newest.set(group, row);
	});

	const latestOf = new Map<string, string>();
	rows.forEach((row, i) => {
		const kept = newest.get(root(i))!;
		if (kept.id !== row.id) latestOf.set(row.id, kept.id);
	});

	return {
		latest: rows.filter((row) => !latestOf.has(row.id)),
		latestOf,
	};
}

function isNewer(a: Revisable, b: Revisable): boolean {
	if (a.created_at !== b.created_at) return a.created_at > b.created_at;
	return a.id > b.id;
}
