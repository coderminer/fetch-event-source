import * as fetch from './fetch';
import * as api from './index';

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

        it('evaluates a headers function once per attempt, keeping last-event-id on top', async () => {
            // arrange: attempt 1 delivers a message carrying an id and then
            // dies mid-stream, so attempt 2 must both re-evaluate the header
            // function AND carry the tracked last-event-id forward into its
            // own freshly normalized copy:
            const encoder = new TextEncoder();
            let calls = 0;
            let pullCount = 0;
            const headersFn = jasmine
                .createSpy('headers')
                .and.callFake(() => ({ 'x-request-id': `req-${calls}` }));
            const fetchSpy = jasmine.createSpy('fetch').and.callFake(() => {
                ++calls;
                return calls === 1
                    ? Promise.resolve(new Response(
                        new ReadableStream({
                            // pull()-based so the chunk is delivered on the
                            // first read and the failure on the second: a
                            // start()-style enqueue+error in one go would
                            // DISCARD the chunk (error() clears the queue),
                            // losing bytes a real server would have sent:
                            pull(controller) {
                                if (++pullCount === 1) {
                                    controller.enqueue(encoder.encode('id: ev-1\ndata: hi\n\n'));
                                } else {
                                    controller.error(new Error('midstream cut'));
                                }
                            },
                        }),
                        { headers: { 'content-type': 'text/event-stream' } },
                    ))
                    : Promise.resolve(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
            });

            // act:
            await fetch.fetchEventSource('/api/sse', {
                openWhenHidden: true,
                headers: headersFn,
                onopen: async () => { },
                onclose: async () => { },
                onerror: () => 0, // retry immediately
                fetch: fetchSpy as any,
            });

            // assert:
            expect(headersFn).toHaveBeenCalledTimes(2); // fresh per attempt
            const attempt1 = (fetchSpy.calls.argsFor(0)[1] as RequestInit).headers as Record<string, string>;
            expect(attempt1['x-request-id']).toBe('req-0');
            expect(attempt1['last-event-id']).toBeUndefined();
            const attempt2 = (fetchSpy.calls.argsFor(1)[1] as RequestInit).headers as Record<string, string>;
            expect(attempt2['x-request-id']).toBe('req-1');
            // the server-assigned id survives into the fresh copy and, per the
            // SSE spec, wins over anything the caller's function may hand back:
            expect(attempt2['last-event-id']).toBe('ev-1');
        });

        it('awaits headers functions that return a promise', async () => {
            // arrange:
            const fetchSpy = jasmine.createSpy('fetch').and.resolveTo(
                new Response('', { headers: { 'content-type': 'text/event-stream' } }));

            // act:
            await fetch.fetchEventSource('/api/sse', {
                headers: async () => new Headers({ 'x-token': 'async-value' }),
                onopen: async () => { },
                onclose: async () => { },
                fetch: fetchSpy as any,
            });

            // assert:
            const sent = (fetchSpy.calls.argsFor(0)[1] as RequestInit).headers as Record<string, string>;
            expect(sent['x-token']).toBe('async-value');
            expect(sent.accept).toBe('text/event-stream'); // default injected as usual
        });

        it('honors retryIntervalMs as the base automatic retry interval', async () => {
            // arrange: spy the scheduler (passing through) so delays can be
            // asserted without racing real timers; only attempts are timed:
            const setTimeoutSpy = spyOn(globalThis, 'setTimeout').and.callThrough();
            let calls = 0;
            const fetchSpy = jasmine.createSpy('fetch').and.callFake(() => {
                ++calls;
                return calls < 3
                    ? Promise.reject(new Error('gateway down'))
                    : Promise.resolve(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
            });

            // act:
            const promise = fetch.fetchEventSource('/api/sse', {
                openWhenHidden: true,
                retryIntervalMs: 25,
                onopen: async () => { },
                onclose: async () => { },
                fetch: fetchSpy as any,
            });
            while (calls < 3) {
                await new Promise(resolve => globalThis.setTimeout(resolve, 5));
            }
            await promise;

            // assert: two automatic retries were scheduled with the base interval:
            const scheduled = setTimeoutSpy.calls.allArgs().filter((args: any[]) => args[1] === 25);
            expect(scheduled.length).toBe(2);
            expect(fetchSpy.calls.count()).toBe(3);
        });

        it('resets exponential backoff after every successful open', async () => {
            // arrange: two failed attempts ramp the interval 10 → 20; a third
            // attempt opens fine but its stream dies mid-flight, which must
            // NOT keep ramping (the schedule resets to the base on open):
            const setTimeoutSpy = spyOn(globalThis, 'setTimeout').and.callThrough();
            const encoder = new TextEncoder();
            let calls = 0;
            const fetchSpy = jasmine.createSpy('fetch').and.callFake(() => {
                ++calls;
                return calls === 1 || calls === 2
                    ? Promise.reject(new Error('gateway down'))
                    : calls === 3
                        ? Promise.resolve(new Response(
                            new ReadableStream({
                                start(controller) {
                                    controller.enqueue(encoder.encode('data: partial\n\n'));
                                    controller.error(new Error('midstream cut'));
                                },
                            }),
                            { headers: { 'content-type': 'text/event-stream' } },
                        ))
                        : calls === 4
                            ? Promise.reject(new Error('gateway down again'))
                            : Promise.resolve(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
            });

            // act:
            const promise = fetch.fetchEventSource('/api/sse', {
                openWhenHidden: true,
                retryIntervalMs: 10,
                maxRetryIntervalMs: 30,
                onopen: async () => { },
                onclose: async () => { },
                fetch: fetchSpy as any,
            });
            while (calls < 5) {
                await new Promise(resolve => globalThis.setTimeout(resolve, 5));
            }
            await promise;

            // assert: 5 attempts, 4 retries; the ramp restarts at 10 after the
            // successful third attempt instead of continuing to 40:
            const scheduled = setTimeoutSpy.calls.allArgs()
                .filter((args: any[]) => args[1] === 10 || args[1] === 20)
                .map((args: any[]) => args[1]);
            expect(scheduled).toEqual([10, 20, 10, 20]);
        });

        it('caps exponential backoff at maxRetryIntervalMs', async () => {
            // arrange: with base 10 and cap 15, consecutive failures schedule
            // 10, 15, 15, 15 - the doubled value (20/40/80) never exceeds the cap:
            const setTimeoutSpy = spyOn(globalThis, 'setTimeout').and.callThrough();
            let calls = 0;
            const fetchSpy = jasmine.createSpy('fetch').and.callFake(() => {
                ++calls;
                return calls < 5
                    ? Promise.reject(new Error('gateway down'))
                    : Promise.resolve(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
            });

            // act:
            const promise = fetch.fetchEventSource('/api/sse', {
                openWhenHidden: true,
                retryIntervalMs: 10,
                maxRetryIntervalMs: 15,
                onopen: async () => { },
                onclose: async () => { },
                fetch: fetchSpy as any,
            });
            while (calls < 5) {
                await new Promise(resolve => globalThis.setTimeout(resolve, 5));
            }
            await promise;

            // assert:
            const scheduled = setTimeoutSpy.calls.allArgs()
                .filter((args: any[]) => args[1] === 10 || args[1] === 15)
                .map((args: any[]) => args[1]);
            expect(scheduled).toEqual([10, 15, 15, 15]);
        });

        it('treats a byte-less stall as a retriable TimeoutError when idleTimeoutMs is set', async () => {
            // arrange: the first attempt's stream (read after onopen resolved)
            // never delivers a byte; aborting it rejects the pending read,
            // like a real reverse-proxy-killed connection does:
            const hangingStreamResponse = (signal: AbortSignal) => ({
                ok: true,
                status: 200,
                headers: { get: () => 'text/event-stream' },
                body: {
                    getReader: () => ({
                        read: () => new Promise<never>((_resolve, reject) => {
                            signal.addEventListener('abort', () => reject(signal.reason));
                        }),
                        cancel: async () => { },
                    }),
                },
            } as unknown as Response);
            const onerrorSpy = jasmine.createSpy('onerror').and.returnValue(0); // retry immediately
            let calls = 0;
            const fetchSpy = jasmine.createSpy('fetch').and.callFake((_input: any, init: RequestInit) => {
                ++calls;
                return calls === 1
                    ? Promise.resolve(hangingStreamResponse(init.signal as AbortSignal))
                    : Promise.resolve(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
            });

            // act:
            const promise = fetch.fetchEventSource('/api/sse', {
                openWhenHidden: true,
                idleTimeoutMs: 20,
                onopen: async () => { },
                onerror: onerrorSpy,
                fetch: fetchSpy as any,
            });
            while (calls < 2) {
                await new Promise(resolve => globalThis.setTimeout(resolve, 5));
            }
            await promise;

            // assert: the stall surfaced as the abort reason (a TimeoutError
            // DOMException) through the standard onerror path, and the retry
            // recovered on an eventually-closing second attempt:
            const stallError = onerrorSpy.calls.argsFor(0)[0] as DOMException;
            expect(stallError.name).toBe('TimeoutError');
            expect(fetchSpy.calls.count()).toBe(2);
        });

        it('arms no idle timer by default and an abort still resolves quietly', async () => {
            // arrange: without idleTimeoutMs nothing ever flags the stall;
            // hanging forever is legal SSE. Aborting the caller signal later
            // resolves the promise without any error-routing:
            const ctrl = new AbortController();
            const onerrorSpy = jasmine.createSpy('onerror');
            const hangingStreamResponse = (signal: AbortSignal) => ({
                ok: true,
                status: 200,
                headers: { get: () => 'text/event-stream' },
                body: {
                    getReader: () => ({
                        read: () => new Promise<never>((_resolve, reject) => {
                            signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
                        }),
                        cancel: async () => { },
                    }),
                },
            } as unknown as Response);
            const fetchSpy = jasmine.createSpy('fetch').and.callFake((_input: any, init: RequestInit) => {
                return Promise.resolve(hangingStreamResponse(init.signal as AbortSignal));
            });

            // act:
            const promise = fetch.fetchEventSource('/api/sse', {
                signal: ctrl.signal,
                openWhenHidden: true,
                onopen: async () => { },
                onerror: onerrorSpy,
                fetch: fetchSpy as any,
            });
            await new Promise(resolve => globalThis.setTimeout(resolve, 40)); // well past any test-sized idle window
            ctrl.abort();
            await promise;

            // assert:
            expect(onerrorSpy).not.toHaveBeenCalled();
            expect(fetchSpy.calls.count()).toBe(1); // no retry followed the abort
        });
    });

    describe('index barrel', () => {
        it('re-exports exactly the public runtime surface, keeping the barrel trivial', () => {
            // the specs import ./fetch and ./parse directly, so the barrel
            // would otherwise live entirely outside the execution path; this
            // smoke spec keeps it wired and pins its shape (new public value
            // exports must update this assertion deliberately):
            expect(Object.keys(api).sort()).toEqual([
                'EventStreamContentType',
                'fetchEventSource',
            ]);
        });
    });
});
