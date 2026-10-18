import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: false,
    printWidth: 100,
    ignorePatterns: ['apps/mobile/ios/**', 'apps/mobile/android/**', '**/expo-env.d.ts'],
  },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    ignorePatterns: ['apps/mobile/ios/**', 'apps/mobile/android/**'],
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
})
