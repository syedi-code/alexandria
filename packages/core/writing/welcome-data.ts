import type {
	NoteInput,
	QuoteInput,
	ThoughtInput,
	ThreadInput,
} from './schema.js';

/**
 * Welcome content seeded for new users on first login.
 * Hardcoded in TypeScript — runs natively in Cloudflare Workers with no I/O.
 */

export const WELCOME_NOTES: NoteInput[] = [
	{
		content:
			'Welcome to your personal space! This is a note — use notes to capture ideas, observations, reading highlights, or anything worth remembering. You can tag notes, link them to books, and organize them into threads.',
		source: 'system',
	},
	{
		content:
			'Try the different tabs above to explore Notes, Quotes, Thoughts, and Threads. Each content type has its own purpose:\n\n• Notes — longer-form text, reading annotations, ideas\n• Quotes — memorable passages with attribution\n• Thoughts — quick atomic ideas\n• Threads — curated collections that tie it all together',
		source: 'system',
	},
];

export const WELCOME_QUOTES: QuoteInput[] = [
	{
		quote: 'The only way to do great work is to love what you do.',
		creator: 'Steve Jobs',
		source: 'system',
	},
];

export const WELCOME_THOUGHTS: ThoughtInput[] = [
	{
		content: 'First thought — a blank canvas is full of possibility.',
		author: 'system',
	},
];

export const WELCOME_THREAD: ThreadInput = {
	name: 'Getting Started',
	description:
		'A curated introduction to your personal space. Feel free to delete this thread once you are comfortable.',
};
