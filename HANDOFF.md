# Handover: RØDECaster Companion module

Last updated: 2026-10-08 by Claude (first version, built from the repo history and Claude's notes)

## What it is
Lets Tony control his RØDECaster Pro II audio desk from Stream Deck through Bitfocus Companion on Linux. Buttons follow changes made on the desk itself.

## Where things stand
- Controls, individual headphone mute, the browser routing page and saved routing setups are implemented.
- The current branch is `codex/desk-api`; it adds a key-protected web interface for other apps, including full desk-state replies.
- Notes record this branch running as a Companion developer module on cachyos, with Stream Deck buttons using it (unverified).
- It is not in the Companion module store. Duo, macOS and Windows support remain untested; linked routing-level changes still need hardware checks.

## Decided
- 2026-10-04, Tony: reproduce the paid Mix Companion controls in Bitfocus Companion for Linux (project memory).
- 2026-10-08, Tony: make the Stream Deck buttons use the desk's web interface (project memory).

## Next
1. Confirm the documented USB freeze-prevention protection is active before further desk testing; keep the read loop running.
2. Check routing setups, linked levels, returning control to the desk's physical sliders, navigation and sound-pad playback with Tony, one hardware check at a time (waits for Tony).
3. After Tony accepts the routing page and web controls, merge their branches into `main` (waits for Tony).
4. Prepare module-store submission after the remaining hardware checks; keep untested platforms clearly labelled.

## Where to look
- `README.md`: features, routing page, web-interface use and development setup.
- `companion/HELP.md`: controls, installation and the USB freeze hazard.
- `docs/DESIGN.md`, `src/routing.js`, `test/`: verified desk behavior, saved setups and checks.
- Project memory: `/home/tony/.claude/memory/companion-module-rodecaster-project.md`.
