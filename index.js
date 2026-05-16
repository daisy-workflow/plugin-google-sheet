// Google Sheets — one Daisy plugin, multiple operations selected by
// the `operation` input. The workflow author drops one node, picks
// the action from a dropdown, and fills the inputs that action needs.
//
// Wire it up:
//   1. Create a service account in Google Cloud Console + enable the
//      Sheets API. Download the JSON key.
//   2. Create a workspace `generic` config named "google" with a
//      single key `credentialsJson` whose value is the entire JSON
//      file as a string.
//   3. Share each target spreadsheet with the service account's
//      client_email (Editor for write ops, Viewer for read-only).
//   4. `docker compose -f docker-compose.yml -f docker-compose.plugins.yml \
//          --profile google-sheets up -d`
//      `npm run install-plugin -- --endpoint http://daisy-google-sheets:8080`

import { servePlugin } from "@daisy-workflow/plugin-sdk";
import fs from "node:fs";

import { loadGoogleAuth } from "./lib/client.js";
import { OPERATIONS }     from "./lib/actions.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);

servePlugin({
  manifest,
  async execute(input, ctx) {
    const { operation, config = "google" } = input || {};
    if (!operation) throw new Error("`operation` is required (see manifest enum for valid values)");

    const handler = OPERATIONS[operation];
    if (!handler) {
      throw new Error(
        `unknown operation "${operation}". Valid: ${Object.keys(OPERATIONS).join(", ")}`,
      );
    }

    // Resolve auth once per call. Token cache inside the client makes
    // repeated calls in the same execution cheap; this lookup is just
    // pulling fields out of ctx.config.
    const auth = loadGoogleAuth(ctx, config);

    const { status, result, url } = await handler(auth, input, ctx?.signal);

    return {
      ok:        true,
      operation,
      status,
      result,
      url,
    };
  },
  async readyz() { return true; },
});
