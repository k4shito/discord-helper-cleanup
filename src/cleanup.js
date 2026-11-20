import { createHash } from "node:crypto";

function isMusicName(name) {
  return name?.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === "music";
}

// Used for comparison after re-fetching a message. The queue stores no message text.
export function matchingFingerprint(message, config, ownId) {
  if (
    message.guildId !== config.guildId ||
    message.pinned ||
    message.authorId === ownId ||
    (message.webhook &&
      !(message.bot && message.applicationId === message.authorId)) ||
    isMusicName(message.channelName) ||
    isMusicName(message.parentName) ||
    config.excludedChannelIds.has(message.channelId) ||
    config.excludedChannelIds.has(message.parentId)
  )
    return null;

  if (
    config.cleanupChannelIds.size > 0 &&
    !config.cleanupChannelIds.has(message.channelId) &&
    !config.cleanupChannelIds.has(message.parentId)
  )
    return null;

  if (message.bot) return config.botIds.has(message.authorId) ? "bot" : null;

  const command = message.content.trimStart().split(/\s/, 1)[0].toLowerCase();
  if (!config.commands.has(command)) return null;
  return createHash("sha256").update(message.content).digest("hex");
}

export class Cleanup {
  constructor(config, queue, discord, log = console) {
    this.config = config;
    this.queue = queue;
    this.discord = discord;
    this.log = log;
  }

  onMessage(message) {
    const fingerprint = matchingFingerprint(
      message,
      this.config,
      this.discord.ownId,
    );
    if (fingerprint === null) return;
    if (this.config.mode === "preview") {
      this.log.info(`[preview] Совпадение в канале ${message.channelId}.`);
      return;
    }
    this.queue.enqueue(
      message,
      fingerprint,
      message.timestamp + this.config.delayMs,
    );
  }

  async tick(now) {
    if (this.config.mode !== "delete" || !this.discord.ready()) return;
    const job = this.queue.take(now);
    if (!job) return;

    try {
      const message = await this.discord.fetchMessage(
        job.channelId,
        job.messageId,
      );
      if (
        !message ||
        message.id !== job.messageId ||
        message.channelId !== job.channelId ||
        message.authorId !== job.authorId ||
        matchingFingerprint(message, this.config, this.discord.ownId) !==
          job.fingerprint
      )
        return;

      await this.discord.deleteMessage(message);
    } catch (error) {
      if (error.code === 10008 || error.code === 10003) return;
      const problem =
        error.status === 403 ? "проверьте права бота" : "проверьте соединение";
      this.log.warn(
        `Не удалось обработать сообщение в канале ${job.channelId}: ${problem}.`,
      );
    }
  }
}
