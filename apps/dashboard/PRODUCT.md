# Product

<!-- impeccable:product-schema 1 -->

> Inferred from the task brief: no interview channel was available when this was written. Every fact below is an assumption until the owner confirms it.

## Platform

web

## Users

One person, the owner of the Amazon account, running "Jarvis" at home on their own machine. They open the dashboard on a desktop browser or a phone on the home network to check which Echo speakers are reachable and to make one of them say something.

## Product Purpose

Jarvis is a personal home assistant. The dashboard is its control surface. The first module talks to Alexa: list the Echo devices, see which are online and which is the default, and send text for an Echo to speak. Success is a sentence leaving the browser and the owner trusting what the screen says about it.

## Positioning

Not a smart-home app. It is a single-owner console that tells the truth about delivery: Amazon accepts the speech request, but playback is never confirmed, and the interface says exactly that.

## Operating Context

- Runs locally with Bun; config comes from `AI_VOICE_*` environment variables.
- The Amazon session is created once from the terminal (`bun apps/mcp/src/main.ts login`) and stored on disk.
- Speech can be disabled by config; the UI must show that rather than fail.
- Future modules plan to join the same shell: lembretes, agenda, mapas, ligações. They do not exist yet and must not be faked.

## Capabilities and Constraints

- Devices: name, serial, online, isDefault.
- Speak: text up to 4000 characters, optional target device, result is "accepted" with chunk count and `playbackConfirmed: false`.
- Errors are tagged (session, device, speech) and carry a safe message meant for display.
- UI copy is Brazilian Portuguese.

## Evidence on Hand

Only live data from the owner's Amazon account. No sample devices, metrics, or history may be fabricated.

## Product Principles

1. Say what is true about delivery; never imply the Echo played the audio.
2. Every state has a face: no session, speech off, device offline, sending, accepted, failed.
3. The shell grows by modules; an empty slot is honest, a fake widget is not.
4. One person, one glance: the default device and the composer are reachable immediately.

## Accessibility & Inclusion

Keyboard operable, visible focus, WCAG AA contrast in light and dark themes, respects reduced motion, works at phone width.
