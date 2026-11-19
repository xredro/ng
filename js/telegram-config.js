/* Telegram notifications: where your Cloudflare Worker lives. Fill these in after deploying
   cloudflare-worker/telegram-notifier (see docs/TELEGRAM.md). Until then the feature stays switched off and nothing else changes.
   No secrets belong in this file. The bot token and the Appwrite key live only in the Worker. */
window.XR_TELEGRAM = {
  workerUrl: "https://xredro-telegram.xredrooffical.workers.dev",   // no trailing slash
  botUsername: "Xredro_bot"                      // the bot's @name without the @ (only used for display)
};
