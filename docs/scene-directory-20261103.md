# Scene directory and chart spacing — 2026-11-03

The homepage's Scenes entry now opens a native modal dialog from any directory
view. The title identifies the parent topic once. Each card shows its scene name
and existing ranking/weight preview, with no repeated topic name, summary or
creator. Default scenes remain first. Matching scenes receive a full outline and
scroll into view. Escape, the close control and backdrop dismissal restore focus;
the background remains inert while the dialog is open.

Homepage and configuration-sidebar search still match scene names, distinct
descriptions and combined topic/scene queries. Results contain one parent topic
per match, with an “Includes scenes: (name), …” summary inside that card. They
never return standalone scene cards. Sidebar topic links use their usual default
scene; the workspace scene selector remains available. A long summary is clamped
visually, with full text retained for accessibility and hover. Private search
continues to use only the signed-in owner's catalogue.

Scene previews retain their scene IDs and canonical URLs, including model links.
They load only when visible in the open dialog, with the existing two-request
limit. Closing aborts scene reads; cached previews can be reused on reopening.
Account changes close the dialog before private cards are removed. Native scene
links in the initial server HTML remain available without JavaScript.

Homepage colored bars now occupy at most 65% of plot height, previously 75%.
The treemap mask is unchanged: solid through 32%, fading to transparent at 76%.
Relative/absolute scale rules, actual scores, column widths and chart baselines
are unchanged. The lowered foreground exposes more of the background weights.

Validation covers Chromium/WebKit at mobile and desktop sizes, scene-scoped
preview/model URLs, grouped search, no repeated card copy, keyboard dismissal,
focus restoration, and bar height versus the unchanged mask. The existing
homepage geometry tests retain both estimated-score and range assertions.

The directory and chart changes themselves require no schema migration. They
ship with the proposal discussion and private-topic lifecycle changes described
in [the combined release](scene-community-20261103.md); that backend does require
the new proposal-discussion schema. Rebuild home and index and follow that
release's narrow deployment instructions. GitHub publication from this cloud
environment does not itself deploy the site.
