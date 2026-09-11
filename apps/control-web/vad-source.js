// Bundle the maintained model adapter. Use our bounded
// frame gate, not MicVAD's utterance accumulator; capture never stores a session.
export {SileroV5} from '../server/node_modules/@ricky0123/vad-web/dist/models/v5.js';
export {Resampler} from '../server/node_modules/@ricky0123/vad-web/dist/resampler.js';
