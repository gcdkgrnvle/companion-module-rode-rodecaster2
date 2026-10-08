## RØDECaster Pro II / Duo

Controls the desk over its own USB control protocol (the one RØDE Central uses), two-way:
move a fader or press a mute on the desk and the buttons follow.

### Connection

- Connect the desk's **USB 1** port (the one next to the power inlet) to the Companion machine.
  USB 2 carries audio only.
- Firmware 1.7.3 or later. The desk is found automatically; set a serial number in the
  connection config only when more than one desk is attached.
- RØDE Central and the RØDECaster app may stay open; the desk is shared, not seized.

### Linux

1. Give your user access to the desk's HID node. Copy `udev/50-rodecaster.rules` from the
   module repository to `/etc/udev/rules.d/` (it uses the `companion` group), then run
   `sudo udevadm control --reload && sudo udevadm trigger`.
2. Add `usbhid.quirks=0x19f7:0x0037:0x00000400` to the kernel command line (replace `0x0037`
   with the product ID shown by `lsusb -d 19f7:`) and reboot. The desk's firmware freezes its
   physical controls when a control session is open and nothing reads it; this quirk keeps the
   kernel reading at all times, so stopping Companion can never freeze the desk. Without it,
   replug the USB cable if the desk ever stops responding after Companion was stopped.

### Routing page

