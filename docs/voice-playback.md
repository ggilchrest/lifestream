# Conversation speech playback

Browser and native conversations share the same playback controller. Speech starts with an 80 ms scheduling cushion after the first admitted PCM frame. Subsequent frames keep their contiguous playback positions while there is queued audio. A late frame can resume with a 20 ms cushion instead of restarting the full startup delay.

These values describe software scheduling, not end-to-end response latency or physical audibility. Recognition, turn detection, model generation, synthesis, transport and the output device still contribute delay. A provider gap can still produce silence. Playback-driven mouth animation follows the actual scheduled samples and stays silent during a gap.

Stop, interruption, privacy changes and connection loss discard queued output and fence retired responses. Reducing the scheduling cushion does not change these controls, microphone endpointing, provider selection or speech projection.

For acceptance, compare first admitted PCM to the first scheduled sample and measure actual end-of-turn to audible speech separately. Exercise normal replies, delayed chunks, gaps between speech segments, Stop, shared/unknown audience, reconnect and a subsequent reply. Record any starvation, click or perceptual discontinuity. Keep the existing 900 ms median and 1,500 ms p95 first-spoken-word objectives until actual acceptance evidence satisfies them.
