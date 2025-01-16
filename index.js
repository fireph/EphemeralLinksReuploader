const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const { Readable } = require('stream');
const { finished } = require('stream/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Load environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // For quick slash-command registration in a test guild (optional)

if (!DISCORD_TOKEN) {
  console.error('Error: DISCORD_TOKEN is not set.');
  process.exit(1);
}

// 10MB in bytes
const MAX_FILE_SIZE = 10 * 1024 * 1024;

let rootDirectory;
if (os.platform() === 'win32') {
  rootDirectory = 'C:\\'; // Windows
} else {
  rootDirectory = '/'; // Linux, macOS
}

const CONFIG_FOLDER_PATH = path.join(rootDirectory, 'config');
const TEMP_FOLDER_PATH = path.join(rootDirectory, 'temp');
if (!fs.existsSync(CONFIG_FOLDER_PATH)) {
  fs.mkdirSync(CONFIG_FOLDER_PATH);
}
if (!fs.existsSync(TEMP_FOLDER_PATH)) {
  fs.mkdirSync(TEMP_FOLDER_PATH);
}

// --------------------
// 1) GLOBAL CONFIG: One file for ALL guilds
// --------------------
const GLOBAL_CONFIG_PATH = path.join(CONFIG_FOLDER_PATH, 'elr_guild_configs.json');

// Structure will look like:
// {
//   "guilds": {
//     "GUILD_ID_1": {
//       "allowedDomains": [...],
//       "allowedExtensions": [...]
//     },
//     "GUILD_ID_2": {
//       "allowedDomains": [...],
//       "allowedExtensions": [...]
//     }
//   }
// }

const DEFAULT_GUILD_CONFIG = {
  allowedDomains: ['4cdn.org'],
  allowedExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.webm', '.mp4'],
};

// Load the entire JSON file (with all guild configs) from disk
function loadGlobalConfig() {
  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) {
    // If file doesn't exist, create a default structure
    const initialData = { guilds: {} };
    fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  try {
    const raw = fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse global config:', err);
    // fallback to an empty structure
    return { guilds: {} };
  }
}

// Save the entire JSON file (with all guild configs) to disk
function saveGlobalConfig(config) {
  try {
    fs.writeFileSync(
      GLOBAL_CONFIG_PATH,
      JSON.stringify(config, null, 2),
      'utf8'
    );
  } catch (err) {
    console.error('Failed to save global config:', err);
  }
}

// Helper to get the config object for a specific guild
function getGuildConfig(globalConfig, guildId) {
  if (!globalConfig.guilds[guildId]) {
    // If guild not present, create a default config for it
    globalConfig.guilds[guildId] = { ...DEFAULT_GUILD_CONFIG };
    saveGlobalConfig(globalConfig);
  }
  return globalConfig.guilds[guildId];
}

// --------------------
// 2) SLASH COMMAND DEFINITIONS
// --------------------
const commands = [
  new SlashCommandBuilder()
    .setName('allowdomain')
    .setDescription('Add a domain to this Discord server’s allowed list.')
    .addStringOption((option) =>
      option.setName('domain').setDescription('Domain (e.g., 4cdn.org)').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('removedomain')
    .setDescription('Remove a domain from this Discord server’s allowed list.')
    .addStringOption((option) =>
      option.setName('domain').setDescription('Domain to remove').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('listdomains')
    .setDescription('List allowed domains for this Discord server.'),

  new SlashCommandBuilder()
    .setName('allowext')
    .setDescription('Add a file extension to this Discord server’s allowed list (e.g. .jpg).')
    .addStringOption((option) =>
      option.setName('extension').setDescription('File extension (e.g., .jpg or jpg)').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('removeext')
    .setDescription('Remove a file extension from this Discord server’s allowed list.')
    .addStringOption((option) =>
      option.setName('extension').setDescription('File extension to remove').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('listext')
    .setDescription('List allowed file extensions for this Discord server.'),
].map(cmd => cmd.toJSON());

// --------------------
// 3) DISCORD CLIENT
// --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

// On startup, register slash commands
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: commands,
    });
    console.log(`Slash commands registered to guild ${GUILD_ID}.`);
  }
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log('Slash commands registered globally.');
});

