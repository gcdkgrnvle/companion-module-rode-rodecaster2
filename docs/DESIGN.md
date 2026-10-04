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
| Panic mute                    | all strips `channelOutputMute` + monitor mute, previous state remembered                                      | composed                                                                                         |
| Record / pause / stop         | `RECORDER.requestRecordState` 2 / 1 / 0                                                                       | `recordState` 0 ready, 1 paused, 2 recording, 3 no destination; elapsed time counted on the host |
| Drop marker                   | `RECORDER.requestDropMarker`                                                                                  | –                                                                                                |
| SMART pad                     | `PADBUTTON[slot].padButtonPressed` true then false (fallback: USB MIDI CC 35 with `SYSTEM.systemMidiControl`) | `PAD[n].padActive`, `padColourIndex`, `padName`                                                  |
| Pad bank                      | `GUI.selectedBank` 0-7                                                                                        | same                                                                                             |
| Voice FX                      | `EFFECTS_PARAMETERS[n].{reverbOn,echoOn,pitchShiftOn,distortionOn,robotOn,voiceDisguiseOn}`                   | same                                                                                             |
| Desk dial                     | `GUI.screenBrightness`, `GUI.activeButtonsBrightness`, `DUCKER.duckerDepth`, `OUTPUT.outputBTLevel`           | same                                                                                             |

Every write is verified by the desk's own push of the property; actions report failure when the
echo does not arrive within one second.

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
  monitor muted, headphones off, FX on, strip borrowed) with sensible default styles.
- Variables: per strip (`strip_N_name`, `_muted`, `_cued`, `_level_db`, `_control`), recorder
  (`record_state`, `record_elapsed`), monitor (`monitor_level_pct`, `_db`, `_muted`), pads
  (`pad_bank`, `pad_N_name`, `_active`), system (`firmware`, `model`).
- Presets: a ready-made button for every action, with feedback and variable text.
