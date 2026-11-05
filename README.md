# 40k Codex

Offline unit browser for Warhammer 40,000 (11th Edition), built from the community
[BSData wh40k-11e](https://github.com/BSData/wh40k-11e) data files. No internet or server required.

## Usage

Open `index.html` in a browser (double-click). The first load takes a few seconds (~47 MB of data).

## Hosting on GitHub Pages

Upload these files to a GitHub repository (Add file → Upload files):

```
index.html  app.js  builder.js  style.css  .nojekyll  README.md
data/stratagems.js
```

`data/bsdata.js` is not needed online (the web upload limit is 25 MB): on the first visit the app downloads the
BSData files from GitHub and keeps them in the browser. Then Settings → Pages → Deploy from a branch → `main` / `(root)`.
The app is served at `https://<user>.github.io/<repository>/`. The site is public.

## Sync between devices (GitHub Gist)

Army Builder → ☁ → paste a GitHub fine-grained token with **Gists: Read and write** → Connect.
The app finds (or creates) a private Gist with the file `40k-codex-rosters.json` and keeps the rosters in sync:
after every change, when the page is opened and when it comes back to the foreground. Use the same token on
every device. The token is stored only in that browser.

## Updating the data

### In the app (automatic)

When the page is opened, the app checks [BSData/wh40k-11e](https://github.com/BSData/wh40k-11e) on GitHub
(at most once per hour; ⟳ in the top bar checks right away). If a newer commit exists, it downloads the data
files directly from GitHub and stores them in the browser (IndexedDB). When the download is finished, click
**Reload** in the top bar. The browser copy is used as long as it is newer than `data\bsdata.js`.

- The current data version (commit date and SHA) is shown in the top bar.
- The browser copy belongs to that browser only (Chrome and Edge keep separate copies).
- Without internet, or if the browser storage is cleared, `data\bsdata.js` is used.

### With PowerShell (optional)

Updates `data\bsdata.js` itself (only if a newer commit exists):

```
powershell -ExecutionPolicy Bypass -File build.ps1 -Update
```

- `-Force` rebuilds even when the data is already up to date.
- `-Source <zip or folder>` builds from a local copy instead of GitHub.
- The version is stored in `data\version.json` / `data\version.js`.
- Every run is logged to `data\update.log`.

### Daily update with Task Scheduler (optional)

```
powershell -ExecutionPolicy Bypass -File install-update-task.ps1
```

Registers the Task Scheduler task "40k Codex - BSData update", which runs `build.ps1 -Update` every day at 09:00
(or as soon as possible afterwards). Use `-At 18:30` for another time, `-Remove` to delete the task.
Reload the open page after an update.

## Features

- Factions grouped as in the catalogue names (Imperium / Chaos / Xenos); units grouped by primary category.
- Datasheet: unit profile, Ranged Weapons, Melee Weapons, Abilities, points by model count,
  option groups, Leader / Supported by associations, keywords.
- Click a weapon keyword or rule to see its description from the data.
- Detachment tab: collapsible detachments with Detachment Points, Force Disposition, rules, Enhancements,
  Stratagems (with CP and usage tags named like the filters, e.g. `Your` `Opponent's` `Shooting` `Fight`) and
  Core Stratagems. Each Stratagems section has filters by turn (Your / Opponent's) and phase (Command, Movement,
  Shooting, Charge, Fight); stratagems usable in either turn or any phase always match.

## Army Builder

Switch between **Codex** and **Army Builder** in the top bar. Rosters are saved in the browser.

- New roster: name, faction, Battle Size (from the data: Incursion / Strike Force / Onslaught), points limit and
  Detachments (Detachment Points shown against the limit). Later changed with the ⚙ button in edit mode.
- **Edit mode** (rosters | units | roster editor) and, after **Save**, **view mode** (roster | datasheet of the
  selected unit, with its Enhancement). View mode has quick buttons for the chosen Detachments (rules, Enhancements)
  and their Stratagems + Core Stratagems (with the turn / phase filters).
- Units from the faction list (Allies and Legends optional), unit size by points step, Enhancements
  (Characters that are not Epic Heroes, only from the chosen detachments), Leader / Supported by attachment.
- Live totals for pts, Detachment Points and Enhancements against the Battle Size limits.
- Checks from the data: points / DP / Enhancements limits, at least one Character, unit and category maximums
  (e.g. one of each named character), Enhancement rules, one attached unit of each kind per unit.
- Export as text (copy to clipboard), copy and delete rosters. Click a unit name to see its datasheet.

Not covered yet: wargear choices and their point costs, points changes that depend on other selections
(shown as warnings), detachment-specific unit restrictions.

## Stratagems source

Stratagems are not part of BSData. They come from
[pguetschow/warhammer-40k-stratagem-card-generator](https://github.com/pguetschow/warhammer-40k-stratagem-card-generator)
(`public/data/11/cards.json`, generated from the Wahapedia data export) and are matched to BSData detachments by name.
They are updated the same way as the BSData files (in the app, or `build.ps1 -Update` → `data\stratagems.js`).
- Search in the current faction or in all factions (`/` focuses search).
- Compare up to 4 units side by side.
- Filters: category, Legends, source catalogue.
- Dark / light theme, works on mobile.

## Known limitations

- Points are calculated from model count. When the cost also depends on other selections, the
  modifier is listed under the points table.
- Abilities that only apply under a condition are shown with a dashed border.
- Crusade entries are not shown.
- Detachments without a stratagem match (different name or missing in the stratagem data) show no Stratagems section.
