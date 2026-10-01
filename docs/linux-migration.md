# Linux migration configuration

The candidate launcher accepts `--config PRIVATE_JSON` instead of `--profile`.
The external, bounded configuration is validated before candidate or authentication
writes and stays outside Git. For an existing candidate, retain its profile marker,
session environment identity, database, artifacts and complete authentication and
recovery safety directory. An enrolled state does not need a copied installer token.
Preserve forgetting exclusions, permission and recovery epochs; choose migration
and active-session disposition explicitly before copying credential-bearing state.

Select `providers.inference: llama-cpp-local` with truthful `inferenceProfile`
runtime/version, exact served model ID, model artifact digest and context length.
This uses the existing OpenAI-compatible streaming parser with an explicit
llama.cpp protocol. Canonical counts call `/v1/chat/completions/input_tokens` using
the exact same request body as generation, including direct-answer template flags
and output bounds. Raw section text uses `/tokenize` without added/interpreted
special tokens. Unsupported or malformed selected counts fail closed; no local
estimate or fallback counts claim the selected tokenizer identity.

The llama.cpp provider may use an operator-loaded API credential when configured;
it does not manufacture a credential for an already unauthenticated local service.
Existing SGLang authentication requirements and tokenizer behavior are unchanged.
No shared-provider preemption/slot-release performance qualification is asserted
for the new protocol. Keep all required providers, including ASR, required.

Use operator-owned Linux loopback ASR/TTS endpoints. Keep backend state outside the
source checkout. Private ingress, TLS keys, account migration, session revocation
and persistent forwarding require explicit operator authorization. A profile file,
successful source tests or readiness alone do not establish migration, physical
microphone, perceptual speech, game/world actions, or iPhone trust acceptance.
