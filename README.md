# Tidy Tabs
Sort your tabs using Firefox's local AI but make it look awesome!

## Features
- AI tab sorting into topic groups, 100% local (no cloud; see the privacy note for the optional LLM)
- Matches tabs into your existing groups before creating new ones
- Optional auto-sort: new tabs drop into your existing groups as they load (and can start new groups)
- Smart group names + automatic group icons
- Workspace suggestions: persistent sidebar card, click a row to move the tab
- Optional local LLM (Ollama) and site rules for more accurate sorting and naming
- One-click sort button with fast local-model warmup

## Local LLM (optional)
For more accurate sorting and group names, Tidy Tabs can ask a small LLM running on your own machine through [Ollama](https://ollama.com). It is off by default.

1. Install Ollama and run `ollama pull qwen3:4b`
2. In the Tidy Tabs settings, turn on "Use a local LLM (Ollama) for sorting and naming"
3. Done. If Ollama is not running, the built-in AI is used instead

Notes:
- The model stays loaded in memory for 30 minutes after each use (about 3 GB RAM), then Ollama unloads it
- Site rules: in "Always put these sites in these groups", write `part-of-address => Group name`, one per line or separated by `;`. A rule matches when the part appears in the tab's host + path (the `https://` is ignored), e.g. `github.com/volumio => Volumio dev; booking.com => Travel`. Rules run before the LLM and work without it
- Privacy: only the tab title and its host + path (no query string, no hash) are sent, and only to the Ollama address in the settings. It is 100% local as long as that address stays on localhost; if you point it at another machine, your tab titles and addresses go there

## Demo
<video src="./demo.mp4" controls muted loop playsinline width="100%"></video>

[Watch the demo](./demo.mp4)

<p align="center">
  <img width="164" height="1020" alt="image" src="https://github.com/user-attachments/assets/88ca1f8c-182c-459b-8a7a-e596b8e833c0" />
</p>
