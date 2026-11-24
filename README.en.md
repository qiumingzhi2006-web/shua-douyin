# shua-douyin (刷抖音)

A DSH bundle that reads Douyin's For-You feed (the `/jingxuan` page) in a local Edge window, picks one video it has not seen, writes a one-line reaction, and records the result locally and in the conversation. Likes, collections and comments are all off by default and only run when configured.

It does **not** edit profile fields, publish videos, follow accounts or send direct messages. Frequency limits (active hours, daily cap, minimum gap) are on by default and every skip states its reason.

## Tools

| Tool | What it does |
|---|---|
| `dy_login` | Opens a login window for QR scanning, waits up to 8 minutes, closes it once login is detected and stores the session |
| `dy_status` | Login state, videos watched today, time of the last round (briefly opens an off-screen browser to read cookies) |
| `dy_run` | One round: read the feed, pick an unseen video, write a reaction, (optionally) like / collect / comment, record it |
| `dy_report` | Local files only: today's count, the most recent rounds and how much interaction quota is left |
| `dy_probe` | Diagnostics: lists the page's `data-e2e` attributes and which interaction selectors hit — use it when buttons are not found |
| `dy_config` | Read or write the configuration (hours, cap, gap, interaction switches and quotas, @handle, model key) |

## Install

```sh
dsh plugin add https://github.com/<owner>/shua-douyin
```

## First run

1. `dy_login` — the window opens at the top-left of your screen; scan the QR code with **your own** secondary account.
2. `dy_status` — it should report a valid session.
3. `dy_run` — run the first round.

## Configuration

Stored at `~/.dsh/shua-douyin/config.json`. Defaults:

| Key | Default | Meaning |
|---|---|---|
| `windowStart` / `windowEnd` | 9 / 22 | Only run within these hours |
| `maxPerDay` | 6 | Maximum rounds per day; `-1` means no limit |
| `minGapMin` | 45 | Minimum minutes between rounds |
| `feedUrl` | `https://www.douyin.com/jingxuan` | Page to read |
| `browserChannel` | `msedge` | Browser to use (`msedge` / `chrome`, must be installed) |
| `interact.like` / `.collect` / `.comment` | all `false` | Whether to like / collect / comment |
| `quota.like` / `.collect` / `.comment` | 6 / 4 / 3 | Daily quota per interaction type; once exhausted that action is skipped until the next day; `-1` means no limit |
| `commentText` | `{feel} {at}` | Comment template: `{feel}` becomes the round's reaction, `{at}` becomes `atHandle` |
| `atHandle` | empty | Account to @ in the comment (Douyin nickname or ID, with or without a leading `@`); empty means no mention |
| `mentionWaitMs` | 1500 | How long to wait for the @ suggestion list after typing the handle |
| `model.apiKey` | empty | When empty, built-in short lines are used and no model is called |

## Data

Everything lives under `~/.dsh/shua-douyin/`: `profile/` (browser session including Douyin cookies), `state.json`, `journal.jsonl`, `config.json`, `run.log`.

## Known limits

- Scraping depends on the current page structure (`div[class*="video"]`); a redesign breaks it.
- Login is a human QR scan. A captcha interstitial is reported as an error; nothing tries to bypass it.
- Feed reading only — no search, no DMs, no publishing.
- The @ mention depends on the comment box's suggestion list; when nothing matches, the handle stays as plain text and the result states that instead of claiming success.
- You use your own Douyin account; platform rules and risk control are on you. With a fresh account, keep the daily cap at 1-2.

## License

MIT
