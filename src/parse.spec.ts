import * as parse from './parse';

describe('parse', () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    describe('getLines', () => {
        it('single line', () => {
            // arrange:
            let lineNum = 0;
            const next = parse.getLines((line, fieldLength) => {
                ++lineNum;
                expect(decoder.decode(line)).toEqual('id: abc');
                expect(fieldLength).toEqual(2);
            });

            // act:
            next(encoder.encode('id: abc\n'));
            
            // assert:
            expect(lineNum).toBe(1);
        });

        it('multiple lines', () => {
            // arrange:
            let lineNum = 0;
            const next = parse.getLines((line, fieldLength) => {
                ++lineNum;
                expect(decoder.decode(line)).toEqual(lineNum === 1 ? 'id: abc' : 'data: def');
                expect(fieldLength).toEqual(lineNum === 1 ? 2 : 4);
            });
            
            // act:
            next(encoder.encode('id: abc\n'));
            next(encoder.encode('data: def\n'));
            
            // assert:
            expect(lineNum).toBe(2);
        });

        it('single line split across multiple arrays', () => {
            // arrange:
            let lineNum = 0;
            const next = parse.getLines((line, fieldLength) => {
                ++lineNum;
                expect(decoder.decode(line)).toEqual('id: abc');
                expect(fieldLength).toEqual(2);
            });

            // act:
            next(encoder.encode('id: a'));
            next(encoder.encode('bc\n'));
            
            // assert:
            expect(lineNum).toBe(1);
        });

        it('multiple lines split across multiple arrays', () => {
            // arrange:
            let lineNum = 0;
            const next = parse.getLines((line, fieldLength) => {
                ++lineNum;
                expect(decoder.decode(line)).toEqual(lineNum === 1 ? 'id: abc' : 'data: def');
                expect(fieldLength).toEqual(lineNum === 1 ? 2 : 4);
            });
            
            // act:
            next(encoder.encode('id: ab'));
            next(encoder.encode('c\nda'));
            next(encoder.encode('ta: def\n'));
            
            // assert:
            expect(lineNum).toBe(2);
        });

        it('new line', () => {
            // arrange:
            let lineNum = 0;
            const next = parse.getLines((line, fieldLength) => {
                ++lineNum;
                expect(decoder.decode(line)).toEqual('');
                expect(fieldLength).toEqual(-1);
            });

            // act:
            next(encoder.encode('\n'));
            
            // assert:
            expect(lineNum).toBe(1);
        });

        it('comment line', () => {
            // arrange:
            let lineNum = 0;
            const next = parse.getLines((line, fieldLength) => {
                ++lineNum;
                expect(decoder.decode(line)).toEqual(': this is a comment');
                expect(fieldLength).toEqual(0);
            });

            // act:
            next(encoder.encode(': this is a comment\n'));
            
            // assert:
            expect(lineNum).toBe(1);
        });

        it('line with no field', () => {
            // arrange:
            let lineNum = 0;
            const next = parse.getLines((line, fieldLength) => {
                ++lineNum;
                expect(decoder.decode(line)).toEqual('this is an invalid line');
                expect(fieldLength).toEqual(-1);
            });

            // act:
            next(encoder.encode('this is an invalid line\n'));
            
            // assert:
            expect(lineNum).toBe(1);
        });

        it('line with multiple colons', () => {
            // arrange:
            let lineNum = 0;
            const next = parse.getLines((line, fieldLength) => {
                ++lineNum;
                expect(decoder.decode(line)).toEqual('id: abc: def');
                expect(fieldLength).toEqual(2);
            });

            // act:
            next(encoder.encode('id: abc: def\n'));
            
            // assert:
            expect(lineNum).toBe(1);
        });

        it('single byte array with multiple lines separated by \\n', () => {
            // arrange:
            let lineNum = 0;
            const next = parse.getLines((line, fieldLength) => {
                ++lineNum;
                expect(decoder.decode(line)).toEqual(lineNum === 1 ? 'id: abc' : 'data: def');
                expect(fieldLength).toEqual(lineNum === 1 ? 2 : 4);
            });

            // act:
            next(encoder.encode('id: abc\ndata: def\n'));
            
            // assert:
            expect(lineNum).toBe(2);
        });

        it('single byte array with multiple lines separated by \\r', () => {
            // arrange:
            let lineNum = 0;
            const next = parse.getLines((line, fieldLength) => {
                ++lineNum;
                expect(decoder.decode(line)).toEqual(lineNum === 1 ? 'id: abc' : 'data: def');
                expect(fieldLength).toEqual(lineNum === 1 ? 2 : 4);
            });

            // act:
            next(encoder.encode('id: abc\rdata: def\r'));
            
            // assert:
            expect(lineNum).toBe(2);
        });

        it('single byte array with multiple lines separated by \\r\\n', () => {
            // arrange:
            let lineNum = 0;
            const next = parse.getLines((line, fieldLength) => {
                ++lineNum;
                expect(decoder.decode(line)).toEqual(lineNum === 1 ? 'id: abc' : 'data: def');
                expect(fieldLength).toEqual(lineNum === 1 ? 2 : 4);
            });

            // act:
            next(encoder.encode('id: abc\r\ndata: def\r\n'));
            
            // assert:
            expect(lineNum).toBe(2);
        });
    });

    describe('getMessages', () => {
        it('happy path', () => {
            // arrange:
            let msgNum = 0;
            const next = parse.getMessages(id => {
                expect(id).toEqual('abc');
            }, retry => {
                expect(retry).toEqual(42);
            }, msg => {
                ++msgNum;
                expect(msg).toEqual({
                    retry: 42,
                    id: 'abc',
                    event: 'def',
                    data: 'ghi'
                });
            });

            // act:
            next(encoder.encode('retry: 42'), 5);
            next(encoder.encode('id: abc'), 2);
            next(encoder.encode('event:def'), 5);
            next(encoder.encode('data:ghi'), 4);
            next(encoder.encode(''), -1);

            // assert:
            expect(msgNum).toBe(1);
        });

        it('skip unknown fields', () => {
            let msgNum = 0;
            const next = parse.getMessages(id => {
                expect(id).toEqual('abc');
            }, _retry => {
                fail('retry should not be called');
            }, _msg => {
                ++msgNum;
            });

            // act:
            next(encoder.encode('id: abc'), 2);
            next(encoder.encode('foo: null'), 3);
            next(encoder.encode(''), -1);

            // assert:
            // the block has no data field, so per spec it is not dispatched;
            // the id still applies for reconnection:
            expect(msgNum).toBe(0);
        });
        
        it('ignore non-integer retry', () => {
            let msgNum = 0;
            const next = parse.getMessages(_id => {
                fail('id should not be called');
            }, _retry => {
                fail('retry should not be called');
            }, _msg => {
                ++msgNum;
            });

            // act:
            next(encoder.encode('retry: def'), 5);
            next(encoder.encode(''), -1);

            // assert:
            // the block has no data field, so per spec it is not dispatched:
            expect(msgNum).toBe(0);
        });

        it('skip comment-only messages', () => {
            // arrange:
            let msgNum = 0;
            const next = parse.getMessages(id => {
                expect(id).toEqual('123');
            }, _retry => {
                fail('retry should not be called');
            }, _msg => {
                ++msgNum;
            });

            // act:
            next(encoder.encode('id:123'), 2);
            next(encoder.encode(':'), 0);
            next(encoder.encode(':    '), 0);
            next(encoder.encode('event: foo '), 5);
            next(encoder.encode(''), -1);

            // assert:
            // the block has no data field, so per spec it is not dispatched:
            expect(msgNum).toBe(0);
        });

        it('should append data split across multiple lines', () => {
            // arrange:
            let msgNum = 0;
            const next = parse.getMessages(_id => {
                fail('id should not be called');
            }, _retry => {
                fail('retry should not be called');
            }, msg => {
                ++msgNum;
                expect(msg).toEqual({
                    data: 'YHOO\n+2\n\n10',
                    id: '',
                    event: '',
                    retry: undefined,
                });
            });

            // act:
            next(encoder.encode('data:YHOO'), 4);
            next(encoder.encode('data: +2'), 4);
            next(encoder.encode('data'), 4);
            next(encoder.encode('data: 10'), 4);
            next(encoder.encode(''), -1);

            // assert:
            expect(msgNum).toBe(1);
        });

        it('should reset id if sent multiple times', () => {
            // arrange:
            const expectedIds = ['foo', ''];
            let idsIdx = 0;
            let msgNum = 0;
            const next = parse.getMessages(id => {
                expect(id).toEqual(expectedIds[idsIdx]);
                ++idsIdx;
            }, _retry => {
                fail('retry should not be called');
            }, _msg => {
                ++msgNum;
            });

            // act:
            next(encoder.encode('id: foo'), 2);
            next(encoder.encode('id'), 2);
            next(encoder.encode(''), -1);

            // assert:
            expect(idsIdx).toBe(2);
            // the block has no data field, so per spec it is not dispatched;
            // the id reset still happened through the callbacks above:
            expect(msgNum).toBe(0);
        });

        it('should preserve newlines from empty data fields', () => {
            // arrange:
            let msgNum = 0;
            const next = parse.getMessages(_id => {
                fail('id should not be called');
            }, _retry => {
                fail('retry should not be called');
            }, msg => {
                ++msgNum;
                expect(msg).toEqual({
                    data: '\n\nfoo',
                    id: '',
                    event: 'message',
                    retry: undefined,
                });
            });

            // act:
            next(encoder.encode('event: message'), 5);
            next(encoder.encode('data:'), 4);
            next(encoder.encode('data:'), 4);
            next(encoder.encode('data: foo'), 4);
            next(encoder.encode(''), -1);

            // assert:
            expect(msgNum).toBe(1);
        });

        it('ignores retry values that are not only ASCII digits, per spec', () => {
            // arrange:
            const retries: number[] = [];
            let msgNum = 0;
            const next = parse.getMessages(_id => {
                fail('id should not be called');
            }, retry => {
                retries.push(retry);
            }, _msg => {
                ++msgNum;
            });

            // act:
            next(encoder.encode('retry: 42abc'), 5);
            next(encoder.encode('retry:  42'), 5);
            next(encoder.encode('retry: -5'), 5);
            next(encoder.encode(''), -1);

            // assert:
            // invalid values are ignored:
            expect(retries).toEqual([]);
            // the block has no data field, so per spec it is not dispatched:
            expect(msgNum).toBe(0);
        });

        it('does not dispatch a message without a data field, per spec', () => {
            // arrange:
            let msgNum = 0;
            const next = parse.getMessages(_id => {
                fail('id should not be called');
            }, _retry => {
                fail('retry should not be called');
            }, msg => {
                ++msgNum;
                // the suppressed earlier block cleared the event-type buffer,
                // so the dispatched message carries an empty event type:
                expect(msg).toEqual({
                    data: 'hi',
                    id: '',
                    event: '',
                    retry: undefined,
                });
            });

            // act:
            next(encoder.encode('event: ping'), 5);
            next(encoder.encode(''), -1); // data buffer empty: cleared, not dispatched
            next(encoder.encode('data: hi'), 4);
            next(encoder.encode(''), -1); // dispatched, with a cleared event type

            // assert:
            expect(msgNum).toBe(1);
        });

        it('treats a colon-less line as a field with an empty value, per spec', () => {
            // arrange:
            let msgNum = 0;
            const next = parse.getMessages(_id => {
                fail('id should not be called');
            }, _retry => {
                fail('retry should not be called');
            }, msg => {
                ++msgNum;
                expect(msg).toEqual({
                    data: '\nhi',
                    id: '',
                    event: '',
                    retry: undefined,
                });
            });

            // act:
            next(encoder.encode('data'), -1); // field name 'data', empty value
            next(encoder.encode('data: hi'), 4);
            next(encoder.encode(''), -1);

            // assert:
            expect(msgNum).toBe(1);
        });

        it('ignores id field values containing U+0000, per spec', () => {
            // arrange:
            const ids: string[] = [];
            const next = parse.getMessages(id => {
                ids.push(id);
            }, _retry => {
                fail('retry should not be called');
            }, _msg => {
                fail('message should not be dispatched'); // no data field
            });

            // act:
            next(encoder.encode('id: \u0000bad'), 2);
            next(encoder.encode('id: good'), 2);
            next(encoder.encode(''), -1);

            // assert:
            expect(ids).toEqual(['good']);
        });

        it('strips a leading UTF-8 byte order mark, per spec', async () => {
            // the stripping is done by the spec-mandated BOM removal of a
            // default TextDecoder in getLines, not by getBytes explicitly —
            // this test pins the end-to-end behavior:
            const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
            const content = encoder.encode('data: with-bom\n\n');
            const payload = new Uint8Array(bom.length + content.length);
            payload.set(bom);
            payload.set(content, bom.length);
            const response = new Response(payload);
            const data: string[] = [];
            const next = parse.getLines(parse.getMessages(_id => {
                fail('id should not be called');
            }, _retry => {
                fail('retry should not be called');
            }, msg => {
                data.push(msg.data);
            }));

            // act:
            await parse.getBytes(response, next);

            // assert:
            expect(data).toEqual(['with-bom']);
        });

        it('strips a UTF-8 byte order mark even when it is split across chunks, per spec', async () => {
            // arrange: feed the three BOM bytes through two separate chunks; a
            // streaming decoder must still recognize and drop the composite:
            const payload = encoder.encode('data: split-bom\n\n');
            const chunk2 = new Uint8Array(2 + payload.length);
            chunk2[0] = 0xbb;
            chunk2[1] = 0xbf;
            chunk2.set(payload, 2);
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array([0xef]));
                    controller.enqueue(chunk2);
                    controller.close();
                },
            });
            const response = new Response(stream);
            const data: string[] = [];
            const next = parse.getLines(parse.getMessages(_id => {
                fail('id should not be called');
            }, _retry => {
                fail('retry should not be called');
            }, msg => {
                data.push(msg.data);
            }));

            // act:
            await parse.getBytes(response, next);

            // assert:
            expect(data).toEqual(['split-bom']);
        });
    });
});
