# EphemeralLinksReuploader
Discord bot that reuploads ephemeral links (example: 4chan) that are posted (and pretends to be the original user so that no one is the wiser) as attachments so that they can be viewed even after the original content has been removed.

Example Docker compose:
```yaml
services:
  my-discord-bot:
    image: dungfu/ephemeral-links-reuploader:latest
    container_name: my-discord-bot
    restart: unless-stopped
    environment:
      - DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
      - CDN_DOMAINS=4cdn.org,cdn.example.com
```
