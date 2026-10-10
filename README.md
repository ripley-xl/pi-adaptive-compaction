# pi-adaptive-compaction

Pi extension that scales context compaction to the active model's context window. Pi's built-in compaction budgets are fixed sizes; a model with a 32K window and a model with a 1M window need very different trigger lines and retained tails. This extension computes both from `model.contextWindow` at runtime.

## Install

```bash
pi install git:github.com/ripley-xl/pi-adaptive-compaction
```

Once published to npm, equivalently:

```bash
pi install npm:pi-adaptive-compaction
```

## Behavior

Two parameters are derived from the active model's context window:

```
reserveTokens    = max(16384, window × (window > 500K ? 40% : 10%))
keepRecentTokens = max(20000, window × 10%)
```

`reserveTokens` is the headroom reserved for post-compaction work. `keepRecentTokens` is how much recent history survives compaction verbatim.

Two handlers apply them:

1. **Adaptive trigger** (`agent_end`): starts compaction when context usage exceeds `window − reserveTokens`. The built-in threshold check stays enabled as a mid-run safety net, and overflow recovery is unaffected.
2. **Adaptive compaction** (`session_before_compact`): recomputes the cut point with the adaptive `keepRecentTokens` and regenerates the summary over the reduced span. Summary output is capped at 0.8 × `reserveTokens`. Applies to manual `/compact`, threshold, and overflow compactions alike. When the configured settings already retain at least as much, the handler defers to pi's default implementation.

No configuration; install and it applies to every model you switch to.

## License

MIT
