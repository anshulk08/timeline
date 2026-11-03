# simpliGrok target (BDBI AutoMaintainer)

SimpliEarn + Cross-Examination (`/Users/anshul/grokathon/simpliGrok`), local branch `automaintainer-demo` only (created from `feature/cross-examination`).

Branch history on top of `feature/cross-examination`:
1. `493edc2` test harness (cherry-pick of simpli-earn `6401963`).
2. `1035169` **SEEDED DEMO BUGS** (cherry-pick of simpli-earn `aebe2d0`) — the same two intentionally injected bugs as `targets/simpliearn` (`qoq-endpoint-typo` AUTO, `stock-pct-base` PR). Not real regressions.

Extra guard vs. the simpliearn target: the `cross-examination` test suite must keep passing, and `RAG/cross_examination/**` / `RAG/.env*` are forbidden (AutoMaintainer may not edit the fact-checker). GrokBot verification points at the public `gt-big-data/simpli-earn` (base `18c545e`, seeded `aebe2d0`) because simpliGrok is private.

`reset.sh` hard-resets the branch to the seeded commit. Reference fixes: `reference/<id>.diff` (`git apply` from the repo root).
