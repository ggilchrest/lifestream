# Clearer unavailable responses for PWCE action review

The host now distinguishes a bounded unavailable action-preparation call from a generic internal failure. An approved request still needs current access before it can run. No device behavior or permission has changed.

Follow [the action-refusal QA guidance](canonical-provider-boundary.md#when-a-pwce-action-review-becomes-unavailable). Check the original result after an uncertain reply; an unavailable response is not evidence that an action had no effect. Synthetic validation is separate from live-device acceptance.
