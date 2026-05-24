/// <reference types="vite/client" />

declare module '*.wasm?url' {
  const src: string
  export default src
}

declare module '*.md?raw' {
  const content: string
  export default content
}

/**
 * occt-import-js ships no bundled .d.ts; the factory is cast to a typed wrapper at call-site
 * (see stepOcct.ts). This declaration suppresses TS7016 while keeping the import non-`any`.
 */
declare module 'occt-import-js' {
  function occtFactory(opts?: { locateFile?: (path: string, dir: string) => string }): Promise<unknown>
  export default occtFactory
}
