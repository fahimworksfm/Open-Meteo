// tiles.js — real terrain, from free keyless sources.
//
//   elevation : AWS "terrarium" terrain tiles (Mapzen/Tilezen open dataset on S3),
//               PNG-encoded metres: height = R*256 + G + B/256 - 32768
//   imagery   : Esri World Imagery basemap tiles (satellite/aerial)
//
// Both are plain XYZ tile services with permissive CORS, so the browser can pull
// them directly — no key, no proxy, nothing to run. Everything here is best-effort:
// callers fall back to the stylized diorama if a fetch fails.

const ELEV_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const IMAGERY_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

export const IMAGERY_CREDIT = 'Imagery © Esri, Maxar, Earthstar Geographics · Elevation: Mapzen/Tilezen terrain tiles';

const TILE_PX = 256;

// ---- slippy-map maths ----

export function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
}

// ground resolution in metres per pixel
export function metresPerPixel(lat, z) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`tile failed: ${url}`));
    img.src = url;
  });
}

// Fetch an n×n block of tiles and paint them into one canvas.
async function mosaic(urlFor, z, x0, y0, n) {
  const canvas = document.createElement('canvas');
  canvas.width = TILE_PX * n;
  canvas.height = TILE_PX * n;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const jobs = [];
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      const max = Math.pow(2, z);
      const tx = ((x0 + dx) % max + max) % max; // wrap the antimeridian
      const ty = y0 + dy;
      if (ty < 0 || ty >= max) continue;
      jobs.push(
        loadImage(urlFor(z, tx, ty)).then(img => {
          ctx.drawImage(img, dx * TILE_PX, dy * TILE_PX);
        }),
      );
    }
  }
  // one missing tile shouldn't sink the whole mosaic
  const results = await Promise.allSettled(jobs);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  if (!ok) throw new Error('no tiles loaded');
  return { canvas, ctx, coverage: ok / results.length };
}

/**
 * Real heightfield + matching satellite texture centred on a location.
 * @returns {{heights:Float32Array, size:number, metresPerPixel:number,
 *            spanMetres:number, minH:number, maxH:number, seaFraction:number,
 *            texture:HTMLCanvasElement|null, credit:string}}
 */
export async function fetchTerrainTiles(lat, lon, { zoom = 12, tiles = 2, grid = 160 } = {}) {
  const x0 = Math.floor(lonToTileX(lon, zoom)) - Math.floor((tiles - 1) / 2);
  const y0 = Math.floor(latToTileY(lat, zoom)) - Math.floor((tiles - 1) / 2);

  // elevation is required; imagery is a bonus we can live without
  const [elev, imagery] = await Promise.all([
    mosaic(ELEV_URL, zoom, x0, y0, tiles),
    mosaic(IMAGERY_URL, zoom, x0, y0, tiles).catch(() => null),
  ]);

  const px = TILE_PX * tiles;
  const data = elev.ctx.getImageData(0, 0, px, px).data;

  // decode terrarium PNG into metres, resampled onto a `grid`×`grid` heightfield
  const heights = new Float32Array(grid * grid);
  let minH = Infinity;
  let maxH = -Infinity;
  let seaCells = 0;

  for (let row = 0; row < grid; row++) {
    for (let col = 0; col < grid; col++) {
      const sx = Math.min(px - 1, Math.round((col / (grid - 1)) * (px - 1)));
      const sy = Math.min(px - 1, Math.round((row / (grid - 1)) * (px - 1)));
      const i = (sy * px + sx) * 4;
      const h = data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
      heights[row * grid + col] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      if (h <= 0.5) seaCells++;
    }
  }

  return {
    heights,
    size: grid,
    metresPerPixel: metresPerPixel(lat, zoom),
    spanMetres: metresPerPixel(lat, zoom) * px,
    minH,
    maxH,
    seaFraction: seaCells / (grid * grid),
    texture: imagery ? imagery.canvas : null,
    credit: IMAGERY_CREDIT,
  };
}
