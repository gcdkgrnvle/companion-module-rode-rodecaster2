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
