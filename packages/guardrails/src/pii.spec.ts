import { detectPii, ibanValid, luhnValid, redactPii } from './pii';

describe('checksums', () => {
  it('Luhn accepts real card numbers and rejects look-alikes', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('5500005555555559')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('1234567890123456')).toBe(false);
  });

  it('IBAN mod-97 accepts valid numbers and rejects altered ones', () => {
    expect(ibanValid('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(ibanValid('GB82WEST12345698765432')).toBe(true);
    expect(ibanValid('DE89 3704 0044 0532 0130 01')).toBe(false);
    expect(ibanValid('DE12')).toBe(false);
  });
});

describe('redactPii', () => {
  it.each([
    ['an IBAN', 'Pay to DE89 3704 0044 0532 0130 00 today.', 'Pay to [REDACTED:IBAN] today.'],
    [
      'a card number',
      'Card 4111 1111 1111 1111 expires soon.',
      'Card [REDACTED:CARD] expires soon.',
    ],
    ['an email', 'Write to anna.schmidt@example.de now.', 'Write to [REDACTED:EMAIL] now.'],
    ['an international phone', 'Call +49 30 12345678 please.', 'Call [REDACTED:PHONE] please.'],
    ['a national phone', 'Call 030 1234567 please.', 'Call [REDACTED:PHONE] please.'],
  ])('redacts %s', (_label, input, expected) => {
    expect(redactPii(input).text).toBe(expected);
  });

  it.each([
    ['an AWS access key', 'key AKIAIOSFODNN7EXAMPLE here'],
    ['a GitHub token', `token ghp_${'a1B2c3D4e5'.repeat(4)} here`],
    ['an API secret key', 'use sk-abcdefghijklmnopqrstuvwx now'],
    [
      'a JSON Web Token',
      'jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r now',
    ],
    ['a private key header', 'x -----BEGIN RSA PRIVATE KEY----- y'],
    ['a labelled password', 'password = hunter2hunter2'],
    ['an API key assignment', 'api_key: "abcd1234efgh5678"'],
  ])('redacts %s as a secret', (_label, input) => {
    const result = redactPii(input);
    expect(result.findings).toEqual([{ type: 'secret', count: 1 }]);
    expect(result.text).toContain('[REDACTED:SECRET]');
  });

  it('leaves ordinary numbers and text alone (no false positives)', () => {
    for (const text of [
      'Version 1.2.3 shipped on 2024-10-31.',
      'Ticket 12345 and order 98765432 are open.',
      'The meeting is at 14:30 in room 4.12.',
      'Refunds take 5 working days.',
      'Card 4111 1111 1111 1112 fails the checksum.', // one digit off: not a real card
      'Reference DE12 3456 7890 1234 is not an IBAN.', // fails mod-97
      'Contact: support at example dot com.',
      'The limit is 1.000.000 euros.',
    ]) {
      expect(redactPii(text)).toEqual({ text, findings: [] });
    }
  });

  it('does not report an IBAN or card as a phone number as well', () => {
    const result = redactPii('IBAN DE89 3704 0044 0532 0130 00 and card 4111 1111 1111 1111.');
    expect(result.findings).toEqual([
      { type: 'iban', count: 1 },
      { type: 'card', count: 1 },
    ]);
  });

  it('counts several matches of the same kind', () => {
    const result = redactPii('a@example.com, b@example.com and c@example.org');
    expect(result.findings).toEqual([{ type: 'email', count: 3 }]);
    expect(result.text).toBe('[REDACTED:EMAIL], [REDACTED:EMAIL] and [REDACTED:EMAIL]');
  });

  it('can be limited to chosen kinds', () => {
    const text = 'mail a@example.com and card 4111 1111 1111 1111';
    expect(redactPii(text, ['card']).text).toBe('mail a@example.com and card [REDACTED:CARD]');
    expect(redactPii(text, []).text).toBe(text);
  });

  it('is idempotent', () => {
    const once = redactPii('mail a@example.com iban DE89 3704 0044 0532 0130 00').text;
    expect(redactPii(once).text).toBe(once);
  });

  it('never puts the matched value in the findings', () => {
    const result = redactPii('mail anna.schmidt@example.de key AKIAIOSFODNN7EXAMPLE');
    const report = JSON.stringify(result.findings);
    expect(report).not.toContain('anna');
    expect(report).not.toContain('AKIA');
  });

  it('handles empty and very long input', () => {
    expect(redactPii('')).toEqual({ text: '', findings: [] });
    const long = `${'word '.repeat(20_000)}a@example.com`;
    expect(redactPii(long).findings).toEqual([{ type: 'email', count: 1 }]);
  });
});

describe('detectPii', () => {
  it('reports kinds and counts only', () => {
    expect(detectPii('a@example.com and DE89 3704 0044 0532 0130 00')).toEqual([
      { type: 'iban', count: 1 },
      { type: 'email', count: 1 },
    ]);
  });
});
