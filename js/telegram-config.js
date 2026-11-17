/* Telegram notifications: where your Cloudflare Worker lives. Fill these in after deploying
   cloudflare-worker/telegram-notifier (see docs/TELEGRAM.md). Until then the feature stays switched off and nothing else changes.
   No secrets belong in this file. The bot token and the Appwrite key live only in the Worker. */
window.XR_TELEGRAM = {
  workerUrl: "https://REPLACE_WITH_YOUR_WORKER.workers.dev",   // no trailing slash
  botUsername: "REPLACE_WITH_BOT_USERNAME"                      // the bot's @name without the @ (only used for display)
};
