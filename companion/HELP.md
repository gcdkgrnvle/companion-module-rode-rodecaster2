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
