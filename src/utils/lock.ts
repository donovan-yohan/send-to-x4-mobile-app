/**
 * Async mutex — serializes read-modify-write cycles against a shared store.
 *
 * Hoisted out of the former `src/services/queue_storage.ts` (since deleted with
 * the article flow) so the messenger's message/outbox queue can reuse the
 * locking discipline without inheriting the article-queue module.
 * Currently has no callers — it is the seed for that queue.
 *
 * `createLock()` returns an INDEPENDENT lock chain. Callers that must not
 * serialize against each other should each create their own.
 */

export type WithLock = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLock(): WithLock {
    let tail: Promise<void> = Promise.resolve();

    return function withLock<T>(fn: () => Promise<T>): Promise<T> {
        let release!: () => void;
        const next = new Promise<void>(resolve => { release = resolve; });
        const prev = tail;
        tail = next;

        return prev.then(async () => {
            try {
                return await fn();
            } finally {
                release();
            }
        });
    };
}
