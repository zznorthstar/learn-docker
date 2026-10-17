# Fonts

Self-hosted fonts, downloaded from the Google Fonts source repository on
2026-10-17 and losslessly converted from TTF to WOFF2 with fontTools.

- [Host Grotesk](https://github.com/google/fonts/tree/main/ofl/hostgrotesk): variable upright, 300–800.
- [Fragment Mono](https://github.com/google/fonts/tree/main/ofl/fragmentmono): regular upright, 400.
- [JetBrains Mono](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono): variable upright, 100–800.

Each font's SIL Open Font License is included beside its binary. Font files are
served from this app's own origin with `font-display: swap`; no font service is
contacted at runtime. Host Grotesk is preloaded in the document head.
