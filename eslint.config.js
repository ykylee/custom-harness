// 개발 표준 (docs/design/dev-standards.md §2) — eslint flat config
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // protocol 순수성 게이트 (test-strategy §1·§3): 와이어 스키마에 검증 외 변환 금지
    files: ['packages/protocol/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.property.name=/^(transform|catch|preprocess)$/]',
          message:
            '와이어 스키마 순수성 규칙 위반 — .transform()/.catch()/.preprocess() 금지 (protocol-design §2)',
        },
      ],
    },
  },
);
