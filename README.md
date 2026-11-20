# FHIRView — a query lab for FHIR servers

A read-only, **MongoDB Compass-style** tool for exploring a FHIR R4 server from your browser. It was built for the
Medblocks FHIR bootcamp: connect to your challenge tenant, see what's in it, and learn which searches are fast.

**Live:** https://balasankarpazhani.github.io/FHIRView/

## What it does

| Compass | FHIRView |
|---|---|
| Connection string | Base URL + bearer token; the server's CapabilityStatement (`/metadata`) drives everything else |
| Databases / collections | Resource types the server supports, with counts on demand (`_summary=count`) |
| Filter `{field: value}` | Search parameters with **autocomplete from the server's own list**, their types, modifiers (`:exact`, `:missing`, …) and prefixes (`ge`, `lt`, …) |
| Project / Sort / Limit | `_elements` (with one-click chips for the fields seen), `_summary`, `_sort`, `_count`, Next / Prev paging |
| `$lookup` | `_include` / `_revinclude`, offered from the CapabilityStatement |
| Documents | List, Table and JSON views; **references are clickable** (`Patient/123` opens it, Back returns) |
| Schema | Samples up to 100 matching resources: which fields are filled in, how often, and the top codes and statuses |
| Explain plan | The exact request, status, time, bytes, matches vs includes, every parameter with the server's own description, and tips |
| — | **Make it leaner**: the same query as full resources, `_summary=true` and `_elements`, side by side (bytes saved, time) |

Plus examples, a local query history, raw query editing (type `Observation?code=…` and press Enter) and **Copy as
curl** (the token is written as `$FHIR_TOKEN`).

FHIR search is not a query language: you can filter only on the parameters a server defines, and there is no
aggregation pipeline. The autocomplete shows exactly what is possible on the server you are connected to.

## Is it safe to paste my token?

You shouldn't have to take anyone's word for it, so here is how to check:

- **One HTML page, one script, one stylesheet. No libraries, no build step, no analytics.** Read `app.js`; the
  network code is one function, `fhirGet()`, and it only ever sends `GET`.
- **A Content-Security-Policy** in `index.html` lets the browser connect **only** to
  `challenge.fhir.medblocks.com` and `hapi.fhir.org`. Even a bug or a malicious change to the script could not send
  your token anywhere else — the browser blocks it. (Open DevTools → Network and watch.)
- **The token lives in memory only.** It is never stored, never put in a URL, never logged; closing the tab forgets it.
- **Requests go straight from your browser to the FHIR server.** There is no server of ours in between.
- **The base URL is hidden on screen** (`[base]/Patient?…`) so screenshots don't reveal your tenant. Query history
  in `localStorage` is saved without it.
- **Read-only.** Your challenge tenant also feeds your live app; nothing here can change it.

Still, treat your token like a password: if in doubt, rotate it in the challenge dashboard afterwards.

## Run it yourself

It is static: `python3 -m http.server` in this folder and open http://localhost:8000. To use another FHIR server,
add its origin to `connect-src` in `index.html` and to `SERVERS` in `app.js`.

## Credits

Built by Bala Sankar Pazhani with Claude during the Medblocks FHIR bootcamp. MIT licence.
