import { extractText, getDocumentProxy } from 'unpdf';

/** Recorded as the transcription's prompt_version, so a change of extractor is visible. */
export const EXTRACTOR = 'unpdf@1';

/** One entry per PDF page, index 0 being page 1; empty where a page has no text layer. */
export async function extractPageTexts(pdf: Uint8Array): Promise<string[]> {
	const { text } = await extractText(await getDocumentProxy(pdf), {
		mergePages: false,
	});
	return text;
}
