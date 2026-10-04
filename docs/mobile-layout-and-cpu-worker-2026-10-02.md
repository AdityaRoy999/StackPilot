# Mobile layout and CPU browser worker

The dashboard uses the full phone width. Below 640px the sidebar becomes a
labelled navigation drawer, with workspace switching, a scrollable menu, theme,
and logout. Desktop sidebar preferences remain separate from opening the phone
drawer. Selecting a destination closes the drawer.

Project search and creation controls stack on phones. Long project names and
card actions wrap, repositories truncate within their cards, and the shared
card/table containers can shrink within their parent. Phone controls have 44px
minimum tap targets; input text uses 16px to avoid focus zoom. The shell uses
dynamic viewport height and safe-area insets, and the viewport requests content
resize when the software keyboard appears (browser support varies).

The AI toolbar keeps accessible icon labels on narrow screens. Messages and
the composer have smaller phone gutters. The browser address bar moves to its
own row on phones, the console header wraps, and floating terminal bounds fit
the phone viewport. Dialogs have phone viewport limits and avoid background
blur on phones. React Query's development toggle is only mounted above the
phone breakpoint, so it cannot cover phone card controls.

## Validation

- TypeScript compilation and 12 existing project/browser component tests pass.
- Owned Chromium layout checks use synthetic project/API data; no login,
  production cookies, deployments, provider calls, or user data changes.
- Project breakpoints: 320x740, 390x844, 768x1024, 844x390, 1280x800.
- Phone checks: deployments, secrets, organization, settings, monitoring, AI.
- Assertions cover document/main overflow, project card bounds, hidden phone
  rail, 44px search field, drawer navigation, project-dialog bounds, and Escape.
- Screenshots and measurements: `screenshots/mobile-2026-10-02/` and
  `mobile-layout-qualification-2026-10-02.json`.
- After the final development-toggle change, a frontend-only restart recovered
  a stalled development recompilation. The five project breakpoints, phone
  button sizes, project dialogs, Escape, and drawer navigation passed again;
  measurements are in `mobile-layout-final-projects-2026-10-02.json`.

These are emulated browser layout checks. Physical iOS/Android keyboard,
display cutout, touch input, and streamed-video FPS still require device tests.
Empty-list API fixtures on the secondary pages are not full backend workflow
qualification.

## CPU-only remote worker option

Use **m7i.large**, with **2 vCPUs / 8 GiB RAM**, ordinary **Ubuntu Server
24.04 LTS x86_64**, and 50 GiB gp3 storage for an initial single-browser test.
Use Spot if at least two vCPUs are available in the region's **All Standard
(A, C, D, H, I, M, R, T, Z) Spot Instance Requests** quota. This is separate from
the GPU quota. Keep SSH restricted to My IP; browser control/stream ports stay
private. AWS's regional account-verification hold still applies.

The regular M7i family is preferable here to a burstable T instance for
continuous CPU capture/encoding. Configure the CPU browser image and libx264
encoding, without NVIDIA runtime requirements. Start with one browser at 720p
and measure presentation rate, frame pacing, and input latency under load;
reduce resolution/frame rate if necessary. A 2-vCPU CPU worker is not evidence
of 60 FPS support. No remote CPU instance has been provisioned or measured yet.

Sources:

- [AWS general purpose instance specifications](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html)
- [AWS M7i instances](https://aws.amazon.com/ec2/instance-types/m7i/)
- [AWS Spot quotas](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-limits.html)
