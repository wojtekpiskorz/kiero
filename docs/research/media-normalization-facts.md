# Photo normalization and audio retention

Checked on 2026-09-08. The owner accepted retaining audio for now in Q194, Q193's optimized-image replacement policy with failure/quality exceptions, and Q197's durable acceptance before background normalization and ordinary vision. Encoder settings and quality proof remain implementation work. No real media was processed and no integration was implemented.

## Materializing optimized images

Cloudflare documents a Worker pipeline that transforms an uploaded stream with the Images binding and writes the result to R2. The interface is `env.IMAGES.input(stream).transform(...).output({ format: 'image/avif' }).response()`, followed by writing the response body to R2. The tutorial requires Images Paid. This materializes an optimized object, unlike only transforming a URL for delivery while retaining its origin image. The tutorial's watermark is an example, not a Kiero requirement. Its upload example also warns about buffering/cloning large bodies under the Worker's 128 MB memory limit. [Transform uploads before R2](https://developers.cloudflare.com/images/tutorials/optimize-user-uploaded-image/)

The Images binding's `.input()` limit is 20 MB. Remote transformation limits do not enlarge that limit. The supported-input list includes HEIC; it does not establish generic HEIF compatibility. AVIF input is marked Enterprise-only. WebP and AVIF are output formats. AVIF encoding can be much slower and documented automatic-format behavior may fall back to WebP or JPEG. A supported output format does not establish all future input paths on a selected plan. [Limits and formats](https://developers.cloudflare.com/images/get-started/limits/)

Non-JPEG output discards metadata, although EXIF rotation and color profiles affect the rendered pixels. Keep only useful source metadata deliberately; do not promise that original EXIF or original bytes can be reconstructed from the converted file. [Optimization features](https://developers.cloudflare.com/images/optimization/features/)

## Product tradeoff

The prior contract retained immutable original media and included it in a full export. A smaller lossy visual record deliberately changes that promise. A hash and transform recipe preserve lineage, not the lost pixels. The owner can choose this change; the prior contract must not be used as a reason to ignore their new storage preference.

Accepted in Q193: keep a readable normalized archival image as the canonical retained visual record, with small thumbnails for presentation. Use conservative tested profiles for notes, invoices and technical drawings; do not force every image under an arbitrary byte ceiling. WebP is the first candidate, while exact dimensions, encoder settings and whether AVIF earns a place require actual sample evidence. If conversion is unsupported, fails or has unresolved quality concerns, retain the received file as an exception. An automated quality check is not a universal guarantee of semantic preservation.

Before removing received bytes, verify that the archival representation is durable and usable. Normal memory extraction and source-region references must resolve to the retained version. Do not derive permanent findings solely from a soon-to-be-deleted original without keeping an inspectable basis. Record the transformation version, input/output identities, dimensions and mapping needed for region anchors. The optimized file must be described and exported as an optimized retained image, not an unchanged camera original.

Accepted Q197: durably receive all attachments and accept the logical source first. Run normalization as a durable background stage before ordinary vision; the author may close the application after the saved receipt. Verify the retained output and its reference/recovery conditions before removing the temporary input. Failures or uncertain quality select the original as the retained inspectable exception and permit useful analysis. Already accepted sources cannot be lost if normalization fails. The accepted processing-latency measurement includes normalization. Input-over-limit handling, interruption, originals awaiting conversion, cleanup, export and backups need explicit tests.

## Audio and storage arithmetic

Transcription is an interpretation of speech. Keeping only text prevents later listening or running a new transcription against the original. Research documents ASR errors and their effect on downstream language tasks; it does not measure Kiero's chosen model, Polish construction speech or a particular provider. [Wang et al., 2020](https://aclanthology.org/2020.nlp4convai-1.8/)

Illustrative arithmetic, not a selected recording profile: 24,000 bits/s × 3,600 s ÷ 8 gives 10.8 MB per hour; 32,000 bits/s gives 14.4 MB. Container overhead, variable bitrate and actual browser codecs alter the result. Suitability of these rates for noisy construction speech has not been tested. Preserve an efficient capture encoding when possible rather than repeatedly recompressing an already accepted source.

R2 Standard currently lists $0.015 per GB-month with 10 GB-month included. Operations and processing are separate, and usage is rounded to billing units. At the illustrative bitrate, a thousand hours uses roughly 11–14 GB; its storage-only list-price order of magnitude is about $0.2 per month before allowances and rounding. This excludes STT, image conversion, backups, Worker requests and other application costs. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

Accepted in Q194: retain playable audio for now in alpha, use transcripts for normal lookup and display, and preserve explicit source deletion. No automatic deletion after transcription or at alpha completion is selected. A future transcript-only policy would need to update listening, re-transcription, evidence and export contracts together.