Open [http://127.0.0.1:8000/instance/rodecaster2/](http://127.0.0.1:8000/instance/rodecaster2/)
on the computer running Companion. Replace `rodecaster2` with this connection's label when
different. The page uses Companion's existing web server and works without internet access.

- **Desk view:** use the output arrows to select headphones, Monitor, Recording, Bluetooth,
  USB or CallMe. Only sources assigned to faders appear, once each; empty faders are skipped.
  **Main Mix** and **Mix-minus** show read-only columns. Choose **Custom** to edit them.
  Mix-minus is offered only for Bluetooth, USB 1, USB 1 Chat and USB 2. CallMe outputs have no
  mode tabs on firmware 1.7.3 and remain read-only.
- Drag a slider, use the mouse wheel, or focus it and use the arrow keys to change its level.
  Wheel and arrow steps are 1%. The white handle is the send level, the thin grey marker is
  its fader anchor, and the blue bar shows their difference. Linked sends can have an offset
  too. Pressing the bottom button cycles **white chain → orange broken chain → red X → white
  chain** (linked → unlinked → off → linked). Linking again snaps the level back to its anchor.
- **Overview:** outputs are columns and assigned sources are rows. Each cell shows its state
  and level percentage. Click a cell to cycle its state while that output is Custom; click an
  output heading to open it in Desk view.
- Changes are sent immediately. The page follows changes made on the desk about every 300 ms
  without moving a slider during a drag. **Desk disconnected** disables editing until the
  connection returns. Routing edits do not require the channel-level-control option below.
- **Save as…** captures every source on every output, including sources not assigned to a
  fader. **Load** applies the differences, **Rename** keeps existing button references working,
  and **Delete** asks for confirmation. Saved routing presets stay in this connection's
  settings across Companion restarts. They store output modes, link/unlink/off states and
  levels; they do not store fader assignments, anchors or separate mute controls.
- For a Stream Deck button, drag a saved setup from Companion's **Routing** presets, or add
  **Routing: load preset** and choose its name. **Routing preset active** feedback turns the
  template green when all modes, states and levels match (within half a percentage point for
  levels). `$(rodecaster2:routing_preset)` gives the matching name, or empty if none matches or
  the desk is disconnected. If several saved setups match, the first saved one supplies the
  variable name.

The cell-state sequences and the desk-screen response were verified on Tony's Pro II running
firmware 1.7.3. Host level writes were verified on an unlinked send; the desk itself also writes
offsets on linked sends. Output mode values are proven reads, but **host output-mode writes
still need separate hardware testing**. No hardware testing was performed for this page.

### HTTP API

Enable **HTTP API** in this connection's settings and enter a secret **API key**. The default
bind address, `0.0.0.0`, accepts connections on the Companion computer's network interfaces;
the default port is `8765`. The API is disabled by default and refuses to start without a key.
Saving changes starts, stops or restarts its server. Use a different port for each connection
if more than one instance enables the API.

The module runs its own server for `/api/v1`. Companion's existing administration server
must stay on `127.0.0.1:8000` because it has no authentication. The routing page remains on
that local server and is not exposed by this API. Limit API access to the trusted home LAN;
HTTP does not encrypt the key.

Add `?return=state` to any successful call to get the whole desk state back instead of just the
changed resource (the same body as `GET /api/v1/state`). A Companion setup can store that answer in
one custom variable and colour every button from it with `jsonpath()` expressions.

Tony's desktop uses ufw. If needed, Tony can allow this port only from the home subnet with
the following command. The module does not change firewall settings:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8765 proto tcp
```

Replace `companion-host` below with the Companion computer's LAN address and change `8765`
if a different port was configured. Open `http://companion-host:8765/api/v1/docs` for the full
reference, including every route, request body and curl example. This page works without
internet access. `GET /api/v1/health` also needs no key and returns `{"ok":true,"connected":true}`
when the desk is connected. Both public routes remain available when the desk disconnects.

Every other route, including `GET /api/v1/openapi.json`, needs either
`Authorization: Bearer <key>` or `X-API-Key: <key>`. Keep the key in the caller's settings or
environment; query-string keys are never accepted. Set `RODE_API_KEY` to the configured key
before using these examples:

```bash
export RODE_API_URL='http://companion-host:8765/api/v1'
curl -sS "$RODE_API_URL/state" -H "Authorization: Bearer $RODE_API_KEY"
curl -sS -X PUT "$RODE_API_URL/strips/1/mute" \
  -H "Authorization: Bearer $RODE_API_KEY" -H 'Content-Type: application/json' \
  --data '{"value":"toggle"}'
curl -sS -X PUT "$RODE_API_URL/headphones/3/mute" \
  -H "X-API-Key: $RODE_API_KEY" -H 'Content-Type: application/json' \
  --data '{"value":true}'
curl -sS -X PATCH "$RODE_API_URL/routing/outputs/hp3/sources/mic1" \
  -H "Authorization: Bearer $RODE_API_KEY" -H 'Content-Type: application/json' \
  --data '{"ensureCustom":true,"state":"unlink","level":0.5}'
curl -sS -X POST "$RODE_API_URL/recorder/record" -H "Authorization: Bearer $RODE_API_KEY"
```

API conventions:

- Strip numbers in URLs are **one-based** (`/strips/1` is Companion strip 1), as are headphone
  jacks 1-4, pad slots/banks 1-8 and voice FX slots. Routing output/source numbers use the
  protocol's **zero-based** indexes; use names to avoid confusion. Outputs accept
  `headphone1`-`headphone4`/`hp1`-`hp4`, `speaker`/`monitor`, `recording`/`rec`, `bluetooth`/`bt`,
  `usb1`, `chat`, `usb2` and `callme1`-`callme3`. Sources accept `combo1`-`combo4`/`mic1`-`mic4`,
  the stereo combo sources, `usb1`, `chat`, `usb2`, `bluetooth`, `soundpad`/`pads`, `game`,
  `music`, `virtuala`, `virtualb` and `callme1`-`callme3`. Availability follows the connected
  desk's layout. Replies include indexes and canonical names.
- On/off controls accept `{"value":true}`, `{"value":false}`, `{"value":"on"}`,
  `{"value":"off"}` or `{"value":"toggle"}`. A toggle uses the current device model state.
- Level controls accept either `{"level":0.5}` (0..1) or `{"delta":-0.05}` (-1..1); deltas
  are clamped to the level range. Strip level changes require **Let Companion drive channel
  levels** and borrow faders exactly as Companion actions do. `POST /api/v1/strips/restore`
  restores all borrowed faders.
- Routing mode accepts `main`, `mixminus`, `custom` or 0, 1, 2. Routing cell edits require
  **Custom** mode; `"ensureCustom":true` switches first. Cell state is `link`, `unlink` or
  `off`, and its level is 0..1. Saved routing presets can be saved, loaded, renamed and
  deleted under `/routing/presets`; preset URLs accept an ID or a URL-encoded name.
- Other resource families are `/monitor`, `/headphones`, `/bluetooth`, `/recorder`, `/pads`,
  `/fx` and `/panic`. Display writes use `/display/screen-brightness` and
  `/display/button-brightness` with `{"value":128}` (0..255) or `{"pct":50}` (0..100).
  `/ducker/depth` accepts `{"value":-20}` in dB (-60..0). `GET /state` collects every resource,
  including display and ducker settings, in one response.

Every successful read and write returns the affected resource's resulting JSON state. A
strip mute response, for example, includes `strip`, `name`, `source`, `muted`, `listen`,
`level`, `levelPct` and `fader`. A headphone write returns `allOff` and the full `mixes` list;
a routing write returns its output or source cell. A deleted preset returns the remaining
preset list and matching name. Property writes update the module's model optimistically
because the desk does not echo host writes; the response does not independently prove
physical hardware behavior. Pad playback changes can arrive after the press reply; recorder
elapsed time is counted by the module.

For a Stream Deck plugin or Home Assistant control, set the button state from the returned
field, such as `muted`, `listen` or panic's `active`. Poll the corresponding GET route to
follow changes made on the desk or by other clients. No CORS headers are sent.

Errors are JSON `{"error":"message"}`: 400 for invalid input or a routing edit outside
Custom mode, 401 for a missing/wrong key, 404 for an unknown route/preset, 409 for disabled
channel level control or a duplicate preset name, 413 for a body larger than 64 KiB
(65,536 bytes), and 503 with `{"error":"desk disconnected"}` when the desk is disconnected.

### Channel level control

Ships switched off. The desk has no writable fader level; to move a level this module must
unlink the strip's sends from the physical fader for as long as it drives them. Touching the
physical fader, holding the volume dial, or the **Restore faders** action hands the strip back.
If Companion dies while a strip is borrowed, the next start relinks it. The chain icons in the
RØDE app toggle the very same setting, so a fader can always be restored by hand.

### What the actions do on the desk

- **Channel: Mute / Cue** write the strip's own mute and cue; the desk's LEDs follow.
- **Channel: Volume up / down, Set volume** need _Let Companion drive channel levels_ ticked.
  The strip is borrowed from its physical fader (every send that was linked is unlinked), the
  sends are driven together, and the strip reads DIAL. Moving the physical fader, _Hand back
  to fader_ or _Restore all faders_ relinks them. Sends you disabled or unlinked yourself are
  never touched.
- **Monitor** level and mute drive the rear speaker outputs. The default method writes the
  level; _Emulate the big knob_ sends encoder ticks instead (only while the desk's knob is
  assigned to the monitor).
- **Headphones: All off** silences every headphone jack at once.
- **Headphones: Mute one headphone mix** mutes only the selected headphone output (1-4),
  for example a speaker connected to Headphone 3. Pick **Toggle** for one-press mute/unmute,
  or use the **HP1 MUTE** through **HP4 MUTE** presets under **Monitoring**. The button turns
  red when every enabled send into that output is muted. Disabled sends and other outputs
  stay unchanged. Unmuting restores only the sends Companion muted; anything already muted
  by hand stays muted. This memory survives a Companion restart. If no saved mute record
  exists (for example, everything was muted on the desk), unmuting clears all enabled sends
  into that output. Level control does not need to be enabled. The action leaves sends linked;
  mute behavior on linked sends is still unverified on hardware.
- **Panic mute** mutes every strip, the monitor, Bluetooth and all headphones; releasing it
  restores exactly what was unmuted before and leaves individual headphone mix mutes alone.
  (The desk's own emergency-mute flag does nothing audible on firmware 1.7.3, so it is not used.)
- **Record** starts, pauses and stops the desk's recorder; the elapsed time is counted by
  Companion because the desk does not report it. **Drop marker** adds a cue point.
- **SMART pad: Press** presses pad 1-8 of the current bank, or switches to a pinned bank
  first. Pad names, colours and active state come from the desk.
- **Voice FX** toggles reverb, echo, pitch, distortion, robot or disguise per effect slot.
- **Desk** actions set screen and button brightness and the ducker depth.

### Variables

Strip names default to the input source (Mic 1, USB 1, Chat, ...); set _Strip names_ in the
connection config to rename them. Levels are shown as percent and as an approximate dB value
(0 dB at the fader's unity detent, position 90 of 127).

`headphone1_muted` through `headphone4_muted` show whether every enabled send into each
headphone mix is muted. They follow changes made by Companion and on the desk.

`routing_preset` contains the name of a saved setup matching the current routing, or empty
when no setup matches or the desk is disconnected.
