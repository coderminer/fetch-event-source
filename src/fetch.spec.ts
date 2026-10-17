import * as fetch from './fetch';

describe('fetch', () => {
    describe('fetchEventSource', () => {
        it('is a no-op when the caller signal is already aborted', async () => {
            // arrange:
            const ctrl = new AbortController();
            ctrl.abort();
            const fetchSpy = jasmine.createSpy('fetch');

            // act:
            await fetch.fetchEventSource('/api/sse', {
                signal: ctrl.signal,
                fetch: fetchSpy as any,
            });

            // assert:
            expect(fetchSpy.calls.count()).toBe(0);
        });

        it('resolves when the caller signal aborts mid-request', async () => {
            // arrange:
            const ctrl = new AbortController();
            const fetchSpy = jasmine.createSpy('fetch')
                .and.returnValue(new Promise<Response>(() => { /* never settles */ }));

            // act:
            const promise = fetch.fetchEventSource('/api/sse', {
                signal: ctrl.signal,
                fetch: fetchSpy as any,
            });
            ctrl.abort();
            await promise;

            // assert:
            expect(fetchSpy.calls.count()).toBe(1);
        });

        it('routes errors thrown from an async onclose through onerror', async () => {
            // arrange:
            const sentinel = new Error('fatal');
            const onerrorSpy = jasmine.createSpy('onerror').and.throwError(sentinel);
            const response = new Response('data: hi\n\n', {
                headers: { 'content-type': 'text/event-stream' },
            });
            const fetchSpy = jasmine.createSpy('fetch').and.resolveTo(response);

            // act:
            const promise = fetch.fetchEventSource('/api/sse', {
                onopen: async () => { },
                onclose: async () => { throw sentinel; },
                onerror: onerrorSpy,
                fetch: fetchSpy as any,
            });

            // assert:
            await expectAsync(promise).toBeRejectedWith(sentinel);
            expect(onerrorSpy).toHaveBeenCalledWith(sentinel);
            expect(fetchSpy.calls.count()).toBe(1); // no retry was scheduled
        });
    });
});
