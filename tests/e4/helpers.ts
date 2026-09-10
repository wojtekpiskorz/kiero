/**
 * Shared E4 test helpers: plain re-exports that keep the coverage-test
 * imports short (the surface itself lives in @kiero/agent/extraction).
 */

export {
  allInputsComplete,
  audioAttachmentStatus,
  decideJoinedCompleteness,
  imageAttachmentStatus,
  inputWorthWaiting,
  isCompleteTranscript,
} from "@kiero/agent";
