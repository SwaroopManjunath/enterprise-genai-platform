import { cosine, embed, mustMatch, normalize, words } from './question-features';

const sim = (a: string, b: string) => cosine(embed(a), embed(b));

describe('question features', () => {
  it('normalises case, punctuation, apostrophes and spacing', () => {
    expect(normalize('  How LONG do Refunds take??  ')).toBe('how long do refunds take');
    expect(words("Can't I block it?")).toEqual(['cant', 'i', 'block', 'it']);
  });

  it('embeds to unit length, and an empty question to a zero vector', () => {
    expect(
      cosine(embed('how long do refunds take'), embed('how long do refunds take')),
    ).toBeCloseTo(1);
    expect(embed('the a is').every((x) => x === 0)).toBe(true);
  });

  describe('similarity', () => {
    it.each([
      ['How long do refunds take?', 'how long does a refund take'],
      ['How long do refunds take?', 'How long will refunds be taking?'],
      ['Can I block a lost card?', 'can i block my lost card'],
      ['hotel limit for business travel', 'business travel hotel limit'],
    ])('treats the same question in other words as close: %s / %s', (a, b) => {
      expect(sim(a, b)).toBeGreaterThan(0.92);
    });

    it.each([
      ['How long do refunds take?', 'How long do chargebacks take?'],
      ['What is the limit for managers?', 'What is the limit for analysts?'],
      ['How do I block a lost card?', 'How do I order a new card?'],
      ['How long do refunds take?', 'What is the hotel limit for business travel?'],
    ])('keeps different questions apart: %s / %s', (a, b) => {
      expect(sim(a, b)).toBeLessThan(0.92);
    });
  });

  describe('what must match exactly', () => {
    it('ignores everything but numbers, identifiers and meaning-flipping words', () => {
      expect(mustMatch('How long do refunds take?')).toBe('');
      expect(mustMatch('Is the limit 150 euros?')).toBe('150');
      expect(mustMatch('Show customer C-7 and ticket T-101')).toBe('c-7|t-101');
      expect(mustMatch("Can't I not block it?")).toBe('cant|not');
    });

    it.each([
      ['Is the hotel limit 150 euros per night?', 'Is the hotel limit 200 euros per night?'],
      ['Can I block my lost card?', 'Can I not block my lost card?'],
      ['What happens before the card is blocked?', 'What happens after the card is blocked?'],
      ['Who can open an account?', 'Who can close an account?'],
      ['Look up customer C-7', 'Look up customer C-8'],
      ['Which limit is the maximum?', 'Which limit is the minimum?'],
      ['Kann ich die Karte sperren?', 'Kann ich die Karte nicht sperren?'],
    ])('tells a pair that is one word apart but not the same question: %s / %s', (a, b) => {
      expect(mustMatch(a)).not.toBe(mustMatch(b));
    });

    it('lets harmless rewording through', () => {
      expect(mustMatch('How long do refunds take?')).toBe(mustMatch('how long does a refund take'));
    });
  });
});
