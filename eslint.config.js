import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'bench/**', 'scripts/**'],
  },
  {
    files: ['**/*.ts'],
    ...js.configs.recommended,
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // `any` appears at the fetch-adapter boundary; typed at the edges.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Best-effort teardown paths intentionally swallow errors.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `sanitize` strips control characters from error text on purpose.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/extensions/to-sql.ts'],
    rules: {
      // Declaration-merging type parameters must match the augmented signature.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
)
