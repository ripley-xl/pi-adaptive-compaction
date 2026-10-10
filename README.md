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

## Design notes

**Why this exists.** pi's built-in compaction budgets are hardcoded constants — reserveTokens 16384, keepRecentTokens 20000 — sized around a ~200K window. On a 1M-window model the reserve is 1.6% of the window: compaction triggers at ~98.4% full, so long thinking rounds can overflow before the threshold check gets to run, and the summary has to be squeezed into a tiny budget. The retained tail is 2% of the window, so nearly all recent working context is summarized away. Fixed constants underserve large windows in both directions.

**The formula.** Above a 500K window, reserving 40% puts the trigger line at 60% full — compaction fires while there is still ample room for the summarization request itself. At or below 500K, a 10% reserve triggers at 90%, keeping small windows usable. Both floors equal pi's official defaults, so a small-window model never regresses below built-in behavior. keepRecentTokens at 10% carries the official default's proportion to a 200K window (20000 of 200K) upward, with the official 20000 as the floor. Retention grows by proportion rather than without bound on purpose: past a few hundred K of verbatim tail, context rot hurts more than the missing history would.

**Why two hooks.** "When to compact" and "what survives compaction" are separate decisions. The agent_end handler only moves the trigger line; the built-in threshold stays enabled as a mid-run safety net, and overflow recovery is untouched. The session_before_compact handler decides what survives — recomputing the cut point with the adaptive keepRecentTokens and capping the regenerated summary at 0.8 × reserveTokens. When the user's own configured settings already retain at least as much, the handler defers: explicit configuration wins over adaptation.

**Validation.** Verified against real sessions on two representative window sizes (Kimi k3 and k3-256k): compaction fired at the computed lines and the retained tails matched the formulas.

## License

MIT
