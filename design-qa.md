# Design QA — M3 Work Queue Preview

## Result: blocked

The selected operations-cockpit direction is implemented as a static web preview at
`/?preview=work-queue` and as the Electron default screen backed by the daemon's session
read-model. The remaining work is to migrate the opened-session views into the new visual
system; it is not ready to be handed off as a completed product redesign.

## Visual target and implementation evidence

- Selected visual target: `/Users/yklee/.codex/generated_images/01a0607c-02fb-7232-9610-85817241e55e/exec-a93e9b14-992c-4c04-9ebb-f466f0ef83f1.png`
- Browser implementation capture: `/var/folders/1m/9rlqwgl53dj69z2b3zv1rxbw0000gn/T/codex-shot-2026-09-02_23-08-21.png`
- Current state: selected work item, navigation, filter, detail panel, and status controls are interactive preview state only.

## Remaining issues

| Priority | Issue | Required follow-up |
| --- | --- | --- |
| P1 | The network preview uses static sample data; the actual queue is only available through the daemon-connected Electron entry point. | Define a safe remote read-model transport before making the live queue remotely available. |
| P1 | Opening a queue row still enters the legacy session conversation chrome. | Migrate session detail, permission, and terminal views into the selected visual system. |
| P2 | The implementation capture includes browser chrome and differs in viewport size from the reference image. | Capture matching viewports for final visual comparison. |
| P2 | The production bundle emits a 764 kB JavaScript chunk warning. | Code-split the preview and terminal-heavy routes before release. |
