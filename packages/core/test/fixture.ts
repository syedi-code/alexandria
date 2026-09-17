/**
 * A deterministic catalogue fixture.
 *
 * Shaped to hit the cases that the works/writing split is most likely to
 * break: a work with no quotes and no notes, a work with no author row, a
 * work with no PDF, superseded (`replaces`) rows on both sides, essay
 * co-citation, and an essay that is itself superseded.
 */
import {
	applyMigrations,
	migratedTestDatabase,
	type TestDatabase,
} from './d1.js';

const id = (n: number) =>
	`11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;

export const ids = {
	userAdmin: id(1),
	userOther: id(2),
	authorNietzsche: id(10),
	authorWeil: id(11),
	bookBeyondGoodAndEvil: id(20),
	bookGravityAndGrace: id(21),
	bookAnonymousPamphlet: id(22),
	bookGayScience: id(23),
	bookRecent: id(24),
	quoteBgeCurrent: id(30),
	quoteBgeSuperseded: id(31),
	quoteGravity: id(32),
	noteBge: id(40),
	notePamphlet: id(41),
	noteSuperseded: id(42),
	essayCoCitation: id(50),
	essaySingle: id(51),
	essaySuperseded: id(52),
	mediaBgeFirst: id(60),
	mediaBgeSecond: id(61),
};

const T = (n: number) => `2026-0${n}-01T00:00:00.000Z`;

/** Seeds the pre-0026 tables: books, authors, book_media. */
export function seedLegacyCatalogue(db: TestDatabase): void {
	const run = (sql: string, ...params: unknown[]) =>
		db.raw.prepare(sql).run(...(params as never[]));

	for (const [uid, email] of [
		[ids.userAdmin, 'admin@example.test'],
		[ids.userOther, 'other@example.test'],
	]) {
		run(
			`INSERT INTO users (id, email, first_seen, last_seen) VALUES (?, ?, ?, ?)`,
			uid,
			email,
			T(1),
			T(1)
		);
	}

	const author = (
		aid: string,
		name: string,
		bio: string | null,
		born: string | null,
		died: string | null
	) =>
		run(
			`INSERT INTO authors (id, name, bio, born, died, created_at, updated_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			aid,
			name,
			bio,
			born,
			died,
			T(1),
			T(1),
			ids.userAdmin
		);

	author(
		ids.authorNietzsche,
		'Friedrich Nietzsche',
		'German philologist.',
		'1844',
		'1900'
	);
	author(ids.authorWeil, 'Simone Weil', null, '1909', '1943');

	const book = (
		bid: string,
		title: string,
		authorName: string,
		authorId: string | null,
		pdfUrl: string | null,
		coverUrl: string | null,
		published: string | null,
		offset: number,
		created: string
	) =>
		run(
			`INSERT INTO books (id, title, author, pdf_url, cover_url, isbn, description,
			                    originally_published, pdf_page_offset, author_id,
			                    created_at, updated_at, user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			bid,
			title,
			authorName,
			pdfUrl,
			coverUrl,
			null,
			null,
			published,
			offset,
			authorId,
			created,
			created,
			ids.userAdmin
		);

	book(
		ids.bookBeyondGoodAndEvil,
		'Beyond Good and Evil',
		'Friedrich Nietzsche',
		ids.authorNietzsche,
		'books/bge/bge.pdf',
		'books/bge/cover.jpg',
		'1886',
		12,
		T(1)
	);
	book(
		ids.bookGravityAndGrace,
		'Gravity and Grace',
		'Simone Weil',
		ids.authorWeil,
		null,
		null,
		'1947',
		0,
		T(2)
	);
	book(
		ids.bookAnonymousPamphlet,
		'An Anonymous Pamphlet',
		'Anonymous',
		null,
		null,
		null,
		null,
		0,
		T(3)
	);
	book(
		ids.bookGayScience,
		'The Gay Science',
		'Friedrich Nietzsche',
		ids.authorNietzsche,
		'books/gs/gs.pdf',
		null,
		'1882',
		0,
		T(4)
	);
	book(
		ids.bookRecent,
		'A Recent Thing',
		'Someone Living',
		null,
		null,
		null,
		'2021',
		0,
		T(5)
	);

	const quote = (
		qid: string,
		text: string,
		bookId: string | null,
		page: string | null,
		replaces: string | null,
		created: string
	) =>
		run(
			`INSERT INTO quotes (id, quote, work, creator, kind, book_id, page, posted, tags,
			                     replaces, source, created_at, updated_at, user_id)
			 VALUES (?, ?, NULL, NULL, NULL, ?, ?, 0, NULL, ?, 'web', ?, ?, ?)`,
			qid,
			text,
			bookId,
			page,
			replaces,
			created,
			created,
			ids.userAdmin
		);

	quote(
		ids.quoteBgeSuperseded,
		'He who fights monsters (draft).',
		ids.bookBeyondGoodAndEvil,
		'89',
		null,
		T(1)
	);
	quote(
		ids.quoteBgeCurrent,
		'He who fights with monsters.',
		ids.bookBeyondGoodAndEvil,
		'89',
		ids.quoteBgeSuperseded,
		T(2)
	);
	quote(
		ids.quoteGravity,
		'Attention is the rarest form of generosity.',
		ids.bookGravityAndGrace,
		'117',
		null,
		T(3)
	);

	const note = (
		nid: string,
		content: string,
		bookId: string | null,
		page: string | null,
		replaces: string | null,
		created: string
	) =>
		run(
			`INSERT INTO notes (id, content, book_id, page, posted, tags, replaces, source,
			                    created_at, updated_at, user_id, creator, work, kind, last_surfaced_at)
			 VALUES (?, ?, ?, ?, 0, NULL, ?, 'web', ?, ?, ?, NULL, NULL, NULL, NULL)`,
			nid,
			content,
			bookId,
			page,
			replaces,
			created,
			created,
			ids.userAdmin
		);

	note(
		ids.noteSuperseded,
		'Earlier reading of the aphorism.',
		ids.bookBeyondGoodAndEvil,
		'89',
		null,
		T(1)
	);
	note(
		ids.noteBge,
		'The abyss gazes back — on self-deception.',
		ids.bookBeyondGoodAndEvil,
		'89',
		ids.noteSuperseded,
		T(2)
	);
	note(
		ids.notePamphlet,
		'Unattributed, but the prose is unmistakable.',
		ids.bookAnonymousPamphlet,
		null,
		null,
		T(3)
	);

	const essay = (
		eid: string,
		content: string,
		replaces: string | null,
		created: string
	) =>
		run(
			`INSERT INTO essays (id, content, posted, tags, replaces, source, created_at, updated_at, user_id)
			 VALUES (?, ?, 0, NULL, ?, 'web', ?, ?, ?)`,
			eid,
			content,
			replaces,
			created,
			created,
			ids.userAdmin
		);

	const reference = (
		eid: string,
		entityType: string,
		entityId: string,
		page: string | null,
		position: number
	) =>
		run(
			`INSERT INTO essay_references (id, essay_id, entity_type, entity_id, page, position, params)
			 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
			`${eid}:${position}`,
			eid,
			entityType,
			entityId,
			page,
			position
		);

	essay(ids.essaySuperseded, 'A draft that was replaced.', null, T(1));
	essay(
		ids.essayCoCitation,
		`On attention and the abyss. [[book:${ids.bookBeyondGoodAndEvil}]] and [[book:${ids.bookGravityAndGrace}]] disagree.`,
		ids.essaySuperseded,
		T(2)
	);
	essay(
		ids.essaySingle,
		`A second look at [[book:${ids.bookBeyondGoodAndEvil}]], alongside [[book:${ids.bookGayScience}]].`,
		null,
		T(3)
	);

	reference(ids.essaySuperseded, 'book', ids.bookBeyondGoodAndEvil, null, 0);
	reference(ids.essayCoCitation, 'book', ids.bookBeyondGoodAndEvil, '89', 0);
	reference(ids.essayCoCitation, 'book', ids.bookGravityAndGrace, '117', 1);
	reference(ids.essaySingle, 'book', ids.bookBeyondGoodAndEvil, null, 0);
	reference(ids.essaySingle, 'book', ids.bookGayScience, null, 1);

	const media = (
		mid: string,
		bookId: string,
		filePath: string,
		caption: string | null,
		sortOrder: number
	) =>
		run(
			`INSERT INTO book_media (id, book_id, user_id, path, kind, caption, sort_order, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'image', ?, ?, ?, ?)`,
			mid,
			bookId,
			ids.userAdmin,
			filePath,
			caption,
			sortOrder,
			T(1),
			T(1)
		);

	media(
		ids.mediaBgeSecond,
		ids.bookBeyondGoodAndEvil,
		'books/bge/media/b.jpg',
		'Second plate',
		1
	);
	media(
		ids.mediaBgeFirst,
		ids.bookBeyondGoodAndEvil,
		'books/bge/media/a.jpg',
		null,
		0
	);
}

/**
 * A fully migrated database holding the fixture.
 *
 * The fixture is written against the legacy tables and then migrated, so every
 * test that reads it also exercises 0026_works. If the migration stops being
 * faithful, the characterisation snapshots break — which is the point.
 */
export function catalogueTestDatabase(): TestDatabase {
	const db = migratedTestDatabase({ to: '0025' });
	seedLegacyCatalogue(db);
	applyMigrations(db, { from: '0026' });
	return db;
}
