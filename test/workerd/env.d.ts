declare module 'cloudflare:workers' {
  interface ProvidedEnv {
    TEST_DO: DurableObjectNamespace<import('./worker.js').TestDO>;
  }
}
