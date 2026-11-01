import { isAllowedKey, isSafeValue, pseudonym, safeAttributes, setPseudonymSalt } from './sanitize';

describe('what telemetry may carry', () => {
  describe('values', () => {
    it.each([
      'mock-grounded',
      'answered',
      'cache_hit',
      'POST',
      '/v1/runs/:id',
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      'c1|c2',
    ])('accepts the identifier-like %s', (value) => expect(isSafeValue(value)).toBe(true));

    it.each([
      ['a question', 'How long do refunds take?'],
      ['an answer', 'Refunds take five working days.'],
      ['a document line', 'IBAN DE89 3704 0044 0532 0130 00'],
      ['an email address', 'alice@acme-bank.example'],
      ['a long opaque string', 'x'.repeat(65)],
      ['a JWT', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl'],
      ['an empty string', ''],
      ['a string with a newline', 'a\nb'],
    ])('rejects %s', (_label, value) => expect(isSafeValue(value)).toBe(false));

    it('accepts numbers and booleans, rejects NaN, objects and nested arrays', () => {
      expect(isSafeValue(12.5)).toBe(true);
      expect(isSafeValue(true)).toBe(true);
      expect(isSafeValue(Number.NaN)).toBe(false);
      expect(isSafeValue({ a: 1 })).toBe(false);
      expect(isSafeValue([['a']])).toBe(false);
      expect(isSafeValue(['a', 'b'])).toBe(true);
      expect(isSafeValue(Array.from({ length: 17 }, () => 'a'))).toBe(false);
    });
  });

  describe('keys', () => {
    it('allows a few known keys and anything under genai.', () => {
      for (const key of ['http.route', 'error.type', 'genai.llm.provider', 'genai.anything']) {
        expect(isAllowedKey(key)).toBe(true);
      }
    });

    it.each([
      'question',
      'answer',
      'prompt',
      'authorization',
      'url.full',
      'http.request.header.cookie',
      'db.statement',
      'user.email',
    ])('refuses %s', (key) => expect(isAllowedKey(key)).toBe(false));
  });

  it('keeps only what passes, dropping the rest without complaint', () => {
    expect(
      safeAttributes({
        'genai.outcome': 'answered',
        'genai.sources.count': 3,
        question: 'How long do refunds take?',
        'genai.question': 'How long do refunds take?',
        'http.route': '/v1/ask',
        'genai.token': 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl',
      }),
    ).toEqual({ 'genai.outcome': 'answered', 'genai.sources.count': 3, 'http.route': '/v1/ask' });
    expect(safeAttributes(undefined)).toEqual({});
  });
});

describe('pseudonym', () => {
  afterEach(() => setPseudonymSalt(undefined));

  it('is the same for the same id and salt, short, and not the id', () => {
    setPseudonymSalt('salt-1');

    expect(pseudonym('acme-bank')).toBe(pseudonym('acme-bank'));
    expect(pseudonym('acme-bank')).toMatch(/^[0-9a-f]{12}$/);
    expect(pseudonym('acme-bank')).not.toBe(pseudonym('globex'));
    expect(pseudonym('acme-bank')).not.toContain('acme');
  });

  it('differs between deployments, so a label from one cannot be matched against another', () => {
    setPseudonymSalt('salt-1');
    const first = pseudonym('acme-bank');
    setPseudonymSalt('salt-2');

    expect(pseudonym('acme-bank')).not.toBe(first);
  });

  it('is accepted as a value, so it can be put on a span or a metric', () => {
    expect(isSafeValue(pseudonym('acme-bank'))).toBe(true);
  });
});
