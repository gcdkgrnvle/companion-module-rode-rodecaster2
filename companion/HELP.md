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
