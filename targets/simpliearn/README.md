# SimpliEarn target (BDBI AutoMaintainer)

Real BDBI project: SimpliEarn (`/Users/anshul/grokathon/simpli-earn`), local branch `automaintainer-demo` only.

Branch history:
1. `6401963` test harness: `frontend/lib/api-routes.test.ts` (frontend fetch paths must exist as FastAPI routes) and `RAG/tests/test_stock_chart_pct.py` (get_stock_chart pct math, yfinance faked). Both pass on the real code.
2. `aebe2d0` **SEEDED DEMO BUGS** — two bugs injected on purpose for the demo; they are not real SimpliEarn regressions:
   - `qoq-endpoint-typo` (expected AUTO): QoQComparison posts to `/compre`.
   - `stock-pct-base` (expected PR): chart % change is computed against the buffer-day close instead of the event-day open. Trap: the obvious "first close on/after event day" fix crashes (tz compare) and breaks weekend events.

`reset.sh` hard-resets that branch to the seeded commit. Reference fixes: `reference/<id>.diff` (apply with `git apply` from the repo root).
