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
