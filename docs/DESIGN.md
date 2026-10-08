# Design

Companion module for the RØDECaster Pro II (and, untested, the Duo) over the desk's USB HID
control channel. Feature target: the 18 actions of the commercial Elgato plugin "Mix Companion",
on Linux, inside Bitfocus Companion.

## Transport

- USB interface 9, vendor HID (usage page `0xFF00`, usage 1). Reports: `1` OUT 63 B mode byte
  (only ever `0x4E` 'N'), `2` IN 63 B ACK (`'A' + product name`), `3` OUT 255 B, `4` IN 255 B.
- Session open: report 3 body `04 00 00 00 AD 10 A7 B0`. The desk answers with a FullSync
  (~112 KB in 440 reports on firmware 1.7.3) and then pushes every change unsolicited.
- Bodies are `u32 LE length + payload`, chunked over 255-byte report payloads.
- `node-hid` (hidraw backend, `HIDAsync`). The desk is found by vendor `0x19f7` + interface 9;
  the product ID changes with firmware (`0x0037` on 1.7.3), so it is never hard-coded.
- The read loop must never stop while a session is open: the firmware blocks on its next push
  when nobody reads and the physical controls freeze until the cable is replugged. On Linux the
  kernel quirk `usbhid.quirks=0x19f7:<pid>:0x00000400` (`HID_QUIRK_ALWAYS_POLL`) makes this
  impossible; the module keeps reading regardless, and `HELP.md` documents the quirk.

## State model

`src/protocol/` (ported from the MIT crate `rodecaster-protocol`) keeps a `ValueTree` mirror of
the desk. On FullSync the module discovers the layout at runtime, never from a shipped table:

- strips: `CHANNEL[i]` with `channelInputSource` (-1 empty, 0-3 mics, 7 USB1, 8 chat, 9 USB2,
  10 Bluetooth, 11 pads, …) and their physical `FADER[i]`
- pads: `SOUNDPADS/PAD[n]` (`padIdx`, `padName`, `padColourIndex`, `padActive`), bank =
  `GUI.selectedBank`
- effect slots: `EFFECTS_PARAMETERS[n]`
- mix matrix: `MIX` cells indexed `13 * source + output` (`mixLink`, `mixLevelWithAnchor`,
  `mixMute`, `mixDisabled`), outputs `MIXMINUSES[o]`
- recorder, output, system, GUI, ducker

If any part of the strip/matrix read is inconsistent, level control is disabled for the session
and reported in the connection status (same rule as the commercial plugin: a wrong map would
drive the wrong channel).

## Feature to property map

| Feature                       | Write                                                                                                         | Read / feedback                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Channel mute                  | `CHANNEL[s].channelOutputMute`                                                                                | same (+ desk `mutePressed` pushes)                                                               |
| Cue                           | `CHANNEL[s].channelCueEnable`                                                                                 | same                                                                                             |
| Channel level (dial, up/down) | unlink the strip's linked sends (`mixUnlinkRequest`), then `mixLevelWithAnchor` on each; opt-in               | `mixLink`, `mixLevelWithAnchor`, `FADER[s].faderLevel`                                           |
| Restore faders                | `mixLinkRequest` on every send this module unlinked                                                           | `mixLink`                                                                                        |
| Monitor level / mute          | `OUTPUT.outputMonLevel` (0-1), `OUTPUT.outputMonMute`                                                         | same                                                                                             |
| Headphones off                | `SYSTEM.disableAllHeadphoneOutputs`                                                                           | same                                                                                             |
| One headphone mix mute        | `MIX[source * 13 + (headphone - 1)].mixMute` on enabled sends only                                            | all enabled sends into that headphone bus muted                                                  |
| Panic mute                    | all strips `channelOutputMute` + monitor mute, previous state remembered                                      | composed                                                                                         |
| Record / pause / stop         | `RECORDER.requestRecordState` 2 / 1 / 0                                                                       | `recordState` 0 ready, 1 paused, 2 recording, 3 no destination; elapsed time counted on the host |
| Drop marker                   | `RECORDER.requestDropMarker`                                                                                  | –                                                                                                |
| SMART pad                     | `PADBUTTON[slot].padButtonPressed` true then false (fallback: USB MIDI CC 35 with `SYSTEM.systemMidiControl`) | `PAD[n].padActive`, `padColourIndex`, `padName`                                                  |
| Pad bank                      | `GUI.selectedBank` 0-7                                                                                        | same                                                                                             |
| Voice FX                      | `EFFECTS_PARAMETERS[n].{reverbOn,echoOn,pitchShiftOn,distortionOn,robotOn,voiceDisguiseOn}`                   | same                                                                                             |
| Desk dial                     | `GUI.screenBrightness`, `GUI.activeButtonsBrightness`, `DUCKER.duckerDepth`, `OUTPUT.outputBTLevel`           | same                                                                                             |

