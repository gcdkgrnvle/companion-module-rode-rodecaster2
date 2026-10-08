# companion-module-rode-rodecaster2

[Bitfocus Companion](https://bitfocus.io/companion) module for the **RØDE RØDECaster Pro II**
(and, untested so far, the RØDECaster Duo), talking to the desk over its own USB HID control
protocol. Two-way and live: the desk leads, the buttons follow.

Status: **in development**, not yet in the Companion module store. Linux first; macOS and
Windows should work with node-hid but are untested.

## What it does

Channel mute and cue, channel level (opt-in, by borrowing the strip from its physical fader),
restore faders, monitor level and mute, individual headphone mix mute, all headphones off,
panic mute, record / pause / stop with elapsed time, drop marker, SMART pads with bank switching,
voice FX per slot, screen and button brightness, ducker depth and Bluetooth level. Every state
is a feedback and a variable, updated from the desk's own notifications. See
[docs/DESIGN.md](docs/DESIGN.md).

The **Monitoring** presets include **HP1 MUTE** through **HP4 MUTE** for one-press mute/unmute
of a single headphone output, including a speaker connected to Headphone 3. Other outputs stay
unchanged. When Companion mutes a mix, unmuting restores only the sends Companion muted,
even after a restart.
See [the action help](companion/HELP.md#what-the-actions-do-on-the-desk) for restore behavior.

## Routing page

Open [http://127.0.0.1:8000/instance/rodecaster2/](http://127.0.0.1:8000/instance/rodecaster2/)
on the Companion machine. Replace `rodecaster2` with the connection label if it differs.
The page is served by Companion; no separate server, build or internet connection is needed.

**Desk view** follows the desk's routing screen: choose an output with the arrows, select
**Custom**, then drag a level or cycle its button through linked, unlinked and off. The grey
marker is the fader anchor; the blue bar shows the level's offset from it, including on linked
sends. Mouse wheel and arrow keys change levels by 1%. Main Mix and Mix-minus keep the columns
read-only. **Overview** shows every output against the sources assigned to faders; click an
output heading to open its Desk view. Both views follow desk changes about every 300 ms and
show when the desk is disconnected.

Use **Save as…** to capture the whole routing setup, **Load** to recall it, **Rename** to change
its name, or **Delete** with confirmation to remove it. Presets survive Companion restarts in
the connection settings. Each saved setup also appears as a button under Companion's
**Routing** presets, with **Routing: load preset**, **Routing preset active** feedback and the
`routing_preset` variable for its matching name (empty when none matches).

Cell-state writes are verified on a Pro II running firmware 1.7.3, and the desk screen follows
them. Host level writes are verified on unlinked sends; the desk itself also adjusts linked
send offsets. Output mode writes are verified on USB 1 (the desk's tab follows, and custom cell states and levels are kept).
See [Routing page help](companion/HELP.md#routing-page) for details.

## HTTP API

The optional **HTTP API** lets Stream Deck plugins, Home Assistant and scripts read and change
desk settings from other computers on the home LAN. In the Companion connection settings,
enable **HTTP API**, enter a secret **API key**, and save. The default bind address is
`0.0.0.0`, with port `8765`; the API starts only when enabled with a nonempty key. Changing
these settings restarts its listener. Give each enabled connection its own port.

This is a separate server inside the module. Keep Companion's unauthenticated administration
server on `127.0.0.1:8000`; its routing page stays there. The API serves only `/api/v1`.
Restrict access to the trusted LAN: HTTP does not encrypt the key. On Tony's desktop, allow
the API port from `192.168.1.0/24` in ufw if that rule is not already present. This is a manual
firewall step, not something the module changes:

Add `?return=state` to any successful call to get the whole desk state back instead of just the
changed resource (the same body as `GET /api/v1/state`). A Companion setup can store that answer in
one custom variable and colour every button from it with `jsonpath()` expressions.

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8765 proto tcp
```

Open `http://companion-host:8765/api/v1/docs` for the complete, self-contained route reference.
Replace `companion-host` with the Companion computer's LAN address. This page and
`GET /api/v1/health` are public; every other route, including `GET /api/v1/openapi.json`,
requires `Authorization: Bearer <key>` or `X-API-Key: <key>`. Query-string keys are rejected.
Set `RODE_API_KEY` in the caller's environment to the configured key before these examples:

```bash
export RODE_API_URL='http://companion-host:8765/api/v1'
curl -sS "$RODE_API_URL/state" -H "Authorization: Bearer $RODE_API_KEY"
curl -sS -X PUT "$RODE_API_URL/strips/1/mute" \
  -H "Authorization: Bearer $RODE_API_KEY" -H 'Content-Type: application/json' \
  --data '{"value":"toggle"}'
curl -sS -X PATCH "$RODE_API_URL/routing/outputs/hp3/sources/mic1" \
  -H "X-API-Key: $RODE_API_KEY" -H 'Content-Type: application/json' \
  --data '{"ensureCustom":true,"state":"unlink","level":0.5}'
```

Resources cover routing and saved routing presets, strips, monitor, headphones, Bluetooth,
recorder, SMART pads, voice FX, panic mute, display brightness and ducker depth. Strips,
headphone jacks, pad slots/banks and FX slots are **one-based**, matching Companion presets.
Routing output/source numbers are **zero-based**; names and aliases such as `hp3`, `monitor`,
`mic1` and `pads` are easier to read. Responses include canonical names and numeric indexes.
On/off writes accept `{"value":true}`, `{"value":false}`, `"on"`, `"off"` or `"toggle"`
as the `value`. Channel level writes require **Let Companion drive channel levels** and use
the existing fader borrowing rules; `POST /api/v1/strips/restore` hands borrowed faders back.
Routing cell edits require Custom mode unless `ensureCustom: true` is supplied.

Every successful resource read or write returns JSON with that resource's resulting state.
For a Stream Deck button, use the response's `muted`, `listen`, `active` or other relevant
field to set its appearance, then poll the matching GET route to follow desk changes.
Property writes update the local model optimistically because the desk does not echo host
writes; this is not independent confirmation of physical hardware behavior. Pad playback
notifications may arrive after a press response, and recorder elapsed time is tracked locally.

Requests accept JSON bodies up to 64 KiB and send no CORS headers. Errors return JSON
`{"error":"message"}`: 400 invalid input, 401 missing/wrong key, 404 unknown route/preset,
409 disabled channel level control or duplicate preset name, 413 oversized body, and
503 `{"error":"desk disconnected"}` when the desk is unavailable.

## Install for development

```bash
corepack enable
yarn install
```

Point Companion's _developer modules path_ at a folder containing this repo (or a symlink to
it). On Linux also install [`udev/50-rodecaster.rules`](udev/50-rodecaster.rules) and the
`usbhid.quirks` kernel parameter described in [companion/HELP.md](companion/HELP.md).

Tests (no hardware needed):

```bash
node --test test/
```

## Credits

The desk's protocol was never published by RØDE. This module stands on the open work of:

- [rodecaster-protocol](https://github.com/Yeradon/rodecaster-protocol) (MIT) — the JUCE
  ValueTree wire format, framing and layout discovery, ported here to JavaScript
- [rcp2-cli](https://github.com/x1h0/rcp2-cli) (MIT) — handshake, recorder and pad operations,
  the device-freeze analysis and kernel quirk
- [rodey](https://github.com/seanheiney/rodey) (MIT) — safety notes on the firmware-mode
  bytes and on never writing to guessed tree paths

Not affiliated with, endorsed by, or supported by RØDE or Elgato. RØDECaster and RØDE are
trademarks of their owner.

## License

MIT
