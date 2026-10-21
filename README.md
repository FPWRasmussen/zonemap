# ZoneMap

A full-screen map that shows which DSB/DOT fare zones a public-transport trip passes through,
so you know when a commuter card needs a zone extension.

Live at **https://fpwrasmussen.github.io/zonemap/**.

Enter a start and destination; the app lists up to 6 routes, each with the zones a commuter card for that route must cover.
The selected route is drawn on the map and its zones are highlighted.
Click a zone to highlight it; click it again, or anywhere outside the zones, to clear it.

On phones, expand **Show routes & details** to browse alternatives, or use **Edit journey** to change the search.
Long zone lists show the first and last three zones in both the bottom summary and route cards.
Small route dots mark intermediate stops returned by the planner; tap a dot for its station name.

## How it works

It's a static site with no build step and no backend.

| Piece | Source |
|---|---|
| Zone polygons | `data/zones.geojson` |
| Place search, routing, zones per route | Rejseplanen's journey planner (`rejseplanen.dk/bin/iphone.exe`, the endpoint the rejseplanen.dk web app uses) |
| Map | [Leaflet](https://leafletjs.com) + OpenStreetMap tiles |

Routes come from `TripSearch`. Each route's zones then come from a `Reconstruction` request with a tariff request:
the commuter card fare (`SP`) lists the zones it is valid in (`vz`).
So border stations such as Hellerup (zone 2/30) are handled the same way as when you buy the ticket.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Deployment

GitHub Pages serves the `main` branch root as-is (**Settings → Pages → Deploy from a branch → `main` / root**).
Every push to `main` redeploys automatically.
Any static host works the same way, e.g. Render as a "Static Site" with an empty build command and publish directory `.`.

## Limitations

- Departures are always for "now".
- The Rejseplanen endpoint is the web app's internal API, not the official keyed API 2.0, so it can change without notice.