// --------------------
// 4) SLASH COMMAND HANDLER
// --------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.reply({
      content: 'This command only works in a guild channel.',
      ephemeral: true,
    });
  }

  // Load global config
  const globalConfig = loadGlobalConfig();
  // Get or init this guild's config
  const guildConfig = getGuildConfig(globalConfig, guildId);

  // Helper to respond ephemeral
  const replyEphemeral = (msg) => interaction.reply({ content: msg, ephemeral: true });

  switch (commandName) {
    case 'allowdomain': {
      const domain = interaction.options.getString('domain').toLowerCase().trim();
      if (!guildConfig.allowedDomains.includes(domain)) {
        guildConfig.allowedDomains.push(domain);
        saveGlobalConfig(globalConfig);
        replyEphemeral(`Domain \`${domain}\` added to this guild’s allowed list.`);
      } else {
        replyEphemeral(`Domain \`${domain}\` is already allowed.`);
      }
      break;
    }
    case 'removedomain': {
      const domain = interaction.options.getString('domain').toLowerCase().trim();
      const before = guildConfig.allowedDomains.length;
      guildConfig.allowedDomains = guildConfig.allowedDomains.filter(d => d !== domain);
      const after = guildConfig.allowedDomains.length;
      if (after < before) {
        saveGlobalConfig(globalConfig);
        replyEphemeral(`Domain \`${domain}\` removed from this guild’s allowed list.`);
      } else {
        replyEphemeral(`Domain \`${domain}\` was not in the list.`);
      }
      break;
    }
    case 'listdomains': {
      const list = guildConfig.allowedDomains.length
        ? guildConfig.allowedDomains.join(', ')
        : '(none)';
      replyEphemeral(`**Allowed Domains**: ${list}`);
      break;
    }
    case 'allowext': {
      let ext = interaction.options.getString('extension').toLowerCase().trim();
      if (!ext.startsWith('.')) {
        ext = '.' + ext;
      }
      if (!guildConfig.allowedExtensions.includes(ext)) {
        guildConfig.allowedExtensions.push(ext);
        saveGlobalConfig(globalConfig);
        replyEphemeral(`Extension \`${ext}\` added to this guild’s allowed list.`);
      } else {
        replyEphemeral(`Extension \`${ext}\` is already allowed.`);
      }
      break;
    }
    case 'removeext': {
      let ext = interaction.options.getString('extension').toLowerCase().trim();
      if (!ext.startsWith('.')) {
        ext = '.' + ext;
      }
      const before = guildConfig.allowedExtensions.length;
      guildConfig.allowedExtensions = guildConfig.allowedExtensions.filter(e => e !== ext);
      const after = guildConfig.allowedExtensions.length;
      if (after < before) {
        saveGlobalConfig(globalConfig);
        replyEphemeral(`Extension \`${ext}\` removed from this guild’s allowed list.`);
      } else {
        replyEphemeral(`Extension \`${ext}\` was not in the list.`);
      }
      break;
    }
    case 'listext': {
      const list = guildConfig.allowedExtensions.length
        ? guildConfig.allowedExtensions.join(', ')
        : '(none)';
      replyEphemeral(`**Allowed Extensions**: ${list}`);
      break;
    }
    default:
      break;
  }
});

// --------------------
// 5) MESSAGE HANDLER
// --------------------
client.on('messageCreate', async (message) => {
  // Ignore DMs or bot messages
  if (!message.guild || message.author.bot) return;

  const guildId = message.guild.id;
  const globalConfig = loadGlobalConfig();
  const guildConfig = getGuildConfig(globalConfig, guildId);

  // Regex to catch multiple links
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const allLinks = message.content.match(urlRegex);
  if (!allLinks) return; // No links found

  let newContent = message.content;
  let newFiles = []
  let filesToDelete = []

  for (const link of allLinks) {
    try {
      const parsed = new URL(link.toLowerCase());
      const host = parsed.host; // e.g. i.4cdn.org
      const parts = host.split('.');
      // e.g. "i", "4cdn", "org" -> get the last two for "4cdn.org"
      const rootDomain = parts.slice(-2).join('.');

      if (!(guildConfig.allowedDomains.includes(host) || guildConfig.allowedDomains.includes(rootDomain))) {
        continue;
      }

      // Check if extension allowed
      const ext = path.extname(parsed.pathname).toLowerCase();
      if (!guildConfig.allowedExtensions.includes(ext)) {
        continue;
      }

      // Check file size via HEAD request (if server supports content-length)
      let contentLength = 0;
      try {
        const headResp = await fetch(parsed, { method: 'HEAD' });
        if (headResp.ok) {
          contentLength = Number(headResp.headers.get('content-length')) || 0;
        }
      } catch (headErr) {
        console.warn('HEAD request failed; continuing anyway...');
      }

      // If file size is bigger than 10MB, skip reupload
      if (contentLength > MAX_FILE_SIZE) {
        throw new Error(`Skipping reupload. File size is too large: ${contentLength} bytes`);
      }

      // fetch the file
      const cdnRes = await fetch(parsed);
      if (!cdnRes.ok) {
        throw new Error(`Failed to fetch file from ${parsed.href}: ${cdnRes.status} - ${cdnRes.statusText}`);
      }

      // Determine a file extension
      const tempFilename = path.join(TEMP_FOLDER_PATH, `temp_cdn_${guildId}_${Date.now()}${ext}`);
      filesToDelete.push(tempFilename);
      const fileStream = fs.createWriteStream(tempFilename, { flags: 'wx' });
      await finished(Readable.fromWeb(cdnRes.body).pipe(fileStream));
      const fileStats = fs.statSync(tempFilename);

      // Double-check the file size just in case HEAD was inaccurate
      if (fileStats.size > MAX_FILE_SIZE) {
        throw new Error(`Downloaded file is over 10MB, skipping reupload: ${fileStats.size} bytes`);
      }

      // Remove the link text from the original message content
      newContent = newContent.replace(link, '').trim();

      // Add file to list of files that will be attached to message
      newFiles.push(tempFilename);
    } catch (error) {
      console.error('Error handling link:', error);
    }
  }

  try {
    // Delete original message (needs Manage Messages permission)
    await message.delete().catch((err) => {
      console.warn('Could not delete original message:', err);
    });

    // Re-post as a webhook (impersonate user)
    const webhook = await getOrCreateChannelWebhook(message.channel);
    await webhook.send({
      username: message.member?.nickname || message.author.username,
      avatarURL: message.author.displayAvatarURL({ format: 'png' }),
      content: newContent,
      files: newFiles,
    });
  } catch (error) {
    console.error('Error handling message:', error);
  } finally {
    // Cleanup temp files
    filesToDelete.forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch (err) {}
    });
  }
});

// Helper: Get or create a webhook in the channel
async function getOrCreateChannelWebhook(channel) {
  // Bot must have MANAGE_WEBHOOKS permission in this channel
  const webhooks = await channel.fetchWebhooks();
  const existing = webhooks.find(
    (wh) => wh.owner && wh.owner.id === channel.client.user.id
  );
  if (existing) return existing;

  // Otherwise, create a new webhook
  return channel.createWebhook({
    name: '4chan Attach Bot Webhook',
  });
}

client.login(DISCORD_TOKEN);