The desk does not echo host writes. Successful writes update the local tree optimistically;
desk-originated changes update the same tree and refresh the relevant feedbacks and variables.

## Routing page and presets

The module serves a single HTML file with inline CSS and JavaScript at `GET /` and
`GET /index.html` under Companion's `/instance/<label>/` handler. All API URLs are relative
to that connection. The example URL is
`http://127.0.0.1:8000/instance/rodecaster2/`. No separate server, CDN or build step is used.

### Verified routing facts

Captured on Tony's Pro II, firmware 1.7.3, on 2026-10-08. These observations predate the
routing-page implementation; no hardware was accessed while building it.

- `MIXMINUSES[o].outputMixMinus` is Int32: `0` Main Mix, `1` Mix-minus, `2` Custom. CallMe
  outputs 10-12 have no mode node (`null`). Reads and host writes are hardware-verified (USB 1, output 7: the desk's tab followed each
  write, and Main → Mix-minus → Custom kept custom cell states and levels).
- Each source/output button cycles linked → unlinked → off (red X) → linked. The host
  sequences in `src/routing.js` `setCellState` are hardware-verified and update the desk's
  screen. Their property order is preserved. Linking again snaps level to the anchor; the
  desk pushes `mixLevelWithAnchor` as `"anchor|anchor"`.
- `mixLevelWithAnchor` carries `"level|anchor"`, each from 0 to 1. The desk writes send levels
  even when linked, retaining an offset from the fader anchor. Its screen shows a blue bar
  between the anchor marker and level handle. Host writes were verified on an unlinked send.
  The desk encoder's step is 0.01.
- Desk changes arrive through `device.onChange`, updating the local tree. `GET /routing`
  returns `{ ready, outputs: [{ output, mode, modeName, cells: [{ source, level, anchor,
link, disabled, mute }] }], strips: [{ strip, source }] }`. Strip source `-1` is empty.
- The desk shows one column per fader-assigned source, in strip order, deduplicated and
  skipping `-1`. Mix-minus tabs exist for Bluetooth, USB 1, USB 1 Chat and USB 2. CallMe tab
  support is uncertain, so no tabs are shown where mode is `null`. Columns are dimmed and
  read-only unless the output is Custom.
- The reference screen uses a back arrow, output icon with previous/next arrows, and home;
  dark rounded columns, white handles, thin grey anchor markers, blue offset bars, source
  icons/labels, and bottom buttons: white chain (linked), orange broken chain (unlinked),
  red X (off). Off columns are dimmed.

The exact protocol order below is checked against `Source` and `MixOutput` in
`src/protocol/names.js` (there is no `src/names.js`). `mic1` through `mic4` are aliases for the
actual IDs `combo1` through `combo4`; indices agree with the captured routing facts.

| Source index | Protocol ID                             | Page label                        |
| ------------ | --------------------------------------- | --------------------------------- |
| 0-3          | `combo1`-`combo4`                       | Mic 1-4                           |
| 4-6          | `combo12`, `combo23`, `combo34`         | Combo 1+2, 2+3, 3+4               |
| 7            | `usb1`                                  | USB 1                             |
| 8            | `chat`                                  | USB 1 Chat                        |
| 9            | `usb2`                                  | USB 2                             |
| 10           | `bluetooth`                             | Bluetooth                         |
| 11           | `soundpad`                              | Pads                              |
| 12-15        | `game`, `music`, `virtuala`, `virtualb` | Game, Music, Virtual A, Virtual B |
| 16-18        | `callme1`-`callme3`                     | CallMe 1-3                        |

| Output index | Protocol ID               | Page label    |
| ------------ | ------------------------- | ------------- |
| 0-3          | `headphone1`-`headphone4` | Headphone 1-4 |
| 4            | `speaker`                 | Monitor       |
| 5            | `recording`               | Recording     |
| 6            | `bluetooth`               | Bluetooth     |
| 7            | `usb1`                    | USB 1         |
| 8            | `chat`                    | USB 1 Chat    |
| 9            | `usb2`                    | USB 2         |
| 10-12        | `callme1`-`callme3`       | CallMe 1-3    |

### Browser behavior and HTTP API

Desk view displays one output and Overview displays outputs by fader-assigned sources.
The page polls routing approximately every 300 ms, retains local slider values during a
drag, and throttles writes to at most one per 60 ms per cell, retaining the final value on
release. Wheel and keyboard steps are 0.01. Disconnection disables controls.

| Method and relative path         | Request / result                                                         |
| -------------------------------- | ------------------------------------------------------------------------ |
| `GET routing`                    | Routing snapshot, including `ready`                                      |
| `POST routing/mode`              | `{ output, mode }`                                                       |
| `POST routing/cell`              | `{ source, output, state?, level? }`; state is `link`, `unlink` or `off` |
| `GET routing/presets`            | `{ presets: [{ id, name }], active }`                                    |
| `POST routing/presets`           | `{ name }`: save the current routing                                     |
| `POST routing/presets/<id>`      | `{ name }`: rename without changing the stable ID                        |
| `POST routing/presets/<id>/load` | `{}`: load                                                               |
| `DELETE routing/presets/<id>`    | Delete; the page requests confirmation                                   |

