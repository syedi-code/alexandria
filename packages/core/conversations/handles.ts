import type { PageRef } from '../works/pages.js';
import type { ChatMessage } from './schema.js';

const HANDLE = /^P([1-9]\d*)$/;

const refKey = (ref: PageRef) => `${ref.document_id}#${ref.page_no}`;

function isPageRef(value: unknown): value is PageRef {
	const ref = value as PageRef;
	return (
		typeof ref?.document_id === 'string' && Number.isInteger(ref?.page_no)
	);
}

/**
 * Short names — P1, P2, … — for the pages a model has been shown in one
 * conversation. Models copy `P7` reliably and UUIDs unreliably, and a handle
 * only exists for a page a tool actually returned, so a citation can never
 * point at a page the model did not see.
 */
export class PageHandles {
	private readonly refs = new Map<string, PageRef>();
	private readonly handles = new Map<string, string>();
	private last = 0;

	/** Recovers the handles already given out, from the tool results stored in a conversation. */
	static fromMessages(messages: readonly ChatMessage[]): PageHandles {
		const registry = new PageHandles();
		const visit = (value: unknown): void => {
			if (Array.isArray(value)) return value.forEach(visit);
			if (!value || typeof value !== 'object') return;
			const { handle, ref } = value as {
				handle?: unknown;
				ref?: unknown;
			};
			if (typeof handle === 'string' && isPageRef(ref)) {
				registry.restore(handle, ref);
			}
			Object.values(value).forEach(visit);
		};
		for (const message of messages) {
			for (const part of message.parts as {
				type?: string;
				output?: unknown;
			}[]) {
				if (part.type?.startsWith('tool-')) visit(part.output);
			}
		}
		return registry;
	}

	private restore(handle: string, ref: PageRef): void {
		const match = HANDLE.exec(handle);
		if (!match || this.refs.has(handle)) return;
		this.refs.set(handle, ref);
		this.handles.set(refKey(ref), handle);
		this.last = Math.max(this.last, Number(match[1]));
	}

	handleFor(ref: PageRef): string {
		const existing = this.handles.get(refKey(ref));
		if (existing) return existing;
		const handle = `P${++this.last}`;
		this.restore(handle, {
			document_id: ref.document_id,
			page_no: ref.page_no,
		});
		return handle;
	}

	resolve(handle: string): PageRef | undefined {
		return this.refs.get(handle.trim());
	}

	label<T extends { ref: PageRef }>(
		items: readonly T[]
	): (T & { handle: string })[] {
		return items.map((item) => ({
			...item,
			handle: this.handleFor(item.ref),
		}));
	}
}
