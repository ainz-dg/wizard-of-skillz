# Agent-quality eval prompt source

The executable prompt lives in `src/agent-eval.mjs`.

Dimensions retained from writing-for-agents / skill-mechanics:
1. Context pointer / invocation
2. Information hierarchy
3. Completion criteria
4. Progressive disclosure / co-location
5. Pruning / single source of truth / environment cache avoidance

Leading words and no-op instructions remain **eval hypotheses** because the source itself treats no-op behavior as model-relative.
