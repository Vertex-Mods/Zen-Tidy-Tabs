# Tidy Tabs
Sort your tabs using Firefox's local AI but make it look awesome!

## Features
- AI tab sorting into topic groups, 100% local (no cloud)
- Matches tabs into your existing groups before creating new ones
- Optional auto-sort: new tabs drop into your existing groups as they load (and can start new groups once 2+ on a topic exist)
- Site rules: always put matching sites in the same group
- Smart group names + automatic group icons
- Workspace suggestions: persistent sidebar card, click a row to move the tab
- One-click sort button with fast local-model warmup

## Site rules
In "Always put these sites in these groups", write `part-of-address => Group name`, one per line or separated by `;`. A rule matches when the part appears in the tab's host + path (the `https://` is ignored), e.g. `github.com/volumio => Volumio dev; booking.com => Travel`. Rules run before the AI. Everything stays local: only the tab title and host + path (no query string, no hash) are ever read, and only on-device.

## Demo
<video src="./demo.mp4" controls muted loop playsinline width="100%"></video>

[Watch the demo](./demo.mp4)

<p align="center">
  <img width="164" height="1020" alt="image" src="https://github.com/user-attachments/assets/88ca1f8c-182c-459b-8a7a-e596b8e833c0" />
</p>
