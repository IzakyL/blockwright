// `chat`: sending chat lines and commands as the player, and reading the chat log.
export {
  sendChat as send,
  stateMessages as messages,
  waitForMessage as waitFor,
  type ChatResult as SendResult,
  type MessageWaitOptions as WaitOptions,
} from "../client/state.js";
