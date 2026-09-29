import { MIN_QUOTE_WORDS, normalizeForMatching } from '../works/citations.js';
import { describePage, type PageRef } from '../works/pages.js';

/**
 * The pages a model has been shown in a conversation, by the handle it was
 * shown them under — enough to say which page a quotation came from.
 *
 * Claude Sonnet 5 quotes a page faithfully and then leaves the quotation in
 * plain quotation marks, without the `<cite>` around it: on 29 September an
 * answer quoted a handbook word for word, thirty times, and not one quotation
 * could be checked. Asking again did not help. The quotation already says
 * everything a citation needs except the handle, and the handle is the page
 * the words are on — so the server finds it.
 */
export class PageShelf {
	private readonly pages = new Map<
		string,
		{ heading: string; text: string; normalized: Map<Hyphens, string> }
	>();

	get size(): number {
		return this.pages.size;
	}

	/**
	 * Every page in a tool result, or in anything else shaped like one: a
	 * labelled page (`handle`, `text`) or search hit (`handle`, `snippet`).
	 * A whole page is kept over a snippet of it.
	 */
	addFrom(value: unknown): void {
		if (Array.isArray(value))
			return value.forEach((item) => this.addFrom(item));
		if (!value || typeof value !== 'object') return;
		const item = value as {
			handle?: unknown;
			text?: unknown;
			snippet?: unknown;
			ref?: PageRef;
			work_title?: string;
			creator?: string;
			printed_page?: string | null;
		};
		if (typeof item.handle !== 'string') return;
		const text =
			typeof item.text === 'string'
				? item.text
				: typeof item.snippet === 'string'
					? item.snippet.replace(/[«»]/g, '')
					: null;
		if (!text) return;

		const kept = this.pages.get(item.handle);
		if (kept && kept.text.length >= text.length) return;
		this.pages.delete(item.handle);
		this.pages.set(item.handle, {
			heading:
				item.ref && item.work_title
					? `[${item.handle}] ${describePage({
							ref: item.ref,
							work_id: '',
							work_title: item.work_title,
							creator: item.creator ?? '',
							printed_page: item.printed_page ?? null,
						})}`
					: `[${item.handle}]`,
			text,
			normalized: new Map(),
		});
	}

	/**
	 * The handle of a page the quotation is on, the latest read first; none
	 * for a quotation too short to be evidence, or on no page shown.
	 *
	 * Matched as the verifier matches (`normalizeForMatching`, both ways of
	 * reading a hyphen, a scholarly ellipsis), so a quotation marked here is
	 * one the verifier will find.
	 */
	find(quote: string): string | undefined {
		if (wordsIn(normalizeForMatching(quote)) < MIN_QUOTE_WORDS) return;
		const latestFirst = [...this.pages].reverse();
		for (const hyphens of ['join', 'split'] as const) {
			const parts = quote
				.split(ELLIPSIS)
				.map((part) => normalizeForMatching(part, hyphens))
				.filter(Boolean);
			if (
				parts.length > 1 &&
				parts.some((part) => wordsIn(part) < MIN_ELIDED_PART_WORDS)
			)
				continue;
			for (const [handle, page] of latestFirst) {
				if (inOrder(this.normalized(page, hyphens), parts))
					return handle;
			}
		}
	}

	/** The pages as a model reads them, latest last, within a budget of characters. */
	render(budget = RENDER_BUDGET): string {
		const kept: string[] = [];
		let spent = 0;
		for (const [, page] of [...this.pages].reverse()) {
			const block = `${page.heading}\n${page.text}`;
			if (spent + block.length > budget && kept.length) break;
			kept.unshift(block);
			spent += block.length;
		}
		return kept.join('\n\n---\n\n');
	}

	private normalized(
		page: { text: string; normalized: Map<Hyphens, string> },
		hyphens: Hyphens
	): string {
		let found = page.normalized.get(hyphens);
		if (found === undefined) {
			found = ` ${normalizeForMatching(page.text, hyphens)} `;
			page.normalized.set(hyphens, found);
		}
		return found;
	}
}

type Hyphens = 'join' | 'split';

/** Enough pages to rewrite from, not the whole conversation's reading. */
const RENDER_BUDGET = 160_000;

const ELLIPSIS = /(?:\s*\.){3}|…/;
const MIN_ELIDED_PART_WORDS = 3;

const wordsIn = (normalized: string) =>
	normalized.split(' ').filter(Boolean).length;

