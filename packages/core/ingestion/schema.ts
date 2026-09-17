import { z } from 'zod';
import { MAX_LENGTHS } from '../platform/limits.js';

// Ingested world data. Defined here for completeness; nothing reads these yet.

export const WeatherSource = z.enum(['open-meteo']);

export const WeatherDay = z.object({
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	zip: z.string().min(1).max(MAX_LENGTHS.SHORT),
	latitude: z.number(),
	longitude: z.number(),
	source: WeatherSource,
	high_c: z.number().nullable(),
	low_c: z.number().nullable(),
	high_f: z.number().nullable(),
	low_f: z.number().nullable(),
	precip_mm: z.number().nullable(),
	precip_in: z.number().nullable(),
	weather_code: z.number().int().nullable(),
	conditions: z.string().max(MAX_LENGTHS.TITLE).nullable().optional(),
	fetched_at: z.string().datetime(),
	raw: z.record(z.unknown()).optional(),
});

export type WeatherDay = z.infer<typeof WeatherDay>;

export const NewsSource = z.enum(['al-jazeera']);

export const NewsEntry = z.object({
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	source: NewsSource,
	title: z.string().min(1).max(MAX_LENGTHS.TITLE),
	url: z.string().min(1).max(MAX_LENGTHS.URL),
	fetched_at: z.string().datetime(),
	id: z.string().max(MAX_LENGTHS.ID).optional(),
	summary: z.string().max(MAX_LENGTHS.CONTENT).nullable().optional(),
	raw: z.record(z.unknown()).optional(),
});

export type NewsEntry = z.infer<typeof NewsEntry>;
