# Grok Bot reproduction (manual; not integrated)

I found no programmatic Grok Bot API, so the pipeline's Reproducer is a **local Playwright stand-in**
(`src/reproducer.js`). It runs the same step plan you would ask Grok Bot to run. Nothing in this
repo claims to call Grok Bot.

## 1. Make the demo app reachable from Grok Bot's cloud browser
Grok Bot cannot open `localhost`. `cloudflared` and `ngrok` are both installed on this Mac. Run one of these yourself:

```
cloudflared tunnel --url http://localhost:4000      # prints https://<random>.trycloudflare.com
# or
ngrok http 4000
```

## 2. Paste this into Grok Bot (replace URL)

```
You are a QA tester. Open https://<YOUR-TUNNEL>/?seed=alpha,beta in your browser.
Do these three checks and report each as REPRODUCED or NOT REPRODUCED, with a screenshot after each:
1. Export: click the "Export" button. Expected: a file notes.md downloads containing
   "# My notes", "- alpha", "- beta". Also report any JavaScript console error.
2. Add note: open https://<YOUR-TUNNEL>/ , type "hello" in "Write a note", click "Add".
   Expected: after 1 second the list shows exactly one note "hello" and the counter says "1 note".
3. Search: open https://<YOUR-TUNNEL>/?seed=Buy Milk,Call mom , type "milk" in "Search notes".
   Expected: exactly one note ("Buy Milk") is shown.
Do not log in, change settings, or type anything other than the text above.
Answer as JSON: {"export":{"reproduced":bool,"evidence":"..."},"add_note":{...},"search":{...}}
```

On the pristine app (`npm run reset`), all three should come back REPRODUCED. If Grok Bot gives JSON
in that shape, it can feed the Reproducer's `{reproduced, failures}` result directly. Wiring that up
needs a Grok Bot API, which I could not confirm exists.

## 3. Single-bug form (one complaint at a time)
```
Open https://<YOUR-TUNNEL>/. A user reported: "<complaint text>".
Try to reproduce it in at most 6 actions. Take a screenshot showing the bug or its absence.
Reply REPRODUCED or NOT REPRODUCED, followed by the exact steps you took.
```
