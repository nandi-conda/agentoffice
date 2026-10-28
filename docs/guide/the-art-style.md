# The art style

The office is drawn entirely as vector shapes on a canvas every frame
(furniture, soft shadows, sunlight through the north windows, desk lamps), so
it stays sharp at any zoom or pixel density. Lighting follows your local
clock: morning light, golden hour, and a lamp-lit office at night (add
`?hour=21` to the URL to preview).

Characters are **raster→vector traced** in the browser (`public/js/trace.js`):
each frame is split into flat colour regions, each region's pixel boundary is
traced into closed loops, staircase corners are smoothed with Chaikin
subdivision, and a traced silhouette underneath gives a clean ink outline. The
◆ button (or `V`) switches back to the original pixels, drawn at whole-number
scale so they stay crisp.

![The lounge at night](../night.png)
