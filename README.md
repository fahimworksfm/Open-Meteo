# 🌍 Meteora — a real-weather world

**Explore Earth's actual weather as a living, animated low-poly world.**
Nothing is faked: the sun sits where it truly sits for that place and moment, real wind
bends the trees and slants the rain, real cloud cover fills the sky, real wave height
moves the sea — and a time machine scrubs from **1940** to **16 days into the future**.

Powered end-to-end by [Open-Meteo](https://open-meteo.com/): no API key, no backend,
no build step. One static folder.

| Live coast | Real thunderstorm | Alpine whiteout |
|---|---|---|
| ![Clear coast](docs/screenshots/coast-clear.png) | ![Storm](docs/screenshots/coast-storm.png) | ![Snow](docs/screenshots/alpine-snow.png) |

## What it is

- **A terrain-aware diorama.** Search anywhere. A 9×9 grid of real ground elevations
  (Open-Meteo elevation API) sets the bones of a procedural low-poly scene; the marine API
  decides whether a living sea laps at it; latitude and the local climate pick the biome
  palette and vegetation. Every location looks like *itself*.
- **Weather that is honest.** Sun and moon positions are computed astronomically for the
  place and moment you're viewing. Cloud cover, precipitation, fog, snow cover, wind sway,
  wave height, storm light and lightning are all driven by the actual data — the scene
  never shows weather that isn't (or wasn't) happening.
- **A time machine.** The scrub bar covers ten days around now, interpolated hourly.
  The 🕰 button opens an expedition to any date since 1940 via the historical archive —
  watch a 1962 rainstorm fall on Nazaré.

  ![Expedition](docs/screenshots/expedition-1962.png)
- **📖 Logbook.** Seventeen achievements for weather you *witness*: stand in a live
  thunderstorm, find −30 °C, catch 5 m seas, see the midnight sun. Sightings reached
  through the time machine are honestly badged "via time machine".
- **🎯 Forecast duel.** Call tomorrow's high anywhere on Earth. The model's forecast is
  locked in at the same moment; the recorded actual settles the duel the next day.
  Streaks tracked. Beat the supercomputer.
- **🌐 World right now.** One batched call across ~36 places surfaces the live extremes —
  hottest, coldest, windiest, and every storm in progress — so hunting achievements is
  discovery, not tedium.
- **Procedural sound.** Wind, rain and distance-delayed thunder are synthesized in
  WebAudio from the same data. 🔇/🔊 toggle in the top bar.

## Run it

Any static file server works (ES modules need HTTP, not `file://`):

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Deploying is the same story: GitHub Pages, Netlify, Cloudflare Pages — point at the repo
root, done. There is no build step; `three.js` is vendored in `vendor/`.

## How it holds up under traffic

Everything runs in the visitor's browser against Open-Meteo's public, keyless APIs
(free for non-commercial use, [fair-use policy](https://open-meteo.com/en/terms)).
The site itself is static files — there is nothing to scale.

## Architecture

```
index.html            shell + importmap (three.js from vendor/)
css/style.css         glass-and-glow UI chrome
js/
  main.js             app state, time machine, search, panels, boot
  api.js              Open-Meteo clients: forecast, archive, marine, elevation, geocoding
  solar.js            astronomical sun/moon position (the sky never lies)
  palette.js          WMO code semantics + the one place that owns all color grading
  audio.js            procedural WebAudio wind/rain/thunder
  logbook.js          achievements (localStorage)
  duel.js             forecast duel + resolution against recorded actuals (localStorage)
  worldnow.js         batched live-extremes sampler
  scene/
    world.js          renderer, camera, lights, frame loop
    sky.js            gradient dome shader, sun/moon, stars, drifting cloud fleet
    terrain.js        procedural diorama: elevation grid → heightfield → biome-painted
                      low-poly mesh, sea with real waves, instanced trees/rocks,
                      dynamic snow line and rain-wet ground via shader uniforms
    effects.js        GPU rain/snow particles, lightning strikes
```

Data flow is one-directional and per-frame: *timeline hour (interpolated) → conditions →
solar position → color grade → uniforms*. The 3D world is a pure function of real data
and time.

## Credits

- Weather, marine, geocoding and elevation data by [Open-Meteo.com](https://open-meteo.com/),
  licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Rendering: [three.js](https://threejs.org/) (MIT, vendored — license in `vendor/THREE-LICENSE.txt`).
- No tracking, no accounts; your logbook and duels live in your own browser.
