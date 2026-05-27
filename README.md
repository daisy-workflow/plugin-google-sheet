# Google Sheets plugin for Daisy AI Orchestrator

One Daisy node that talks to Google Sheets. The action is selected
per-node via the **operation** dropdown.


[![Docker Hub](https://img.shields.io/badge/Docker%20Hub-Image-blue?logo=docker)](https://hub.docker.com/repository/docker/vivek13186/daisy-plugin-google-sheets)


## Operations

| operation               | What it does                                                                  |
|-------------------------|-------------------------------------------------------------------------------|
| `sheet.get`             | Read rows from a range. With `useHeaders`, returns array-of-objects.          |
| `sheet.append`          | Append rows to the end of a sheet. Accepts 2D array or array-of-objects.      |
| `sheet.update`          | Overwrite cells in a range. Accepts 2D array or array-of-objects.             |
| `sheet.clear`           | Clear cell values in a range (formatting stays).                              |
| `sheet.delete-rows`     | Permanently delete rows by index range.                                       |
| `spreadsheet.create`    | Create a new spreadsheet (with optional initial sheet/tab titles).            |
| `spreadsheet.get`       | Read spreadsheet metadata — sheet titles, sheetIds, dimensions.               |

## Configure auth (service account)

Google Sheets is auth'd through a **service account** rather than
OAuth user consent. That fits SaaS naturally: the customer creates the
service account in their own Google Cloud project, shares each target
spreadsheet with it, and Daisy never sees a user's browser.

1. Open the [Google Cloud Console](https://console.cloud.google.com),
   pick (or create) a project.
2. **APIs & Services → Enable APIs → Google Sheets API.**
3. **APIs & Services → Credentials → Create Credentials → Service
   account.** Give it any name. Skip the optional role-granting steps.
4. Click into the service account → **Keys → Add key → Create new
   key → JSON.** A `.json` file downloads — this is your credentials.
5. Note the service account's `client_email` (looks like
   `daisy-svc@your-project.iam.gserviceaccount.com`).
6. **Share each spreadsheet** you want Daisy to touch with that
   `client_email`. Editor role for write operations; Viewer for
   read-only.

Then in Daisy:

- Configurations page → **New config → generic** → name `google`.
- Add one key:

  | Key               | Example                                               |
  |-------------------|-------------------------------------------------------|
  | `credentialsJson` | Paste the **entire JSON file** as the field's value.  |

  (Alternatively split into `clientEmail` + `privateKey` if you prefer.)

A node can override the config name per-call via the `config` input —
useful if a workspace talks to multiple Google projects.

## Install

```bash
docker compose -f docker-compose.yml -f docker-compose.plugins.yml \
  --profile google-sheets up -d

npm run install-plugin -- --endpoint http://daisy-google-sheets:8080
```

## Per-operation inputs

The manifest declares every input as optional except `operation`; each
handler checks its own required fields and returns a clear error if
they're missing. Quick reference:

- `sheet.get` — `spreadsheetId` (required), `range`, `useHeaders`, `valueRenderOption`, `majorDimension`
- `sheet.append` — `spreadsheetId` (required), `values` (required, 2D array or array of objects), `range`, `useHeaders`, `valueInputOption`
- `sheet.update` — `spreadsheetId` (required), `range` (required), `values` (required), `useHeaders`, `valueInputOption`
- `sheet.clear` — `spreadsheetId` (required), `range` (required)
- `sheet.delete-rows` — `spreadsheetId` (required), `sheetId` (required, numeric), `startIndex`, `endIndex` (both 0-based; endIndex exclusive)
- `spreadsheet.create` — `title` (required), `sheetTitles`
- `spreadsheet.get` — `spreadsheetId` (required), `includeGridData`

## Output envelope

```json
{
  "ok":        true,
  "operation": "sheet.append",
  "status":    200,
  "result":    { "spreadsheetId": "1abc…", "updates": { … } },
  "url":       "https://docs.google.com/spreadsheets/d/1abc…/edit"
}
```

`result` is operation-specific:

- `sheet.get` → `{ values: <2D array>, range, rows?: <objects> }` (rows present when `useHeaders` is true)
- `sheet.append` → Sheets API append response (`spreadsheetId`, `updates: { updatedRange, updatedRows, … }`)
- `sheet.update` → `{ spreadsheetId, updatedRange, updatedCells }`
- `sheet.clear` → `{ clearedRange }`
- `sheet.delete-rows` → batchUpdate reply object
- `spreadsheet.create` → the new Spreadsheet (id, sheets, properties)
- `spreadsheet.get` → the Spreadsheet object (sheet titles + sheetIds + dimensions)

## A1 range cheat sheet

| Range            | Means                                             |
|------------------|---------------------------------------------------|
| `Sheet1`         | Every used cell on tab "Sheet1"                   |
| `Sheet1!A:D`     | Columns A through D, all rows                     |
| `Sheet1!A1:D`    | A1 to the bottom of column D                      |
| `Sheet1!A1:D10`  | Top-left to D10                                   |
| `Q1 Numbers!A:C` | Sheets with spaces in the name need no escaping   |

## useHeaders mode

When `useHeaders: true`:

- `sheet.get` reads the first row of the range as column headers and
  returns each subsequent row as `{ header: value }`. Convenient for
  iterating in a workflow.
- `sheet.append` and `sheet.update` accept an array of objects;
  the plugin reads the sheet's first row once, then writes each object
  into the matching columns. Object keys that don't match a header
  are silently dropped. Missing keys become empty cells.

## Files

```
plugins-external/google-sheets/
├── manifest.json        # node schema (inputs + outputs)
├── index.js             # servePlugin entry, dispatches by operation
├── lib/
│   ├── client.js        # service-account auth + token cache + fetch
│   └── actions.js       # one async handler per operation
├── package.json
├── Dockerfile
└── README.md
```
