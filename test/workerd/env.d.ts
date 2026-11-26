// workers-types v5 types `env` as `Cloudflare.Env` and merges project bindings
// into that interface. The older `ProvidedEnv` module augmentation is gone.
declare namespace Cloudflare {
  interface Env {
    TEST_DO: DurableObjectNamespace<import('./worker.js').TestDO>;
  }
}
