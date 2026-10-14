# Video upload E2E fixtures

These two synthetic, two-second, 640 × 360 H.264/yuv420p videos were generated
with FFmpeg's `testsrc2` source at 10 fps, without audio. The late-moov variant
remuxes the same stream without `+faststart`. They contain no user media.

The native E2E journey writes a valid 210 MiB ISO-BMFF `free` box as sparse
padding, either after the early-moov container or before its trailing `moov`.
Media offsets remain unchanged. This exercises real >200 MiB file handling and
metadata seeking; it does not model a long or high-bitrate recording. The test
drives the production media preparation and publication operation through a
native child process. Its controlled Telegram transport reads the actual paced
thumbnail bytes and captures the actual publication, including caption and TL
payload. Assertions independently decode the serialized TL and JPEG. The same
operation handles account fences, cancellation and thumbnail bandwidth holds.
Uploaded main-file part IDs are controlled fixtures; neither the large video
payload nor thumbnail is sent to Telegram. Live Telegram Desktop playback
remains a separate release acceptance check. Temporary decoder staging uses a
private scratch directory unique to the process and is checked for cleanup.
Protected-upload behavior remains covered by the existing encrypted-upload
journeys rather than a test-only bypass in this facade.

On Windows, these video child processes have an empty executable search path:
successful extraction therefore proves native Windows codec execution without
an FFmpeg fallback. Other platform success journeys use a real installed FFmpeg.
Unix cancellation, account-switch and deadline journeys substitute an owned
blocking codec executable at the external codec boundary. They exercise the
production process budget, process termination and scratch cleanup; they do not
claim actual codec decoding in those specific lifecycle journeys.
