# Appearance packages and animation previews

An appearance changes presentation independently of Assistant identity, memory and voice. Packages remain separately supplied through the authenticated, digest-checked resource catalog. They contain bounded data and declared assets, never scripts or remote resource URLs.

In **Conversation**, select an **Appearance** and **Apply to** scope, then click **Apply appearance** between turns. A failed replacement retains the current display. **Restart display** recovers a failed renderer without replaying speech.

Expand **Preview animations** to inspect the applied appearance. Select an **Animation state** and click **Preview animation**. The preview lasts five seconds; **End preview** returns to the conversation immediately. Starting a real turn, changing the audience, leaving the page or replacing the appearance ends the preview. Preview does not save a selection, alter the Assistant, write memory or synthesize speech. **Speaking motion only** is a visual animation preview, not an audible-speaking claim or a lip-sync test.

The status distinguishes a declared animation, an idle fallback and an absent mapping. Gaze and phoneme alignment are not supplied by these controls. Human inspection remains required for convincing motion, transitions and appearance quality.

Package schema `1.0.0` retains its existing `idle`, `listening`, `speaking` and `mouthAmplitude` animation mappings. Schema `1.1.0` additionally supports `preparing`, `interrupted`, `working`, `waiting` and `failure`, with optional `transitionSeconds` from 0 to 1; the default is 0.15 seconds. Each mapping must name exactly one clip in the model. Missing or ambiguous mapped clips reject a replacement. Omitted mappings are allowed and reported as degradation. A zero-second transition switches immediately.

Normal speaking and mouth movement follow actual endpoint playback. Preparing text alone does not claim audible speech. Both schema versions keep the same resource limits, private catalog access, hash checks and safe between-turn selection semantics.
