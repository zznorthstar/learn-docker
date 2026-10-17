# Teaching reference study

Source: the MP4 and the 100-frame ZIP in `~/Downloads/learning-video-study`.
The video is 40.32 seconds. Speech was transcribed locally with the cached
`Systran/faster-whisper-small` model, CPU int8, beam size 5. Audio was decoded
with FFmpeg to 16 kHz mono PCM; no external transcription service was used.
The timestamped result is in [teaching-reference-transcript.json](teaching-reference-transcript.json).

## What the narration and frames actually do

| Speech interval | Visual evidence in supplied frames | Teaching mechanism |
| --- | --- | --- |
| 0–4.64 s | 001–011: a blue prediction marker, then a green answer and a red distance between them | Start with two concrete things; introduce their relationship before its name becomes another abstraction. |
| 4.64–10.08 s | 016–026: that same red distance becomes a square, then a visible 4×4 grid and a loss of 16 | Transform the existing visual rather than replacing it with a new explanatory slide. Color carries meaning forward. |
| 10.08–14.60 s | 031–036: the square and markers remain while the loss curve and slope appear | Add one relationship while keeping the learner's reference points stable. |
| 14.60–21.84 s | 041–056: a downhill move reduces the square; repeated moves form a row of shrinking squares | Show cause and consequence together; repetition turns one operation into a larger idea. |
| 21.84–30.88 s | 061–076: many small examples give way to a fitted curve and predictions | Pull back only after the small operation makes sense. Detail becomes context. |
| 30.88–36.56 s | 081–091: data, model and compute are labeled in stages, then combined | Each label accompanies an observable change. No paragraphs compete with the diagram. |
| 36.56–40.32 s | 096–100: the broader composition rewinds toward the starting prediction | Return to the initial anchor to explain how the larger system connects. |

Frame ranges are approximate alignments of the numbered samples with the
Whisper speech intervals, not embedded timecodes from the ZIP.

There are nine substantive sentences, averaging about 4.4 seconds per idea.
The repeated “If … you get …” construction makes each step depend on the last.
The video is cumulative, rather than literally clearing everything at every
step: relevant old information stays; it shrinks or recedes when scale changes.
On-screen text is primarily labels and compact formulas. Narration and visual
transitions introduce the same relationship together. There is no evidence for
an exact universal rule that narration must always precede the picture.

## Application to Whale Lab

- The world takes the initial workspace. Timeline and inspector open when
  requested; camera and relationship controls are disclosures.
- Selection dims unrelated parts through the existing SVG presentation layer.
  Existing Rive inputs, camera transitions and semantic state remain authoritative.
- AI server instructions and the copied teaching prompt ask for one visual
  change, one short sentence, a learner action, and a consequence before the
  next idea. Existing prediction, causal trace and rewind tools provide the loop.
- Longer AI notes are preserved but presented in learner-paced sentence-sized
  beats. They remain until dismissed or replaced instead of expiring mid-read.
- Inspector stories have a short first layer. Full stories, relationships,
  technical sections, concept maps and extra experiments expand on request.
- The terminal is a substantial workspace. Existing token parsing explains
  commands while they are entered, then the existing simulation shows the result.
- Onboarding keeps its four existing steps, with one purpose per step: why,
  visual interaction, AI teaching, connection.
- Phones use the document as their primary scroll context. Expanded technical
  material flows below the scene rather than creating independently scrolling panels.

This borrows the reference's educational mechanics, not its visual identity or subject.
