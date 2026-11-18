# Auto Refresh

A free Chrome extension that keeps your tabs refreshing on a schedule, with a landing site, optional account sync, and an AI assistant that sets it up from a plain sentence.

**Live site and download:** https://autorefresh.lynchdigitancestudios.workers.dev

Built by [Lynch Digitance Studios](https://www.lynchdigitancestudios.workers.dev/).

## What the extension does
- Refreshes any tab on an interval you pick, with a live countdown on the toolbar icon and in the corner of the page. Every reload skips the cache and each wait varies by about 10%.
- Random intervals (for example 250 to 300 seconds) so reloads never land on a fixed beat.
- Seven time windows a day by default (they cover the whole day with short breaks), in a fixed US time zone. Change them or switch hours off.
- **Needs-a-human alerts:** detects a captcha or block page, pauses so a captcha you are solving is not reset, alerts you on desktop and in your own Telegram bot, and carries on by itself once the page is fine.
- Acts human on the page between refreshes: curved mouse movement, small scrolls and clicks on empty space.
- **Stays alive:** tabs come back by themselves after a crash, a reboot or a browser restart; a failed reload never ends a tab; a stalled tab is restarted and reported.
- **Advanced settings page:** a dashboard with a side menu for everything beyond the interval; the popup stays short.
- Optional account to sync settings across computers (the Telegram bot connection syncs encrypted).
- **Lynch AI:** type "refresh 9am to 5pm every 2 minutes" and it changes the settings for you.
- Reviews inside the extension and on the website. Tells you when a new version is out.

## What is in this repository
| Folder | What it is |
|---|---|
| `extension/` | The Chrome extension (Manifest V3): background worker, popup, scheduling, alerts, sync |
| `site-source.html`, `styles.css`, `app.js`, `build.py` | The landing page; `build.py` builds `dist/` and the download zip |
| `dist/` | The built site that gets deployed |
| `accounts-worker/` | Cloudflare Worker + D1 database: optional accounts, settings sync, install report, reviews, owner dashboard |
| `ai-worker/` | Cloudflare Worker for the Lynch AI chat (Workers AI) |
| `redirect-worker/` | Sends an old address to the current site |

## Build and deploy
```
python build.py          # builds dist/ and dist/lynch-digitance-auto-refresh.zip
npx wrangler deploy      # deploys the site (run in the project root)
```
Everything deploys automatically from `main` through Cloudflare: the site and each worker (`accounts-worker/`, `ai-worker/`, `redirect-worker/`) has its own build, so every push goes live. Secrets (admin key, password pepper, mail sender) are Cloudflare Worker secrets and are never stored in this repository.

## Install the extension
Download the zip from the live site, unzip it, open `chrome://extensions`, turn on Developer mode, press **Load unpacked** and choose the folder that contains `manifest.json`.

## Privacy
Nothing about the pages you refresh is ever sent anywhere. The page address and settings of each tab you start are kept on your own computer only, so the tab can come back after a restart. Once a day the extension reports to our server that the copy exists: a random install ID and the version number, plus the account it belongs to when you are logged in. That report has no switch. The same daily visit looks for a new version (a switch turns that alert off). See the site for the full wording.

## License
All rights reserved. The code is public so you can see how it is built, but it is not open source: please do not copy or reuse it without written permission. See [LICENSE](LICENSE). The extension itself is free to install and use.
