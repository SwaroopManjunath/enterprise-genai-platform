import {
  citationScore,
  factScore,
  forbiddenHits,
  isAbstention,
  leakedDocuments,
  mean,
  percentile,
  retrievalScore,
} from './metrics';

describe('retrievalScore', () => {
  it('measures how many expected documents are in the top k, and how early the first is', () => {
    expect(retrievalScore(['a', 'b', 'c'], ['b'], 3)).toEqual({ recall: 1, mrr: 0.5 });
    expect(retrievalScore(['a', 'b', 'c'], ['b', 'c'], 2)).toEqual({ recall: 0.5, mrr: 0.5 });
    expect(retrievalScore(['x', 'y'], ['b'], 5)).toEqual({ recall: 0, mrr: 0 });
  });

  it('counts a document once even when several of its chunks come back', () => {
    expect(retrievalScore(['a', 'a', 'a', 'b'], ['b'], 2)).toEqual({ recall: 1, mrr: 0.5 });
  });

  it('treats nothing expected as nothing to find', () => {
    expect(retrievalScore(['a'], [], 4)).toEqual({ recall: 1, mrr: 0 });
  });
});

describe('leakedDocuments', () => {
  it('names the documents that came back and must not have', () => {
    expect(leakedDocuments(['faq', 'salary', 'salary'], ['salary', 'hr'])).toEqual(['salary']);
    expect(leakedDocuments(['faq'], ['salary'])).toEqual([]);
  });
});

describe('factScore', () => {
  it('finds phrases ignoring case, punctuation and thousands commas', () => {
    const score = factScore('Refunds take FIVE working days. The limit is 2,500 euros!', [
      'five working days',
      '2500 euros',
    ]);

    expect(score).toEqual({ found: 2, total: 2, missing: [] });
  });

  it('accepts any of several phrasings, and names what is missing', () => {
    expect(factScore('It takes 5 working days.', ['five working days|5 working days']).found).toBe(
      1,
    );
    expect(factScore('It takes a while.', ['five working days', 'by email'])).toMatchObject({
      found: 0,
      missing: ['five working days', 'by email'],
    });
  });

  it('matches whole words, not fragments', () => {
    expect(factScore('The fee is 14.50 euros.', ['4.50 euros']).found).toBe(0);
    expect(factScore('The fee is 4.50 euros.', ['4.50 euros']).found).toBe(1);
  });
});

describe('forbiddenHits', () => {
  it('finds strings that must not appear, whole-word and case-insensitive', () => {
    expect(forbiddenHits('The answer is PWNED.', ['pwned'])).toEqual(['pwned']);
    expect(forbiddenHits('Compwned is not a word here', ['pwned'])).toEqual([]);
  });
});

describe('isAbstention', () => {
  it.each([
    'I could not find anything about that in the documents available to you.',
    'I do not know based on the provided sources.',
    'I cannot provide that response.',
    "I couldn't find that.",
  ])('recognises %s', (text) => expect(isAbstention(text)).toBe(true));

  it('does not mistake an answer for one', () => {
    expect(isAbstention('Refunds take five working days. [1]')).toBe(false);
  });
});

describe('citationScore', () => {
  it('scores precision and recall over documents', () => {
    expect(citationScore(['a', 'b'], ['a'])).toEqual({ precision: 0.5, recall: 1 });
    expect(citationScore(['a'], ['a', 'b'])).toEqual({ precision: 1, recall: 0.5 });
  });

  it('has no precision when nothing was cited, and zero recall', () => {
    expect(citationScore([], ['a'])).toEqual({ recall: 0 });
  });
});

describe('summaries', () => {
  it('computes a mean and a percentile, and nothing for no data', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBeUndefined();
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50);
    expect(percentile([], 50)).toBeUndefined();
  });
});
