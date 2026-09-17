/// <reference types="@cloudflare/workers-types" />
/**
 * YouTube Metadata Enrichment for D1
 *
 * Fetches and caches YouTube video metadata using NoEmbed.
 * Uses Cloudflare D1 for caching instead of Neon Postgres.
 */

export type YouTubeMetadata = {
	title: string;
	author_name: string;
	author_url: string;
	thumbnail_url: string;
	type: string;
	description?: string;
};

export type EnrichResult = {
	meta: YouTubeMetadata | null;
	status: 'hit' | 'miss' | 'error' | 'skipped';
};

export async function enrichYouTube(
	db: D1Database,
	url: string,
	noembedBase = 'https://noembed.com/embed?url='
): Promise<EnrichResult> {
	// 1. Extract Video ID
	const videoId = extractVideoId(url);
	if (!videoId) {
		return { meta: null, status: 'skipped' };
	}

	// 2. Check Cache
	try {
		const row = await db
			.prepare('SELECT data FROM youtube_cache WHERE video_id = ?')
			.bind(videoId)
			.first<{ data: string }>();

		if (row) {
			return {
				meta: JSON.parse(row.data) as YouTubeMetadata,
				status: 'hit',
			};
		}
	} catch {
		// Cache read error is not fatal, proceed to fetch
	}

	// 3. Fetch from NoEmbed
	try {
		const fetchUrl = `${noembedBase}${encodeURIComponent(url)}`;
		const res = await fetch(fetchUrl);
		if (!res.ok) {
			return { meta: null, status: 'error' };
		}
		const data = (await res.json()) as Record<string, unknown>;
		if (!data.title) {
			return { meta: null, status: 'error' }; // NoEmbed returns {error: ...}
		}

		const meta: YouTubeMetadata = {
			title: String(data.title),
			author_name: String(data.author_name),
			author_url: String(data.author_url),
			thumbnail_url: String(data.thumbnail_url),
			type: String(data.type),
		};

		// 4. Cache It
		try {
			await db
				.prepare(
					`INSERT INTO youtube_cache (video_id, data) 
					 VALUES (?, ?) 
					 ON CONFLICT (video_id) DO NOTHING`
				)
				.bind(videoId, JSON.stringify(meta))
				.run();
		} catch {
			// Cache write error is annoying but we still have the data
		}

		return { meta, status: 'miss' };
	} catch {
		return { meta: null, status: 'error' };
	}
}

function extractVideoId(url: string): string | null {
	try {
		const u = new URL(url);
		if (u.hostname === 'youtu.be') return u.pathname.slice(1);
		if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
	} catch {
		// ignore
	}
	return null;
}
