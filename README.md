# ZoneMap

A full-screen map that shows which DSB/DOT fare zones a public-transport trip passes through,
so you know when a commuter card needs a zone extension.

Live at **https://fpwrasmussen.github.io/zonemap/**.

Enter a start and destination; the app lists up to ~6 routes, each with the zones it crosses.
The selected route is drawn on the map and its zones are highlighted.
Click a zone to highlight it; click it again, or anywhere outside the zones, to clear it.

## How it works

It's a static site with no build step and no backend.

| Piece | Source |
|---|---|
| Zone polygons | `data/zones.geojson` |
| Place search + routing | [Transitous](https://transitous.org) (free, no API key) |
| Map | [Leaflet](https://leafletjs.com) + OpenStreetMap tiles |

Each transit leg's geometry is resampled every 30 m and checked against the zone polygons. Walking is ignored.
If a route spends less than 200 m in a zone, that zone is listed separately under **border** and isn't counted.
This is usually a border station, e.g. Hellerup St. is in both zone 2 and zone 30.

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

- The zone list comes from route geometry, not from a fare calculator.
  The app doesn't apply ticket rules such as zone counting or the "via" rules.
- Departures are always for "now".
- Transitous is a community service: please keep usage personal-scale.
