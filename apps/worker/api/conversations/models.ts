import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { Env, UserPlan } from '@alexandria/core/platform';

export type Provider = 'anthropic' | 'openai' | 'google';

export interface ModelEntry {
	id: string;
	label: string;
	provider: Provider;
	/** Whether the model can be shown a page as an image or PDF. */
	acceptsFiles: boolean;
	/**
	 * Whether a free reader may choose it. The tiering lives next to the model
	 * rather than in a list somewhere else, because which model someone gets
	 * is a fact about the model, and a list kept elsewhere goes stale.
	 */
	free: boolean;
	/**
	 * Only the admin may choose it: a model too dear to put on any plan, kept
	 * for the times a better answer is worth paying for by hand.
	 */
	adminOnly?: boolean;
}

/**
 * The models Scribe offers. Only models that hold up in a multi-step tool loop
 * belong here; a model that can't is left off rather than given a weaker mode.
 *
 * Kept short on purpose. Every entry is a model someone has to have an opinion
 * about, and a roster of five where two were never chosen is five things to
 * keep current for no reading anyone does.
 */
export const MODELS: readonly ModelEntry[] = [
	{
		// Not `gpt-5.6`: that is an alias for Sol, at twenty times the price.
		id: 'gpt-5.6-luna',
		label: 'GPT-5.6 Luna',
		provider: 'openai',
		acceptsFiles: true,
		free: true,
	},
	{
		// Twenty times Luna's price. Never on a plan, so never on the plans page.
		id: 'gpt-5.6-sol',
		label: 'GPT-5.6 Sol',
		provider: 'openai',
		acceptsFiles: true,
		free: false,
		adminOnly: true,
	},
	{
		id: 'claude-sonnet-5',
		label: 'Claude Sonnet 5',
		provider: 'anthropic',
		acceptsFiles: true,
		free: false,
	},
	{
		id: 'claude-haiku-4-5-20251001',
		label: 'Claude Haiku 4.5',
		provider: 'anthropic',
		acceptsFiles: true,
		free: false,
	},
];

/**
 * Luna costs a fifth of Haiku's input and a quarter of its output, and scores
 * higher. What it spends instead is time: minutes can pass before its first
 * token, and every step of the loop pays that again. It is the default because
 * one person uses this and would rather wait than be billed.
 */
export const DEFAULT_MODEL_ID = 'gpt-5.6-luna';

/** Small, cheap models for naming conversations, one per provider. */
const TITLE_MODEL_IDS: Record<Provider, string> = {
	anthropic: 'claude-haiku-4-5-20251001',
	// The 5.6 family has no nano tier; Luna is the cheap tier. Titling runs
	// after the answer, off the critical path, so its latency costs nothing.
	openai: 'gpt-5.6-luna',
	google: 'gemini-3.5-flash-lite',
};

const API_KEYS: Record<Provider, keyof Env> = {
	anthropic: 'ANTHROPIC_API_KEY',
	openai: 'OPENAI_API_KEY',
	google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

const apiKey = (env: Env, provider: Provider) =>
	env[API_KEYS[provider]] as string | undefined;

/**
 * The models a reader may choose: those whose provider key is set, and — for a
 * free reader — those marked free. Only the admin's roster, `unlimited`, holds
 * the admin's models. The plan is a property of the reader, not of the
 * request, so it is passed in rather than read from anywhere here.
 */
export function availableModels(
	env: Env,
	plan: UserPlan | 'unlimited' = 'unlimited'
): ModelEntry[] {
	return MODELS.filter(
		(model) =>
			apiKey(env, model.provider) &&
			(plan === 'unlimited' || !model.adminOnly) &&
			(plan !== 'free' || model.free)
	);
}

/**
 * The models a plan above the reader's would open: set up here, but not on
 * their plan. Listed so a client can say *on Paid* rather than *no key set*;
 * the admin's models are never among them, because no plan opens those.
 */
export function lockedModels(
	env: Env,
	plan: UserPlan | 'unlimited'
): ModelEntry[] {
	const open = new Set(availableModels(env, plan).map((model) => model.id));
	return availableModels(env, 'paid').filter((model) => !open.has(model.id));
}

export function findModel(
	env: Env,
	id: string,
	plan: UserPlan | 'unlimited' = 'unlimited'
): ModelEntry | undefined {
	return availableModels(env, plan).find((model) => model.id === id);
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
