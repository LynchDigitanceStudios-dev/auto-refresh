# Auto Refresh

A free Chrome extension that keeps your tabs refreshing on a schedule, with a landing site, optional account sync, and an AI assistant that sets it up from a plain sentence.

**Live site and download:** https://autorefresh.lynchdigitancestudios.workers.dev

Built by [Lynch Digitance Studios](https://www.lynchdigitancestudios.workers.dev/).

## What the extension does
- Refreshes any tab on an interval you pick, with a live countdown on the toolbar icon.
- Random intervals (for example 250 to 300 seconds) so reloads never land on a fixed beat.
- Up to 7 time windows a day, in a fixed US time zone, so it only runs when you want it to.
- **Needs-a-human alerts:** detects a captcha or block page, pauses so a captcha you are solving is not reset, alerts you on desktop and in your own Telegram bot, and carries on by itself once the page is fine.
- Optional "act human on the page": curved mouse movement, small scrolls and clicks on empty space between refreshes.
- Optional account to sync settings across computers (the Telegram bot connection syncs encrypted).
- **Lynch AI:** type "refresh 9am to 5pm every 2 minutes" and it changes the settings for you.
- Tells you when a new version is out. Everything else stays in your browser.

## What is in this repository
| Folder | What it is |
|---|---|
| `extension/` | The Chrome extension (Manifest V3): background worker, popup, scheduling, alerts, sync |
| `site-source.html`, `styles.css`, `app.js`, `build.py` | The landing page; `build.py` builds `dist/` and the download zip |
| `dist/` | The built site that gets deployed |
| `accounts-worker/` | Cloudflare Worker + D1 database: optional accounts, settings sync, anonymous install count, owner dashboard |
| `ai-worker/` | Cloudflare Worker for the Lynch AI chat (Workers AI) |
| `redirect-worker/` | Sends an old address to the current site |

## Build and deploy
```
python build.py          # builds dist/ and dist/lynch-digitance-auto-refresh.zip
npx wrangler deploy      # deploys the site (run in the project root)
```
Each worker is deployed with `npx wrangler deploy` inside its own folder. Secrets (admin key, password pepper, mail sender) are Cloudflare Worker secrets and are never stored in this repository.

## Install the extension
Download the zip from the live site, unzip it, open `chrome://extensions`, turn on Developer mode, press **Load unpacked** and choose the folder that contains `manifest.json`.

## Privacy
Nothing about the pages you refresh is ever sent anywhere. Once a day the extension can check for a new version and send an anonymous install count (a random ID and the version number); both can be switched off in the popup. See the site for the full wording.
