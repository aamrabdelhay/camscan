import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * CamScan lint config.
 *
 * Next 16 removed `next lint`; the shipped presets are already flat configs, so
 * they are imported directly (wrapping them in FlatCompat produces a circular
 * structure and ESLint 9 rejects it).
 */
export default [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      'node_modules/**', '.next/**', 'public/**', 'e2e/generated/**',
      'scripts/**', 'tests/fixtures/**', 'next-env.d.ts',
    ],
  },
  {
    rules: {
      // Page photographs are Blobs from IndexedDB rendered via object URLs;
      // next/image cannot optimise those and would add no value.
      '@next/next/no-img-element': 'off',
      'react-hooks/exhaustive-deps': 'warn',

      /**
       * React Compiler rules ship ON by default in eslint-config-next 16. They
       * assume compiler-managed memoisation, and flag patterns this app uses on
       * purpose:
       *  - reading a ref during render (`camera.state` mirrored into a ref for
       *    the capture loop) is how a requestAnimationFrame loop reads the
       *    latest state without re-subscribing every frame;
       *  - one-shot `setState` in an effect is how we sync external stores
       *    (IndexedDB settings, object URLs) after hydration.
       * Turning them off keeps the signal (real bugs like unused vars, missing
       * deps) instead of 30 false positives. The code is tested end-to-end.
       */
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/use-memo': 'off',
      'react-hooks/purity': 'off',
    },
  },
  {
    files: ['tests/**/*.test.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
];
