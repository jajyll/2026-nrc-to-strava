# 2026-nrc-to-strava

Move your full Nike Run Club history to Strava, with maps, pace, heart rate and elevation, as Nike's login works in 2026.

Nike has no export button, and the older tools stopped working when Nike changed its login and its activity API. These two small scripts:

1. **`nike-download.js`** downloads every run from your Nike account and saves:
   - a GPX file for each run with GPS,
   - a full backup of Nike's raw data,
   - a summary spreadsheet.
2. **`strava-upload.js`** uploads them to Strava:
   - It skips runs that are already there, so it's safe to use with an existing Strava account.
   - It uploads GPS runs with their maps.
   - It adds runs without GPS (treadmill and early Nike+ sensor runs) as manual activities.
   - It lists runs that are on Strava *without* a map but have GPS in Nike, so you can replace them. This is common for runs that came in through Apple Health.

Both scripts need only [Node.js](https://nodejs.org/) 18 or later. There's no `npm install`, and no other dependencies. They talk only to `api.nike.com` and `strava.com`.

> **Unofficial.** Nike's API is undocumented and can change at any time. This worked in October 2026 for a history going back to 2007.

---

## 1. Install Node.js

Download the **LTS** version from [nodejs.org](https://nodejs.org/) and install it. Then check it worked by opening Terminal (or Command Prompt) and running:

```
node -v
```

## 2. Download your Nike runs

1. Download this repository (**Code → Download ZIP**) and unzip it.
2. In Chrome, log in at [nike.com](https://www.nike.com/).
3. Open developer tools (`Cmd+Option+I` on Mac, `F12` on Windows) and go to **Application → Local storage**.
4. Under **https://www.nike.com** (or **https://accounts.nike.com**), find the key that starts with `oidc.user:https://accounts.nike.com:`. Click it and copy the **`access_token`** value.
   - Don't share this token. It gives access to your Nike account.
   - Don't log out of nike.com while the download is running. Logging out cancels the token.
5. In Terminal, go to the unzipped folder and run:

   ```
   node nike-download.js
   ```

   Paste the token when asked.

The token expires after about an hour. If the script reports that the token was refused, copy a fresh `access_token` and run the same command again. It carries on where it stopped.

When it finishes, there's a **`nike-export`** folder next to the scripts:

| | |
|---|---|
| `gpx/` | One GPX file per run with GPS. This is a standard format that Garmin Connect, intervals.icu, Runalyze, Coros and others can also import. |
| `raw/` | Nike's complete data for every run. **Keep this as your backup** before you delete your Nike account. |
| `summary.csv` | One line per run, including runs without GPS. |

## 3. Create a Strava API app (free, about 5 minutes)

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) and fill in:
   - **Application Name:** anything, for example "Nike import".
   - **Category:** Other.
   - **Website:** `http://localhost`
   - **Authorization Callback Domain:** `localhost`
2. If it asks for an icon, upload any image.
3. Keep the page open. You need the **Client ID** (a number) and the **Client Secret** (click *show*).

## 4. Before uploading: check your Strava privacy setting

Uploaded runs use your Strava **default activity privacy**. If that's *Everyone*, years of routes, many starting at your front door, become public. You can change the default under **Settings → Privacy Controls** first.

## 5. Upload one test run

```
node strava-upload.js --test
```

1. Paste your Client ID and Secret when asked.
2. A Strava page opens. Click **Authorize** and leave all the boxes ticked.
3. The script reads your existing Strava runs, works out what's missing, and uploads one run.
4. Open the link it prints and check the run looks right: it's a Run, it has a map, and the date and time are correct.

## 6. Upload the rest

```
node strava-upload.js
```

- **Strava rate limits:** the script pauses on its own when Strava asks it to slow down. Strava also has a daily limit, so with a long history it may stop and ask you to run it again the next day. Run the same command and it carries on without creating duplicates.
- **Stopping:** you can stop it with `Ctrl+C` at any time and run it again later.
- **Mac:** keep your Mac awake while it runs.

## 7. Optional: replace runs that have no map

If the script says some runs are *on Strava without a map but have GPS in Nike*, open `nike-export/_strava/mapless_on_strava.html`. Strava doesn't let apps delete activities, so:

1. Delete each listed run on Strava: open its link, click **···** and choose **Delete**.
2. Run `node strava-upload.js` again.

The GPS versions replace them and keep the titles you had given them.

## 8. Clean up

- Revoke the app's access at [strava.com/settings/apps](https://www.strava.com/settings/apps).
- Delete `nike-export/_strava/strava_auth.json`, which holds your Strava sign-in.
- Back up the `nike-export` folder somewhere safe.
- If you're leaving Nike Run Club, disconnect it from Strava so new runs aren't uploaded twice.

---

## Notes and limitations

- **Runs without GPS** (treadmill and early Nike+ iPod/SportBand runs) can't have a map. They're created as manual runs with distance and time. Runs Nike marked as indoor are flagged as indoor on Strava.
  - Nike stores times in UTC, so these manual runs get their start time in your computer's current time zone. Runs done abroad may be an hour or two out.
- **Duplicate check:** a Nike run counts as already on Strava if a Strava run starts within 3 minutes of it and is about the same distance. Nike sometimes holds two copies of one run; only one is uploaded.
- **Only runs are downloaded.** Nike Training Club workouts are not included.
- **Security:**
  - Your Nike token is used only while the download runs and is never saved.
  - The Strava sign-in is saved locally, readable only by you, so the upload can resume. Delete it when you're done.

## Credits

- Based on the approach of [alexpryshchepa/nrc2strava](https://github.com/alexpryshchepa/nrc2strava).
- Uses Nike's current activity endpoints as found by [mxdc/nrc2strava](https://github.com/mxdc/nrc2strava).
- Rewritten for Nike's 2026 login, with resumable downloads, duplicate detection against an existing Strava account, manual runs for non-GPS activities, and Strava rate-limit handling.

## License

MIT, see [LICENSE](LICENSE).
