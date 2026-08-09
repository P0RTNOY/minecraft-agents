export interface SayResult {
  success: boolean
  action: 'say'
  message: string
  reason?: 'invalid_message'
}

interface ChatSender {
  chat(message: string): void
}

const MAX_CHAT_MESSAGE_LENGTH = 256
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export function say(bot: ChatSender, message: string): SayResult {
  const normalized = message.trim()
  const invalid = (
    normalized.length === 0 ||
    normalized.length > MAX_CHAT_MESSAGE_LENGTH ||
    normalized.startsWith('/') ||
    CONTROL_CHARACTERS.test(normalized)
  )

  if (invalid) {
    return {
      success: false,
      action: 'say',
      message: normalized,
      reason: 'invalid_message'
    }
  }

  bot.chat(normalized)

  return {
    success: true,
    action: 'say',
    message: normalized
  }
}
