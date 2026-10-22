# assets

Hand-authored SVG. No build step, no image dependencies.

| file | use |
|---|---|
| `banner.svg` | README hero (1280×360) |
| `architecture.svg` | the one-call-becomes-N diagram (1200×560) |
| `stats.svg` | animated token comparison (1000×300) |
| `logo.svg` | square mark (512×512) |
| `social.png` | GitHub social preview (1280×640) |
| `social.html` | source for `social.png` |

Palette: void `#07090F` · panel `#101827` · cyan `#22D3EE` · gold `#F2C14E` · text `#E8EDF7` · muted `#7C8AA5`.

Regenerate the social card (Chrome/Edge headless, no npm packages):

```bash
chrome --headless=new --disable-gpu --hide-scrollbars \
       --force-device-scale-factor=1 --window-size=1280,640 \
       --screenshot=assets/social.png \
       file:///absolute/path/to/assets/social.html
```

Then upload it in **Settings → General → Social preview** (GitHub has no API for this).
