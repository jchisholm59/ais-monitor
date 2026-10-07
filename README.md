# ais-monitor + Ships card

**A Home Assistant card for marine traffic: the vessels closest to a place you choose, live from AIS.**

The companion to [adsb-monitor](https://github.com/jchisholm59/adsb-monitor) (aircraft), in the same style. Two pieces:

- **`ships-card`**: a Lovelace card with three tabs, each showing the closest vessels (50 by default) to a location you
  pick from a list in the header:
  - **Map**: vessels as hulls pointing along their course when moving, dots when moored or at anchor, coloured by
    class, with range rings around the location and a class filter. Tap one for a popup and its last 2 hours of track.
  - **Vessels**: a sortable list with flag, class, type, status, speed, course, distance, destination, length and
    last seen. Filter chips by class; 📍 jumps to the vessel on the map.
  - **Vessel**: flag and country, name, class, type, size, draught, MMSI / IMO / callsign, speed, course and heading,
    distance and bearing from the location, the destination and ETA the crew reported, a speed chart, and links to
    MarineTraffic, VesselFinder and MyShipTracking.
- **`ais-monitor`**: a small always-on Node service (no dependencies) that holds one connection to
  [aisstream.io](https://aisstream.io), a free AIS feed that needs a key. It keeps a table of every vessel heard in
  the areas you choose, and serves the closest ones to the card. Your key stays on your server; aisstream doesn't
  allow browser connections anyway.

## Classes
From the AIS ship type each vessel broadcasts, plus its name:

| Class | From |
|---|---|
| **Military** | type 35, or a navy prefix: HMCS / CFAV → RCN, USS / USNS → USN, HMS / RFA → RN, and other navies; the tag shows the navy |
| **Government** | search and rescue (51), law enforcement (55), and names like CCGS, USCGC, RCMP, POLICE, COAST GUARD |
| **Commercial** | passenger (cruise ship if 200 m or more, otherwise passenger / ferry), cargo, tanker, high-speed craft |
| **Service** | tug, towing, pilot vessel, dredging, diving, port tender, anti-pollution, medical |
| **Fishing** | fishing |
| **Private** | sailing and pleasure craft |
| **Other** | any other type |
| **Unknown** | no type received yet |

Flags come from the MMSI's country digits (316 Canada, 338/366–369 USA, 232–235 UK, 636 Liberia, 538 Marshall Islands,
351–357 Panama…).

**Patience:** ships send their name and type only every 6 minutes, and aisstream is built from volunteer receivers,
so a newly seen vessel shows as "Waiting for details" for a while. The monitor remembers names and types for 30
days, so the picture fills in over the first hours and stays filled. Many small craft (class B transponders) never
send a type.

## Requirements
- A free **aisstream.io** API key: sign in at aisstream.io, then *API Keys*. A key allows only a limited number of
  simultaneous connections, so run one monitor per key.
- **Home Assistant** for the card.
- For the monitor: **Node.js 22+** (for its built-in WebSocket) on any always-on machine, kept running with pm2 or
  systemd.

## Install

### 1. The monitor
```bash
git clone https://github.com/jchisholm59/ais-monitor.git
cd ais-monitor
cp .env.example .env
nano .env                         # AISSTREAM_KEY, LOCATIONS
chmod 600 .env
pm2 start ecosystem.config.js && pm2 save
curl http://localhost:7110/api/status
```

### 2. The card
1. Copy `dist/ships-card.js` to `/config/www/` on Home Assistant.
2. Settings → Dashboards → ⋮ → Resources → Add `/local/ships-card.js` as a *JavaScript module*.
3. Add a view (a *Panel* view gives the map the whole screen) with:
   ```yaml
   type: custom:ships-card
   monitor:
     - http://192.168.1.20:7110      # ais-monitor on your LAN
     - http://100.64.0.10:7110       # optional: over Tailscale/VPN, for away from home
   ```

## Configuration

### `.env` (monitor)
| Variable | Default | |
|---|---|---|
| `AISSTREAM_KEY` | none | Your aisstream.io key |
| `LOCATIONS` | none | `Name:lat,lon;Name:lat,lon`. The places the card can list the closest vessels to; the first is the default |
| `LOCATION_RADIUS_NM` | `40` | AIS is received for a box this size around each location |
| `AREA_LAT`, `AREA_LON`, `AREA_RADIUS_NM` | none, `100` | Optional wider area to receive as well |
| `CLOSEST` | `50` | Default number of closest vessels |
| `PORT` | `7110` | |

### Card options
| Option | Default | |
|---|---|---|
| `monitor` | (required) | ais-monitor URLs, tried in order |
| `title` | `Ships` | |
| `n` | `50` | How many closest vessels |
| `rings` | `[1, 2, 5, 10, 25]` | Range rings around the location, nm |
| `refresh` | `10` | Seconds between updates |
| `map_height` | fills the screen | px |

The header's location list also has **Centre of the map…**, which lists the vessels closest to wherever the map is
centred (inside the areas the monitor receives).

## API
| | |
|---|---|
| `GET /api/status` | connection, message count, areas, locations, vessel counts |
| `GET /api/vessels?lat=&lon=&n=` | the `n` closest vessels to a point, with class, flag, distance and bearing |
| `GET /api/vessel/<mmsi>?lat=&lon=` | one vessel, with its last 2 hours of track |

## Notes
- Destinations and ETAs are typed in by the crew and are often stale or abbreviated (e.g. "CA HAL").
- Warships often switch AIS off or send little; many small boats have no AIS.
- Anyone who can reach the monitor's port can read the vessel list (there are no settings to change). Keep it on your
  LAN or VPN.
- Map: Esri World Gray Canvas (Esri, HERE, Garmin, © OpenStreetMap contributors). AIS data: aisstream.io.

## License
MIT
