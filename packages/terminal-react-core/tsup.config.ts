import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  // Bundle all dependencies except react (peerDep)
  noExternal: [
    'auto-bind',
    'lodash-es',
    'chalk',
    'cli-boxes',
    'code-excerpt',
    'emoji-regex',
    'get-east-asian-width',
    'indent-string',
    'bidi-js',
    'semver',
    'signal-exit',
    'stack-utils',
    'strip-ansi',
    'supports-hyperlinks',
    'type-fest',
    'usehooks-ts',
    'wrap-ansi',
    '@alcalzone/ansi-tokenize',
  ],
})
