import { loadEnvFile } from "node:process";

const snowflake = /^[1-9]\d{16,19}$/;

export class ConfigError extends Error {}

export function loadLocalEnvironment() {
  try {
    loadEnvFile(".env");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new ConfigError(
        "Не удалось прочитать .env. Проверьте файл и права доступа.",
      );
    }
  }
}

function readList(env, key, validate, fallback = "") {
  const raw = env[key]?.trim() ?? fallback;
  if (!raw) return [];
  const values = raw.split(",").map((entry) => entry.trim());
  if (!values.every((value) => validate.test(value))) {
    throw new ConfigError(
      `${key}: укажите значения через запятую без пустых элементов.`,
    );
  }
  return [...new Set(values)];
}

export function readConfig(env = process.env) {
  const token = env.DISCORD_TOKEN?.trim();
  if (!token || /\s/.test(token)) {
    throw new ConfigError("DISCORD_TOKEN: укажите токен бота одной строкой.");
  }

  const guildId = env.DISCORD_GUILD_ID?.trim() ?? "";
  if (!snowflake.test(guildId)) {
    throw new ConfigError(
      "DISCORD_GUILD_ID: укажите числовой ID сервера Discord.",
    );
  }

  const excludedChannelIds = readList(env, "MUSIC_CHANNEL_IDS", snowflake);
  if (excludedChannelIds.length === 0) {
    throw new ConfigError(
      "MUSIC_CHANNEL_IDS: укажите хотя бы один музыкальный канал.",
    );
  }

  const mode = env.CLEANUP_MODE?.trim() || "preview";
  if (!["preview", "delete"].includes(mode)) {
    throw new ConfigError("CLEANUP_MODE: допустимы preview и delete.");
  }

  const delay = env.DELETE_DELAY_SECONDS?.trim() || "60";
  if (!/^\d{1,4}$/.test(delay) || Number(delay) < 1 || Number(delay) > 3600) {
    throw new ConfigError(
      "DELETE_DELAY_SECONDS: укажите целое число от 1 до 3600.",
    );
  }

  const commands = readList(env, "MUSIC_COMMANDS", /^\S{1,32}$/, "m!play");
  const botIds = readList(env, "MUSIC_BOT_IDS", snowflake);
  if (commands.length === 0 && botIds.length === 0) {
    throw new ConfigError(
      "Задайте хотя бы одну команду в MUSIC_COMMANDS или бота в MUSIC_BOT_IDS.",
    );
  }

  return {
    token,
    guildId,
    mode,
    delayMs: Number(delay) * 1000,
    databasePath: env.DATABASE_PATH?.trim() || "./data/cleanup.sqlite",
    commands: new Set(commands.map((command) => command.toLowerCase())),
    botIds: new Set(botIds),
    excludedChannelIds: new Set(excludedChannelIds),
    cleanupChannelIds: new Set(readList(env, "CLEANUP_CHANNEL_IDS", snowflake)),
  };
}
