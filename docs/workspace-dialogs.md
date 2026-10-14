# Workspace setup and device management

Cluster Builder opens its setup from **Create clusters**. The dialog follows
**Server → Install → Workers → Confirmation**, using the same progress rail as
project creation. Choosing installation settings and workers does not install
software. Only the final **Create cluster / Confirm cluster** runs operations.
Existing clusters and their management actions remain on the page.

A successful control-plane install is retained when a worker join fails.
Retries skip workers that already joined. Partial results and installer logs
remain reviewable. Converting a standalone control plane into a worker still
requires its separate destructive-action confirmation. Closing a dialog clears
passwords; it cannot dismiss a running installation.

Remote opens pairing from **Connect remote device**. The page keeps recent
device records, including disconnected devices, and the latest 50 AI requests.
History can be filtered by device. Pairing still requires the desktop owner to
approve the exact confirmation code.

Device metadata includes its name, browser/OS from its pairing User-Agent,
optional owner-entered location label, device time zone, creation/last-seen/access
expiry times, and its AI request count. Location is a label supplied during
pairing, not GPS or IP geolocation. Older devices show missing metadata as
unavailable. Device details are account-scoped and exclude credential hashes.
Migration 068 adds optional fields without deleting existing records.

Sign-in opens Projects directly. The old `/dashboard/setup` bookmark redirects
there; the separate setup guide and its sidebar entry are removed. AI providers
remain configurable in Settings. Theme selection is a keyboard-accessible
Light/Dark/System menu anchored beside the sidebar theme button.
Saved mode is applied once when the shell opens; session refreshes do not race
with a new local selection and revert it before its preferences save finishes.

Native disclosures use 240 ms size transitions in browsers supporting
`interpolate-size`; other browsers retain native disclosure behavior. Controlled
resource and tool sections animate grid rows while closed content is inert.
Reduced-motion preferences disable these transitions.

Qualification: `tests/integration/workspace_setup_ui.mjs` mocks all APIs to check
confirmation boundaries, duplicate clicks, failed installs, partial worker
recovery, pairing approval, device history, theme placement and four widths.
`tests/integration/remote_session_smoke.py` uses a disposable database/backend
to check metadata validation, account isolation, pairing and credential
revocation. No real cluster install or worker join is needed for these checks.

The project Guide is a matching button beside New project and opens a wider
source guide. Technology symbols gain color on hover or keyboard focus.
Native disclosure content contains its child margins in a flow root so the
animated height does not jump at the endpoints. Progress rails and upcoming
circles use closely spaced dashes; reached steps keep their solid connections.
Interactive controls use pointer cursors; text fields retain their editing cursor.

Cluster step navigation stays together in the footer. Delete is at the upper
right of each cluster, and Operation output beside Open monitor opens a dialog
with results scoped to that control plane. Resource and agent settings tabs use
spaced short dividers. The chat toolbar uses its available width to choose
between visible actions and the overflow menu, including when Live App is open.

Remote devices and request history are tables. Device details expand inside
the table, and the history filter uses the shared styled select. The theme menu
uses three compact horizontal choices beside the sidebar trigger.

Project search, New project, and Guide controls are 36 px high on desktop,
with 44 px touch targets on phones. Agent Settings opens at up to 1120 px and
spreads its categories across the full dialog width. The Settings page uses the
same spaced categories and short separators, with category buttons starting at
36 px on desktop and the same white active selection in dark mode. Login History and Audit Logs sit
beside the account form from the desktop breakpoint, stacking below it on phones.

The desktop shell uses a 52 px icon rail, a 208 px expanded sidebar, and a
44 px top bar without boundary rules. Toggle, workspace, navigation, and footer
rows keep their icon tracks, padding, height, and order while the sidebar width
changes. Labels stay mounted in place and fade into the narrowing space.

Dialogs with changing sections opt into a shared 240 ms height animation.
Incoming panels are measured after their layout commit; outgoing inert tab
panels no longer inflate the dialog during the switch. Interrupted transitions
continue from the rendered height. Content stays scrollable at the viewport
limit, and reduced-motion preferences skip the height animation. Agent Settings,
project information/source guides, cluster setup, and remote pairing use this
behavior.

Native source-file menus animate their own height, and the surrounding dialog
follows that layout in the same frame. The resize observer updates the section
animation baseline without starting another animation after a menu opens or
closes. Opening a menu during a section transition cancels the older height
animation so it cannot hold back the new content.

Chat-history search sits beside Refresh and New chat on desktop and wraps on
phones. Saved context loads its Markdown renderer only when first opened.
