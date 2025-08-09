'use strict';

// Load environment variables from .env if present
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { AssemblyAI } = require('assemblyai');

const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  console.error('Missing TELEGRAM_BOT_TOKEN environment variable. Set it before running.');
  process.exit(1);
}

const downloadsDirectory = path.resolve(__dirname, 'downloads');

function ensureDirectoryExists(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

ensureDirectoryExists(downloadsDirectory);

const bot = new TelegramBot(botToken, { polling: true });

const assemblyApiKey = process.env.ASSEMBLY_API_KEY;
const ASSEMBLY_BASE_URL = 'https://api.assemblyai.com/v2';
const assemblyClient = new AssemblyAI({ apiKey: assemblyApiKey });

const togetherApiKey = process.env.TOGETHER_API_KEY;
const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';

function isArabicLanguageCode(languageCode) {
  if (!languageCode) return false;
  const normalized = String(languageCode).toLowerCase();
  return normalized === 'ar' || normalized.startsWith('ar_');
}

// Track per-chat response language preference (default: English)
const chatLanguagePreference = new Map(); // chatId -> 'en' | 'ar'

function getPreferredLanguageForChat(chatId) {
  return chatLanguagePreference.get(chatId) || 'en';
}

function setPreferredLanguageForChat(chatId, langCode) {
  const normalized = (langCode || '').toLowerCase();
  if (normalized !== 'en' && normalized !== 'ar') return false;
  chatLanguagePreference.set(chatId, normalized);
  return true;
}

// Text inputs will be handled directly by the LLM; audio language detection comes from AssemblyAI.

async function getMuftiResponseLLM(userInput, targetLanguage, detectedLanguageCode) {
  if (!togetherApiKey) {
    throw new Error('Missing TOGETHER_API_KEY environment variable');
  }

  const respondInArabic = targetLanguage === 'ar';
  const systemPrompt = [
    'You are an Islamic expert (mufti) who provides accurate, well-sourced answers grounded in the Qur\'an, Sunnah, and recognized fiqh methodology.',
    'Follow these rules:',
    respondInArabic
      ? '- Always respond in Arabic. If the user\'s message is not in Arabic, briefly translate/summarize it into Arabic first, then provide the answer in Arabic.'
      : '- Always respond in English. If the user\'s message is not in English, briefly translate/summarize it into English first, then provide the answer in English.',
    '- Provide a clear, detailed response with reasoning, relevant evidence, and practical guidance where applicable.',
    '- Briefly cite primary sources when relevant (e.g., Qur\'an 2:286; Sahih Muslim), without overly long quotations.',
    '- Be respectful, avoid political or sectarian bias, and prefer mainstream scholarly consensus when applicable.',
  ].join('\n');

  const userContent = userInput;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const response = await axios.post(
    `${TOGETHER_BASE_URL}/chat/completions`,
    {
      model: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
      messages,
      temperature: 0.2,
      max_tokens: 900,
    },
    {
      headers: {
        Authorization: `Bearer ${togetherApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    }
  );

  const content = response?.data?.choices?.[0]?.message?.content || '';
  return content.trim();
}

async function transcribeWithAssemblyAI(localFilePath) {
  if (!assemblyApiKey) {
    throw new Error('Missing ASSEMBLY_API_KEY environment variable');
  }
  const transcript = await assemblyClient.transcripts.transcribe({
    audio: fs.createReadStream(localFilePath),
    language_detection: true,
    punctuate: true,
    format_text: true,
  });
  console.log('AssemblyAI transcript language:', transcript.language_code, '(confidence:', transcript.language_confidence, ')');
  console.log('AssemblyAI transcript:', transcript.text);
  return {
    text: transcript.text,
    languageCode: transcript.language_code,
    languageConfidence: transcript.language_confidence,
  };
}

bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

bot.on('webhook_error', (error) => {
  console.error('Webhook error:', error);
});

bot.on('text', async (message) => {
  const chatId = message.chat.id;
  const incomingText = message.text || '';
  try {
    // Commands: /start, /lang, /lang en, /lang ar
    if (/^\/start\b/i.test(incomingText)) {
      const current = getPreferredLanguageForChat(chatId);
      const text = current === 'ar'
        ? 'مرحبًا! أرسل سؤالك، وسأجيبك بإجابات مفصلة. اختر لغة الرد:'
        : 'Welcome! Send your question and I will provide a detailed answer. Choose your response language:';
      await bot.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'English', callback_data: 'set_lang:en' },
            { text: 'العربية', callback_data: 'set_lang:ar' },
          ]],
        },
      });
      return;
    }

    const langMatch = incomingText.match(/^\/lang(?:\s+(en|ar))?\b/i);
    if (langMatch) {
      const code = langMatch[1]?.toLowerCase();
      if (code === 'en' || code === 'ar') {
        setPreferredLanguageForChat(chatId, code);
        const msg = code === 'ar' ? 'تم تعيين لغة الرد إلى العربية.' : 'Response language set to English.';
        await bot.sendMessage(chatId, msg);
      } else {
        await bot.sendMessage(chatId, 'Choose response language:', {
          reply_markup: {
            inline_keyboard: [[
              { text: 'English', callback_data: 'set_lang:en' },
              { text: 'العربية', callback_data: 'set_lang:ar' },
            ]],
          },
        });
      }
      return;
    }

    const targetLang = getPreferredLanguageForChat(chatId);
    const llmReply = await getMuftiResponseLLM(incomingText, targetLang, undefined);
    await bot.sendMessage(chatId, llmReply, { parse_mode: 'Markdown' }).catch(() => bot.sendMessage(chatId, llmReply));
  } catch (error) {
    console.error('Failed to respond via LLM:', error);
    try {
      await bot.sendMessage(chatId, 'Sorry, I could not process your message right now.');
    } catch {}
  }
});

async function downloadFileById(fileId, targetDir) {
  ensureDirectoryExists(targetDir);
  try {
    const localFilePath = await bot.downloadFile(fileId, targetDir);
    return localFilePath;
  } catch (error) {
    console.error('File download failed:', error);
    throw error;
  }
}

bot.on('voice', async (message) => {
  const chatId = message.chat.id;
  const voice = message.voice;
  if (!voice) return;

  try {
    const savedPath = await downloadFileById(voice.file_id, downloadsDirectory);
    // Transcribe, then send to LLM
    try {
      const { text, languageCode } = await transcribeWithAssemblyAI(savedPath);
      const targetLang = getPreferredLanguageForChat(chatId);
      const llmReply = await getMuftiResponseLLM(text, targetLang, languageCode);
      await bot.sendMessage(chatId, llmReply, { parse_mode: 'Markdown' }).catch(() => bot.sendMessage(chatId, llmReply));
    } catch (err) {
      console.error('Transcription/LLM failed:', err);
      await bot.sendMessage(chatId, 'Sorry, I could not transcribe or process your voice message.');
    }
  } catch (error) {
    await bot.sendMessage(chatId, 'Sorry, I could not download your voice message.');
  }
});

bot.on('audio', async (message) => {
  const chatId = message.chat.id;
  const audio = message.audio;
  if (!audio) return;

  try {
    const savedPath = await downloadFileById(audio.file_id, downloadsDirectory);
    // Transcribe, then send to LLM
    try {
      const { text, languageCode } = await transcribeWithAssemblyAI(savedPath);
      const targetLang = getPreferredLanguageForChat(chatId);
      const llmReply = await getMuftiResponseLLM(text, targetLang, languageCode);
      await bot.sendMessage(chatId, llmReply, { parse_mode: 'Markdown' }).catch(() => bot.sendMessage(chatId, llmReply));
    } catch (err) {
      console.error('Transcription/LLM failed:', err);
      await bot.sendMessage(chatId, 'Sorry, I could not transcribe or process your audio file.');
    }
  } catch (error) {
    await bot.sendMessage(chatId, 'Sorry, I could not download your audio file.');
  }
});

// Handle inline language selection
bot.on('callback_query', async (query) => {
  try {
    const chatId = query.message?.chat?.id;
    const data = query.data || '';
    if (!chatId || !data) return;
    if (data.startsWith('set_lang:')) {
      const code = data.split(':')[1];
      if (code === 'en' || code === 'ar') {
        setPreferredLanguageForChat(chatId, code);
        const msg = code === 'ar' ? 'تم تعيين لغة الرد إلى العربية.' : 'Response language set to English.';
        await bot.answerCallbackQuery(query.id);
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
        await bot.sendMessage(chatId, msg);
      }
    }
  } catch (e) {
    console.error('callback_query error:', e);
  }
});

bot.on('message', async (message) => {
  const chatId = message.chat.id;
  const supported = Boolean(message.text || message.voice || message.audio);
  if (!supported) {
    try {
      await bot.sendMessage(chatId, 'Send me text or a voice message.');
    } catch (error) {
      console.error('Failed to send unsupported-type notice:', error);
    }
  }
});

console.log('Telegram bot is running (polling). Ready to receive text and voice messages.');