Inputs are validated before writes: integer source/output indices in range, valid modes and
state enums, finite levels in 0..1 and nonempty preset names. Mutations reject a desk that is
not ready. The routing read still reports `ready: false` for the disconnected screen.

### Persistence and application order

Saved presets live in the connection config, alongside the existing recovery fields. Each
stores every output's mode and every source's state (linked, unlinked or off) and level,
including sources absent from the page's assigned-fader view. Anchors, strip assignments and
separate mute controls are not preset data. Stable IDs keep Companion button references
valid across renames. Preset changes rebuild Companion action/feedback choices and the
**Routing** template section.

One routing queue serializes complete preset loads and page writes so slider changes cannot
interleave with a load. A load writes only differences, output by output:

1. If either current or target mode is Custom, ensure Custom before cell changes.
2. Apply cell states (off changes may precede link changes).
3. Apply levels after link changes, accounting for relinking snapping back to the anchor.
4. Apply the target mode last. Outputs without a mode node never receive mode writes.

`Routing preset active` matches all modes and states and permits an absolute level difference
of at most 0.005. Disconnected desks never match. `routing_preset` is the first matching
saved preset's name, or empty. Strip, monitor, system and routing updates refresh this value
and the active feedback; complete updates rebuild definitions too.

## Individual headphone mix mute

- `headphone_mix_mute` selects Headphone 1-4 (mix outputs 0-3), with on, off and toggle modes.
  It writes only that output's `mixMute` cells and skips disabled sends. Other outputs, levels
  and link settings remain unchanged; channel level control does not need to be enabled.
- Before each mute write, the module saves that send in the connection config's
  `headphoneMixMutes` record. This keeps recovery possible after a crash or a write error that
  may have reached the desk. Unmuting restores only recorded sends, including after a
  Companion restart, so sends already muted by hand stay muted. Failed restores and sends
  disabled since the mute stay recorded for a later restore. If no saved record exists,
  unmute clears the mute on every non-disabled send into that headphone bus.
- `mixMute` is written directly, without `mixUnlinkRequest`.
  [rodecaster-protocol encodes a single mute-property write, with unlink as a separate command](https://github.com/Yeradon/rodecaster-protocol/blob/9373ccecb7ec9b03b398b2214515b4b2a0ef3ddb/src/commands.rs#L392-L420).
  [rodey reports changing one mix cell with a direct write](https://github.com/seanheiney/rodey/blob/bc3e70ab3045561ad9d18d39a4b832ff65b7f342/docs/PROTOCOL.md#L233-L259),
  but does not state whether it was linked. Neither establishes the audible effect on linked
  sends, so linked-send behavior remains unverified; direct writes preserve existing links.
- Panic uses strip/output controls separately from these mix cells. Releasing panic leaves a
  headphone mix muted by this action alone.
- `headphone_mix_muted` feedback and `headphone1_muted` through `headphone4_muted` variables
  report true when every non-disabled send into that bus is muted. Desk `mixMute` changes
  refresh the monitoring state, as do this module's writes. Monitoring presets provide
  `headphone1_mute` through `headphone4_mute` toggle buttons with red mute feedback.

## Level control safety

- Off by default (`Let Companion drive channel levels` in the connection config). Until enabled
  the level actions and presets show `LOCKED`.
- The module records every send it unlinks in the connection's persisted config
  (`unlinkedSends`) before writing, so a restart or crash can relink on next start.
- A hand on the physical fader wins: when `FADER[s].faderLevel` changes while the strip is
  borrowed, the module relinks that strip.
- Hold `Restore faders` for one second to relink everything. The desk's own chain icons do the
  same without this module.
- Sends the user disabled in the RØDE app (`mixDisabled` true or already unlinked before we
  touched them) are never relinked or enabled by the module.

## Companion surface

- Config: device serial (auto), level control opt-in, strip name overrides.
- Actions: one per feature above, strip/pad/slot choices built from the discovered layout.
- Feedbacks: boolean per state (muted, cued, recording, paused, pad active, bank selected,
  monitor muted, headphone mix muted, headphones off, FX on, strip borrowed) with sensible
  default styles.
- Variables: per strip (`strip_N_name`, `_muted`, `_cued`, `_level_db`, `_control`), recorder
  (`record_state`, `record_elapsed`), monitor (`monitor_level_pct`, `_db`, `_muted`), headphones
  (`headphone1_muted` through `headphone4_muted`), pads (`pad_bank`, `pad_N_name`, `_active`),
  system (`firmware`, `model`).
- Presets: a ready-made button for every action, with feedback and variable text.
