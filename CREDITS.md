# Credits

## 3D ship models

The Bridge tab's Follow view draws each vessel with one of these models, stretched to its own AIS length and beam.
All are from [Sketchfab](https://sketchfab.com) and licensed under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0) by their authors.

**Changes made** (2026-10-12): turned bow-forward, centred, scaled to unit length and beam with the waterline at
y = 0, meshes simplified (the larger ones to 35-50 % of their triangles), textures resized to at most 1024 px and
converted to WebP, and compressed with meshopt (`gltf-transform optimize`). The originals are on the linked pages.

| File | Used for | Model | Author |
|---|---|---|---|
| `dist/ship-container.glb` | Container ships | [Container Ship](https://sketchfab.com/3d-models/container-ship-aaa41cca946b4a08bc08cf692b7757be) | RM02 ([RM02](https://sketchfab.com/RM02)) |
| `dist/ship-tanker.glb` | Tankers | [Tanker Ship](https://sketchfab.com/3d-models/tanker-ship-96ebf61af42b4062ae98a6ad848e1a25) | Art Blender ([ArtBlender](https://sketchfab.com/ArtBlender)) |
| `dist/ship-lng.glb` | Gas tankers (LNG / LPG / GAS in the name) | [LNG Ship](https://sketchfab.com/3d-models/lng-ship-fa335b96450d4344863bbf5d912a0288) | Art Blender ([ArtBlender](https://sketchfab.com/ArtBlender)) |
| `dist/ship-bulk.glb` | Bulk carriers (BULK / ORE / CEMENT in the name) | [Bulk Carrier - TFCC HERITAGE - IBEE Corp](https://sketchfab.com/3d-models/bulk-carrier-tfcc-heritage-ibee-corp-e78b4f1fdc094a63bb7d6c24d8e7e7dd) | Gwenaël Hervé ([Gwenael_Herve](https://sketchfab.com/Gwenael_Herve)) |
| `dist/ship-cruise.glb` | Cruise ships (passenger, 150 m and over) | [Cruise Ship](https://sketchfab.com/3d-models/cruise-ship-bb782326932e4c179e34f3d6c8e36b86) | farhad.Guli ([farhad.Guli](https://sketchfab.com/farhad.Guli)) |
| `dist/ship-ferry_small.glb` | Ferries under 60 m | [Sydney Emerald-Class Low Poly](https://sketchfab.com/3d-models/sydney-emerald-class-low-poly-8b39b8957231420d919b60febb627bd5) | A Certain Duck ([TheOminousDuck](https://sketchfab.com/TheOminousDuck)) |
| `dist/ship-ferry.glb` | Ferries 60 m and over | [Hailuoto car ferry L/A Meriluoto](https://sketchfab.com/3d-models/hailuoto-car-ferry-la-meriluoto-44eaf2dd56b74e76a310d2e532957dbe) | Snowsoup ([snowsoup](https://sketchfab.com/snowsoup)) |
| `dist/ship-navy.glb` | Warships | [1:1 Low poly US NAVY DDG-51 USS Arleigh Burke.](https://sketchfab.com/3d-models/11-low-poly-us-navy-ddg-51-uss-arleigh-burke-17be09c31c6047e4a5969b68c29eba03) | Yi Tsung Lee ([WTigerTw](https://sketchfab.com/WTigerTw)) |
| `dist/ship-pilot.glb` | Pilot boats | [Pilot II](https://sketchfab.com/3d-models/pilot-ii-6ea031237b6b4382ab362790f8af4e66) | gogiart ([agt14032013](https://sketchfab.com/agt14032013)) |
| `dist/ship-sail.glb` | Sailing boats | [Sailboat](https://sketchfab.com/3d-models/sailboat-76d0b1e24be14d2f9a524bfce3001aeb) | Sergei ([sergeif](https://sketchfab.com/sergeif)) |
| `dist/ship-yacht.glb` | Motor yachts and pleasure craft | [Frickie's yacht](https://sketchfab.com/3d-models/frickies-yacht-1afd320662384bc0910f1778e9cb5eae) | dannzjs ([dannzjs](https://sketchfab.com/dannzjs)) |
| `dist/ship-tug.glb` | Tugs, workboats, SAR and government vessels | [40ft Tugboat](https://sketchfab.com/3d-models/40ft-tugboat-0555e3e0c1be4080a2ba6731b801f8da) | Potater_King ([Potater_King](https://sketchfab.com/Potater_King)) |
| `dist/ship-fishing.glb` | Fishing boats | [Fishing Ship game-ready asset](https://sketchfab.com/3d-models/fishing-ship-game-ready-asset-f791868a8b5f4996a49a3c8cd99336f6) | Dominik Biały ([crazyyuan](https://sketchfab.com/crazyyuan)) |

Set `ship_models: false` on the card to use the simple ships drawn in code instead (no downloads).
