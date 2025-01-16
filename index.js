const {
  Client,
  GatewayIntentBits,
  Partials,
} = require('discord.js');
const { Readable } = require('stream');
const { finished } = require('stream/promises');
const fs = require('fs');
const path = require('path');
const glob = require('glob');

// Load environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CDN_DOMAINS = process.env.CDN_DOMAINS || '4cdn.org'; 
// e.g.  "4cdn.org,cdn.example.com"

if (!DISCORD_TOKEN) {
  console.error('Error: DISCORD_TOKEN is not set.');
  process.exit(1);
}

// Build a RegExp that matches any of the domains in CDN_DOMAINS
// 1) Split the CSV string into array
const domainsArray = CDN_DOMAINS
  .split(',')
  .map((d) => d.trim())
  .filter((d) => d.length > 0);

// 2) Escape dots in domain strings for the RegExp
//    e.g. '4cdn.org' -> '4cdn\\.org'
const escapedDomains = domainsArray.map((domain) => domain.replace(/\./g, '\\.'));

// 3) Join them with an alternation pattern
//    e.g. ["4cdn\\.org", "cdn\\.example\\.com"] -> "4cdn\\.org|cdn\\.example\\.com"
const domainPattern = escapedDomains.join('|');

// 4) Construct the final regex to match any URL containing these domains
//    Explanation: 
//      - `https?://` matches http or https
//      - `(?:[^/]+\.)?` lets us optionally match a subdomain (e.g. "i.4cdn.org")
//      - `(?:${domainPattern})` is the alternation of domains
//      - `/[\\w\\d\\/_.-]+` matches the path portion after the domain
//    The 'gi' flags = global + case-insensitive
const CDN_REGEX = new RegExp(
  `(https?:\\/\\/(?:[^\\/]+\\.)?(?:${domainPattern})\\/[\\w\\d\\/_.-]+)`,
  'gi'
);

// 10MB in bytes
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
  console.log(`Saw a message: ${message.content}`);
  try {
    // Skip if not in a guild or if it's a bot message
    if (!message.guild || message.author.bot) return;

    // Check for any CDN link in the message content
    const matches = message.content.match(CDN_REGEX);
    if (!matches || matches.length === 0) return;

    // For simplicity, handle only the first match
    // Or you could loop over them if you want to handle multiple simultaneously
    const cdnLink = matches[0];
    console.log(`Detected CDN link: ${cdnLink}`);

    // STEP 1: Check file size via HEAD request (if server supports content-length)
    let contentLength = 0;
    try {
      const headResp = await fetch(cdnLink, { method: 'HEAD' });
      if (headResp.ok) {
        contentLength = Number(headResp.headers.get('content-length')) || 0;
      }
    } catch (headErr) {
      console.warn('HEAD request failed; continuing anyway...');
    }

    // If file size is unknown or bigger than 10MB, skip reupload
    if (contentLength > MAX_FILE_SIZE) {
      throw new Error(`Skipping reupload. File size is too large: ${contentLength} bytes`);
    }

    // STEP 2: fetch the file
    const cdnRes = await fetch(cdnLink);
    if (!cdnRes.ok) {
      throw new Error(`Failed to fetch file from ${cdnLink}: ${cdnRes.status} - ${cdnRes.statusText}`);
    }

    // STEP 3: Determine a file extension
    const urlExtension = path.extname(new URL(cdnLink).pathname);
    const tempFilename = `temp_cdn_${Date.now()}${urlExtension}`;
    const fileStream = fs.createWriteStream(tempFilename, { flags: 'wx' });
    await finished(Readable.fromWeb(cdnRes.body).pipe(fileStream));
    const fileStats = fs.statSync(tempFilename);

    // Double-check the file size just in case HEAD was inaccurate
    if (fileStats.size > MAX_FILE_SIZE) {
      throw new Error(`Downloaded file is over 10MB, skipping reupload: ${fileStats.size} bytes`);
    }

    // Remove the link text from the original message content
    const newContent = message.content.replace(CDN_REGEX, '').trim();

    // STEP 4: Delete original message (needs Manage Messages permission)
    await message.delete().catch((err) => {
      console.warn('Could not delete original message:', err);
    });

    // STEP 5: Re-post as a webhook (impersonate user)
    const webhook = await getOrCreateChannelWebhook(message.channel);
    await webhook.send({
      username: message.member?.nickname || message.author.username,
      avatarURL: message.author.displayAvatarURL({ format: 'png' }),
      content: newContent,
      files: [tempFilename],
    });
  } catch (error) {
    console.error('Error handling message:', error);
  } finally {
    // Cleanup temp files
    const files = glob.sync('temp_cdn_*');
    files.forEach((file) => {
      try {
        fs.unlinkSync(file);
        console.log(`Deleted: ${file}`);
      } catch (err) {
        console.error(`Error deleting ${file}: ${err}`);
      }
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
