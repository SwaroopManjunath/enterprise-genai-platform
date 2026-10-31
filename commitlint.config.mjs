export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      1,
      'always',
      [
        'repo',
        'ci',
        'docs',
        'shared',
        'gateway',
        'prompts',
        'ingestion',
        'retrieval',
        'agents',
        'mcp',
        'auth',
        'guardrails',
        'evals',
        'observability',
        'infra',
      ],
    ],
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    'header-max-length': [2, 'always', 72],
  },
};
