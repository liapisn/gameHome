# Third-party notices

## AnyScene

Source: https://github.com/apekshik/anyscene (read at commit `88c1daf`). MIT licence, reproduced below.

Files adapted from it (each carries a header naming its original):

| Here | AnyScene original |
|---|---|
| `src/lib/fal/client.ts` | `generate/fal.mjs` |
| `scripts/fal-models.mts` | `generate/models.mjs` |
| `src/lib/models3d/reference.ts` | `endpoint/props.py` (crop, reference edit call, SCAN prompt) |
| `src/lib/models3d/mesh.ts` | `endpoint/props.py`, `generate/fal.mjs` (generator settings) |
| `blender/prep_prop.py` | `scenes/tokyo-electronics-repair/scripts/prep.py`, `load_asset` in `endpoint/assemble.py` |
| `blender/render_compare.py` | `pipeline/render_compare.py` |
| `src/lib/models3d/critic.ts` (house critic) | `CRITIC` and `critic_schema` in `builder/scene_builder.py` |

```
MIT License

Copyright (c) 2026 Apekshik Panigrahi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
