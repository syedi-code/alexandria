import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { Env } from '@alexandria/core/platform';

export type Provider = 'anthropic' | 'openai' | 'google';

export interface ModelEntry {
	id: string;
	label: string;
	provider: Provider;
	/** Whether the model can be shown a page as an image or PDF. */
	acceptsFiles: boolean;
}

/**
 * The models Scribe offers. Only models that hold up in a multi-step tool loop
 * belong here; a model that can't is left off rather than given a weaker mode.
 */
export const MODELS: readonly ModelEntry[] = [
	{
		id: 'claude-sonnet-5',
		label: 'Claude Sonnet 5',
		provider: 'anthropic',
		acceptsFiles: true,
	},
	{
		id: 'claude-opus-5',
		label: 'Claude Opus 5',
		provider: 'anthropic',
		acceptsFiles: true,
	},
	{
		id: 'claude-haiku-4-5-20251001',
		label: 'Claude Haiku 4.5',
		provider: 'anthropic',
		acceptsFiles: true,
	},
	{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', acceptsFiles: true },
	{
		id: 'gemini-3.5-flash',
		label: 'Gemini 3.5 Flash',
		provider: 'google',
		acceptsFiles: true,
	},
];

export const DEFAULT_MODEL_ID = 'claude-sonnet-5';

/** Small, cheap models for naming conversations, one per provider. */
const TITLE_MODEL_IDS: Record<Provider, string> = {
	anthropic: 'claude-haiku-4-5-20251001',
	openai: 'gpt-5.4-nano',
	google: 'gemini-3.5-flash-lite',
};

const API_KEYS: Record<Provider, keyof Env> = {
	anthropic: 'ANTHROPIC_API_KEY',
	openai: 'OPENAI_API_KEY',
	google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

const apiKey = (env: Env, provider: Provider) =>
	env[API_KEYS[provider]] as string | undefined;

export function availableModels(env: Env): ModelEntry[] {
	return MODELS.filter((model) => apiKey(env, model.provider));
}

export function findModel(env: Env, id: string): ModelEntry | undefined {
	return availableModels(env).find((model) => model.id === id);
}

function providerModel(
	env: Env,
	provider: Provider,
	id: string
): LanguageModel {
	const key = apiKey(env, provider);
	switch (provider) {
		case 'anthropic':
			return createAnthropic({ apiKey: key })(id);
		case 'openai':
			return createOpenAI({ apiKey: key })(id);
		case 'google':
			return createGoogle({ apiKey: key })(id);
	}
}

export function languageModel(env: Env, model: ModelEntry): LanguageModel {
	return providerModel(env, model.provider, model.id);
}

export function titleModel(env: Env, model: ModelEntry): LanguageModel {
	return providerModel(env, model.provider, TITLE_MODEL_IDS[model.provider]);
}
