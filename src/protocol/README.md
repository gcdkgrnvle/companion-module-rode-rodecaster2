# RODECaster Pro II / Duo protocol core

Plain JavaScript (Node 22, ESM, no runtime dependencies) port of the protocol
core of the MIT-licensed Rust crate
[`rodecaster-protocol`](https://github.com/Yeradon/rodecaster-protocol)
(Copyright (c) 2026 Yeradon). All wire-format knowledge here (JUCE `var` and
`ValueTree` encodings, `ValueTreeSynchroniser` change frames, the HID report
framing, the handshake bytes, node-family discovery and the name tables) comes
from that crate, cross-checked against rcp2-cli's `rcp2-protocol`,
rodecasterpro2-linux's `rcp2-proto` and AccessCaster's `RODECASTER_PROTOCOL.txt`.
Nothing here talks to a device; the module owner wires in the HID transport.

This directory carries its own `package.json` (`"type": "module"`) so these
files are ESM even though the surrounding template is CommonJS. Import with
`import { ProtocolSession } from './protocol/index.js'` (or `await import()`
from CommonJS).

## Files

| File              | What it does                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `juce-var.js`     | JUCE `var` codec: compressed ints, NUL-terminated strings, and tagged values (`{type:'int', value}` etc., int64 as BigInt). `readValue`/`writeValue` over a `{pos}` cursor, `encodeValue`/`decodeValue`, `V.*` constructors, `asInt`/`asBool`/`asString`, `valueEquals`.                                                                                 |
| `valuetree.js`    | `ValueTree` (type, ordered `properties` Map, `children` array): `parse`/`write` in `ValueTree::writeToStream` form, `fromFullSync`, `getByPath`, `findChild(ren)`, `countConsecutive`, `applyChange(record)` returning `{path, name, oldValue, value}` (also applies structural records), `encodePropertyChange`.                                        |
| `change-frame.js` | `ValueTreeSynchroniser` change records: `decodeChangeFrame(body)` (null on anything but one exact frame) and `encodePropertyChanged` / `encodePropertyRemoved` / `encodeFullSync` / `encodeChild*`.                                                                                                                                                      |
| `usb.js`          | HID framing: `encodeReports(body)` -> 256-byte report-3 reports, `scanFrame`/`packetFromBytes`, and `Reassembler.push(report) -> bodies[]` for inbound report-4 streams (report-2 ACKs counted, other IDs ignored).                                                                                                                                      |
| `trigger.js`      | The two-boolean momentary pulse (`01 01 02 01 01 02` press / `01 01 03 01 01 03` release) used by `mixLinkRequest` and friends.                                                                                                                                                                                                                          |
| `names.js`        | Vocabulary: `DeviceModel`, `Fader` (per-model index map), `Source` (19), `MixOutput` (13), and the per-node parameter-name families (`ChannelParam`, `SystemParam`, ...; generated from the crate's `names/*.rs`).                                                                                                                                       |
| `layout.js`       | `Layout.fromFullSync(root)`: discovers where CHANNEL, FADER (under PHYSICALINTERFACE), the MIX matrix (13 per source), INPUTSOURCE, HEADPHONE, EFFECTS_PARAMETERS, PAD (under SOUNDPADS), the singletons (OUTPUT, RECORDER, GUI, SYSTEM, ...) and the remaining runs live; path <-> ordinal translation. Throws `LayoutError` on missing required nodes. |
| `capabilities.js` | `discoverCapabilities(root, layout)`: model, firmware, fader/source/mix lists, counts, setup-mode flag.                                                                                                                                                                                                                                                  |
| `commands.js`     | `encodeCommand({type, ...}, layout) -> Buffer[]` bodies for every command of the crate (fader mute/cue/level/source, mix cell disable/mute/link/unlink/level, screenTouched, powerOff, CallMe link/unlink, every `set*Param`, setupSkip). Throws `EncodeError`.                                                                                          |
| `events.js`       | `decodeEvent(body, layout)` / `decodeEventFromFrame` -> `{type, ...}` events in the crate's exact precedence order; `extractInitialState(root, layout)`.                                                                                                                                                                                                 |
| `session.js`      | Handshake bytes (`modeNormalReport()`, `sessionOpenReport()`, `handshakeReports()`) and `ProtocolSession` (EventEmitter): `ingest(body)` builds the tree on fullSync, applies property changes, emits `ready` / `event` / `change` / `needsFullSync`; `encode(command)` / `encodeReports(command)`.                                                      |
| `index.js`        | Barrel re-export of everything above.                                                                                                                                                                                                                                                                                                                    |

## Wire facts (confirmed from the sources)

- Property reports are 256 bytes: report ID (0x03 host->device, 0x04 device->host) + 255 data bytes. The command path (report 0x01 out, 0x02 in) uses 64-byte reports.
- A message is `[u32 LE body length][body]`; the length counts the body only. The framed message is sliced into 255-byte pieces, each prefixed with the report ID; the last report is zero-padded. Continuation reports carry no sub-header, so a body of length L spans `ceil((4 + L) / 255)` reports and every message starts on a report boundary.
- Handshake: report 1 `01 4E` (ASCII `'N'`, normal mode; never send `0x4D`/`0x55`, they enter firmware-update mode), pause ~200 ms, then report 3 `03 04 00 00 00 AD 10 A7 B0` zero-padded. The device answers on report 2 (`02 41 ...`, `'A'` = ACK) and streams the fullSync on report 4.
- A change frame starts with the change type (1 propertyChanged, 2 fullSync, 3 childAdded, 4 childRemoved, 5 childMoved, 6 propertyRemoved), then the compressed-int path (`depth`, then one compressed int per level), then the type-specific payload. JUCE compressed ints: one size byte (low 7 bits = byte count, max 4; high bit = negative) then that many LE bytes.
- `juce::var`: compressed-int frame length (`1 + payload`), marker byte (0x01 int32 LE, 0x02 true, 0x03 false, 0x04 double LE, 0x05 UTF-8 + NUL, 0x06 int64 LE, 0x07 array = compressed count + values, 0x08 binary, 0x09 undefined), payload. A zero-length frame is a void var.

## Values and numbers

Mix levels (`mixLevelWithAnchor`, `"anchor|value"`) are parsed as JS doubles
(the crate uses f32) and written with one decimal like the crate's
`format!("{:.1}|{:.1}")`. 64-bit ints are BigInt on decode; `asInt` returns a
number when it is a safe integer.

## Tests

`node --test test/` runs everything under `test/protocol/`. The Duo fw 1.7.4
full-sync fixture under `test/fixtures/` is copied from the crate (MIT; see
`test/fixtures/NOTICE`). It is a TCP transport frame
(`[u32 LE magic 0xF2B49E2C][u32 LE length][body]`); the tests strip the 8-byte
header and feed the body to the same code the USB path uses.