function inOrder(page: string, parts: readonly string[]): boolean {
	let from = 0;
	return parts.every((part) => {
		const at = page.indexOf(` ${part} `, from);
		from = at + part.length + 1;
		return at !== -1;
	});
}

/** Which closing mark ends a quotation opened by each opening one. */
const CLOSERS: Record<string, string> = { '“': '”', '"': '"' };

/** A straight quote opens only where a word could start. */
const OPENS_AFTER = /[\s([{—–\-/*_>]/;

/** Past this, an unclosed quotation mark was never going to close. */
const MAX_QUOTE = 800;

/** The older citation grammar, on either side of a quotation (`CITATION`). */
const HANDLE_BEFORE = /\[P\d+\s*[:,]?\s*$/;
const HANDLE_AFTER = /^\s*\[P\d+\]/;
/** What arrived after a closing mark could still become ` [P7]`. */
const HANDLE_MAY_FOLLOW = /^\s{0,2}(?:\[(?:P\d*)?)?$/;

/** The punctuation a sentence puts inside its closing quotation mark. */
const TRAILING = /[,.;:!?]+$/;

/**
 * Marks the quotations in an answer as it streams: a run in quotation marks,
 * five words or more, found on a page the model was shown, becomes
 * `<cite P7>the words</cite>`. Everything else passes through as written.
 *
 * Text is held back only from an opening quotation mark to its closing one,
 * and from `<cite` to `</cite>` — a citation the model wrote itself is left
 * exactly as it is.
 */
export class QuoteMarker {
	private pending = '';
	/** The last character already let through: the start of text counts as a space. */
	private before = ' ';
	/** The last few characters let through, to see a `[P7 ` before a quotation. */
	private tail = '';
	/** Quotations long enough to be evidence that no page shown holds. */
	unmarked = 0;
	marked = 0;

	constructor(private readonly shelf: PageShelf) {}

	push(delta: string): string {
		this.pending += delta;
		return this.drain(false);
	}

	/** Whatever is still held, once the text has ended. */
	flush(): string {
		return this.drain(true);
	}

	private drain(final: boolean): string {
		const text = this.pending;
		let out = '';
		let at = 0;
		while (at < text.length) {
			const char = text[at];

			if (char === '<') {
				const rest = text.slice(at, at + 5).toLowerCase();
				if (rest === '<cite') {
					const close = text.indexOf('</cite>', at);
					if (close === -1 && !final) break;
					const end =
						close === -1 ? text.length : close + '</cite>'.length;
					out += text.slice(at, end);
					at = end;
					continue;
				}
				if (!final && rest.length < 5 && '<cite'.startsWith(rest))
					break;
			}

			const closer = CLOSERS[char];
			const before = at > 0 ? text[at - 1] : this.before;
			if (closer && (char === '“' || OPENS_AFTER.test(before))) {
				const end = text.indexOf(closer, at + 1);
				const paragraph = text.indexOf('\n\n', at + 1);
				const unclosed =
					end === -1 || (paragraph !== -1 && paragraph < end);
				if (unclosed) {
					const hopeless =
						final ||
						paragraph !== -1 ||
						text.length - at > MAX_QUOTE;
					if (!hopeless) break;
				} else {
					// `[P7 "…"]` and `"…" [P7]` are citations already, in the
					// older grammar; the handle after one may not have arrived.
					const after = text.slice(end + 1);
					if (!final && HANDLE_MAY_FOLLOW.test(after)) break;
					const cited =
						HANDLE_BEFORE.test(this.tail + out) ||
						HANDLE_AFTER.test(after);
					out += cited
						? text.slice(at, end + 1)
						: this.mark(char, text.slice(at + 1, end), closer);
					at = end + 1;
					continue;
				}
			}

			out += char;
			at++;
		}
		this.pending = text.slice(at);
		if (out) {
			this.before = out[out.length - 1];
			this.tail = (this.tail + out).slice(-16);
		}
		return out;
	}

	private mark(open: string, inner: string, close: string): string {
		const written = `${open}${inner}${close}`;
		if (inner.includes('<')) return written;
		const trail = TRAILING.exec(inner)?.[0] ?? '';
		const words = inner.slice(0, inner.length - trail.length).trim();
		const handle = this.shelf.find(words);
		if (!handle) {
			if (wordsIn(normalizeForMatching(words)) >= MIN_QUOTE_WORDS)
				this.unmarked++;
			return written;
		}
		this.marked++;
		return `<cite ${handle}>${words}</cite>${trail}`;
	}
}
