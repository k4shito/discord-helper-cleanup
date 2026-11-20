import { loadEnvFile } from "node:process";

const snowflake = /^[1-9]\d{16,19}$/;

export class ConfigError extends Error {}

export const emojiKey = (emoji) => emoji.replace(/\uFE0F/g, "");

function rolePost(env, kind, requiredKey) {
  const channelId = env[`${kind}_CHANNEL_ID`]?.trim();
  const messageId = env[`${kind}_MESSAGE_ID`]?.trim();
  const value = env[requiredKey]?.trim();
  if (!channelId && !messageId && !value) return null;
  if (
    !snowflake.test(channelId ?? "") ||
    !snowflake.test(messageId ?? "") ||
    !value
  ) {
    throw new ConfigError(
      `Заполните ${kind}_CHANNEL_ID, ${kind}_MESSAGE_ID и ${requiredKey}.`,
    );
  }
  return { channelId, messageId, value };
}

function readRolePosts(env) {
  const rules = rolePost(env, "RULES", "ACCESS_ROLE_ID");
  if (rules && !snowflake.test(rules.value)) {
    throw new ConfigError("ACCESS_ROLE_ID: укажите числовой ID роли.");
  }

  const themes = rolePost(env, "THEME_ROLES", "THEME_ROLE_BINDINGS");
  let bindings = new Map();
  if (themes) {
    try {
      const data = JSON.parse(themes.value);
      if (!data || Array.isArray(data) || typeof data !== "object")
        throw new Error();
      const entries = Object.entries(data);
      bindings = new Map(
        entries.map(([emoji, roleId]) => [emojiKey(emoji), roleId]),
      );
      if (
        !entries.length ||
        entries.length > 20 ||
        bindings.size !== entries.length ||
        new Set(bindings.values()).size !== entries.length ||
        entries.some(
          ([emoji, roleId]) =>
            !/^(?=.{1,24}$)(?=.*[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3])[^\s]+$/u.test(
              emoji,
            ) ||
            typeof roleId !== "string" ||
            !snowflake.test(roleId) ||
            roleId === rules?.value,
        )
      )
        throw new Error();
    } catch {
      throw new ConfigError(
        "THEME_ROLE_BINDINGS: задайте JSON-объект с 1–20 уникальными эмодзи и ID ролей в кавычках. Роль доступа должна быть отдельной.",
      );
    }
    if (themes.messageId === rules?.messageId) {
      throw new ConfigError(
        "Укажите разные сообщения для подтверждения правил и тематических ролей.",
      );
    }
  }
  return {
    rules: rules && {
      channelId: rules.channelId,
      messageId: rules.messageId,
      roleId: rules.value,
    },
    themes: themes && {
      channelId: themes.channelId,
      messageId: themes.messageId,
      bindings,
    },
  };
}

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
    rolePosts: readRolePosts(env),
  };
}
