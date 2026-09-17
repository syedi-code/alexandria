/**
 * What a client needs in order to agree with the server about the shape of
 * what it is editing: how long a field may be, and which parameters an embed
 * token may carry.
 *
 * Both are pure data, so they have exactly one home — here — and travel over
 * the wire on POST /session and GET /me. The parsing machinery that reads
 * them is code, has to run on every keystroke, and is shipped in the client
 * instead. Plan D20.
 *
 * This file sits above works/ and writing/ because the contract spans both.
 */
import { MAX_LENGTHS } from './platform/limits.js';
import {
	EMBED_PARAM_SPECS,
	type EmbedParamSpecs,
} from './writing/essay-tokens.js';

export interface ApiContract {
	limits: typeof MAX_LENGTHS;
	embed_param_specs: EmbedParamSpecs;
}

export function apiContract(): ApiContract {
	return { limits: MAX_LENGTHS, embed_param_specs: EMBED_PARAM_SPECS };
}
