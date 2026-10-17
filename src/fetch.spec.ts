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

        it('normalizes Headers and string-pair-array header inputs', async () => {
            // arrange:
            // a fresh Response per call: response bodies can only be read once
            const fetchSpy = jasmine.createSpy('fetch').and.callFake(
                () => new Response('', { headers: { 'content-type': 'text/event-stream' } }));
            const options = {
                onopen: async () => { },
                onclose: async () => { },
                fetch: fetchSpy as any,
            };

            // act:
            await fetch.fetchEventSource('/api/sse', {
                ...options,
                headers: new Headers({ Authorization: 'Bearer t1' }),
            });
            await fetch.fetchEventSource('/api/sse', {
                ...options,
                headers: [['Authorization', 'Bearer t2'], ['X-A', '1'], ['X-A', '2']] as [string, string][],
            });
            await fetch.fetchEventSource('/api/sse', {
                ...options,
                headers: { Accept: 'application/json' },
            });
            await fetch.fetchEventSource('/api/sse', {
                ...options,
                // demonstrate prototype-collision safety: a JSON.parse'd record
                // can legitimately own the key "__proto__":
                headers: JSON.parse('{"x-y":"z","__proto__":"weird"}') as Record<string, string>,
            });

            // assert:
            // all three forms are normalized identically: keys are lowercased
            // and duplicate keys are comma-joined like Headers.append; a
            // user-supplied accept replaces the default instead of merging:
            const initHeaders1 = (fetchSpy.calls.argsFor(0)[1] as RequestInit).headers as Record<string, string>;
            expect(initHeaders1).toEqual(jasmine.objectContaining({
                authorization: 'Bearer t1',
                accept: 'text/event-stream',
            }));
            const initHeaders2 = (fetchSpy.calls.argsFor(1)[1] as RequestInit).headers as Record<string, string>;
            expect(initHeaders2).toEqual(jasmine.objectContaining({
                authorization: 'Bearer t2',
                'x-a': '1, 2',
                accept: 'text/event-stream',
            }));
            const initHeaders3 = (fetchSpy.calls.argsFor(2)[1] as RequestInit).headers as Record<string, string>;
            expect(initHeaders3).toEqual(jasmine.objectContaining({
                accept: 'application/json',
            }));
            expect(Object.keys(initHeaders3).filter(k => k !== 'accept')).toEqual([]);
            // a null-prototype working copy keeps exotic names as own
            // properties, so they are sent as-is instead of being dropped,
            // merged with an inherited value, or hijacking the prototype.
            // This asserts at the library's own boundary: end-to-end
            // transmission of `__proto__` still depends on the platform's
            // Headers implementation (undici, unlike `constructor`, drops it):
            const initHeaders4 = (fetchSpy.calls.argsFor(3)[1] as RequestInit).headers as Record<string, string>;
            expect(initHeaders4['x-y']).toBe('z');
            expect(Object.getOwnPropertyDescriptor(initHeaders4, '__proto__')!.value).toBe('weird');
        });

        it('falls back to arrayBuffer when the polyfilled response has no body stream', async () => {
            // arrange:
            const onmessage = jasmine.createSpy('onmessage');
            const fakeResponse = {
                body: null,
                arrayBuffer: async () => new TextEncoder().encode('data: polyfill\n\n').buffer,
                headers: { get: () => 'text/event-stream' },
            } as unknown as Response;
            const fetchSpy = jasmine.createSpy('fetch').and.resolveTo(fakeResponse);

            // act:
            await fetch.fetchEventSource('/api/sse', {
                onopen: async () => { },
                onclose: async () => { },
                onmessage,
                fetch: fetchSpy as any,
            });

            // assert:
            expect(onmessage).toHaveBeenCalledWith(jasmine.objectContaining({ data: 'polyfill' }));
        });

        it('removes its abort listener from the caller signal when done', async () => {
            // arrange:
            const ctrl = new AbortController();
            const removeSpy = spyOn(ctrl.signal, 'removeEventListener').and.callThrough();
            const okResponse = new Response('', { headers: { 'content-type': 'text/event-stream' } });
            const fetchSpy = jasmine.createSpy('fetch').and.resolveTo(okResponse);

            // act:
            await fetch.fetchEventSource('/api/sse', {
                signal: ctrl.signal,
                onopen: async () => { },
                onclose: async () => { },
                fetch: fetchSpy as any,
            });

            // assert:
            expect(removeSpy).toHaveBeenCalledWith('abort', jasmine.any(Function));
        });

        it('retries with a fresh clone of a Request input and never consumes the original body', async () => {
            // arrange:
            const input = new Request('http://example.invalid/sse', { method: 'POST', body: '{"a":1}' });
            const okResponse = new Response('', { headers: { 'content-type': 'text/event-stream' } });
            let calls = 0;
            const fetchSpy = jasmine.createSpy('fetch').and.callFake(() => {
                ++calls;
                return calls === 1
                    ? Promise.reject(new Error('gateway down'))
                    : Promise.resolve(okResponse);
            });

            // act:
            const promise = fetch.fetchEventSource(input, {
                openWhenHidden: true,
                onopen: async () => { },
                onerror: () => 0, // retry immediately
                fetch: fetchSpy as any,
            });
            while (calls < 2) {
                await new Promise(resolve => globalThis.setTimeout(resolve, 5));
            }
            await promise;

            // assert:
            const firstAttemptInput = fetchSpy.calls.argsFor(0)[0] as Request;
            expect(firstAttemptInput).not.toBe(input); // a clone was fetched
            expect(input.bodyUsed).toBe(false); // the original body is intact for future retries
        });

        it('cancels the in-flight request when the caller aborts before onopen', async () => {
            // arrange: simulate a fetch that rejects with an AbortError when
            // its signal is aborted, like the real one does:
            let capturedSignal: AbortSignal | null = null;
            const fetchSpy = jasmine.createSpy('fetch').and.callFake((_input: any, init: RequestInit) => {
                capturedSignal = init.signal as AbortSignal;
                return new Promise<Response>((_resolve, reject) => {
                    (init.signal as AbortSignal).addEventListener('abort', () => {
                        reject(new DOMException('This operation was aborted', 'AbortError'));
                    });
                });
            });
            const ctrl = new AbortController();

            // act:
            const promise = fetch.fetchEventSource('/api/sse', {
                signal: ctrl.signal,
                openWhenHidden: true,
                fetch: fetchSpy as any,
            });
            ctrl.abort();
            await promise;

            // assert:
            expect(capturedSignal!.aborted).toBe(true); // the attempt's signal is aborted
            // the aborted attempt's rejection must not schedule a retry:
            expect(fetchSpy.calls.count()).toBe(1);
        });

        it('reconnects to the final URL after redirects, for string inputs', async () => {
            // arrange: like native EventSource, a connection that follows a
            // redirect makes its NEXT connection target the redirected URL;
            // the update lands after a response carries response.url, so the
            // retry following it must use the new target:
            const redirectedResponse = {
                ok: false,
                status: 502,
                headers: { get: () => 'text/html' },
                url: 'https://redirected.example/sse',
                body: null,
                arrayBuffer: async () => new ArrayBuffer(0),
            } as unknown as Response;
            const inputs: unknown[] = [];
            let calls = 0;
            const fetchSpy = jasmine.createSpy('fetch').and.callFake((reqInput: any) => {
                ++calls;
                inputs.push(reqInput);
                return calls === 1
                    ? Promise.reject(new Error('gateway down'))
                    : calls === 2
                        ? Promise.resolve(redirectedResponse)
                        // a normal constructed Response carries url === '':
                        : Promise.resolve(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
            });

            // act:
            const promise = fetch.fetchEventSource('/api/sse', {
                openWhenHidden: true,
                onopen: async (response) => {
                    if (!response.ok) {
                        throw new Error('bad gateway');
                    }
                },
                onerror: () => 0, // retry immediately
                fetch: fetchSpy as any,
            });
            while (calls < 3) {
                await new Promise(resolve => globalThis.setTimeout(resolve, 5));
            }
            await promise;

            // assert:
            expect(inputs[0]).toBe('/api/sse');
            // the second attempt still used the original url (the update lands
            // after attempt 2's response reported the redirect):
            expect(inputs[1]).toBe('/api/sse');
            // the third attempt used the final (redirected) url:
            expect(inputs[2]).toBe('https://redirected.example/sse');
        });

        it('stops reconnecting when the default onopen sees a 204 response', async () => {
            // arrange: per the spec, a 204 response tells the client the
            // connection is no longer open and to stop reconnecting. onerror
            // is still invoked (so unawaited, onerror-centric callers learn
            // about the stop), but its interval return is ignored since no
            // retry follows:
            const notModifiedResponse = {
                ok: true,
                status: 204,
                headers: { get: () => 'text/event-stream' },
                body: null,
                arrayBuffer: async () => new ArrayBuffer(0),
            } as unknown as Response;
            const fetchSpy = jasmine.createSpy('fetch').and.resolveTo(notModifiedResponse);
            const onerrorSpy = jasmine.createSpy('onerror').and.returnValue(99999);

            // act:
            const promise = fetch.fetchEventSource('/api/sse', {
                openWhenHidden: true,
                onerror: onerrorSpy,
                fetch: fetchSpy as any,
            });

            // assert:
            await expectAsync(promise).toBeRejectedWithError('Received a 204 response; per spec the client stops reconnecting');
            expect(onerrorSpy).toHaveBeenCalledTimes(1);
            expect(fetchSpy.calls.count()).toBe(1); // the returned interval was ignored
        });

        it('lets an onerror that throws override the outcome when reconnection stops', async () => {
            // arrange:
            const notModifiedResponse = {
                ok: true,
                status: 204,
                headers: { get: () => 'text/event-stream' },
                body: null,
                arrayBuffer: async () => new ArrayBuffer(0),
            } as unknown as Response;
            const fetchSpy = jasmine.createSpy('fetch').and.resolveTo(notModifiedResponse);
            const onerrorSpy = jasmine.createSpy('onerror').and.throwError('user-custom-stop');

            // act:
            const promise = fetch.fetchEventSource('/api/sse', {
                openWhenHidden: true,
                onerror: onerrorSpy,
                fetch: fetchSpy as any,
            });

            // assert:
            await expectAsync(promise).toBeRejectedWithError('user-custom-stop');
            expect(fetchSpy.calls.count()).toBe(1);
        });
    });
});
