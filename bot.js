'use strict';

// Load environment variables from .env if present
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

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

const togetherApiKey = process.env.TOGETHER_API_KEY;
const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';

function isArabicLanguageCode(languageCode) {
  if (!languageCode) return false;
  const normalized = String(languageCode).toLowerCase();
  return normalized === 'ar' || normalized.startsWith('ar_');
}

function containsArabicScript(text) {
  if (!text) return false;
  return /[\u0600-\u06FF]/.test(text);
}

async function getMuftiResponseLLM(userInput, detectedLanguageCode) {
  if (!togetherApiKey) {
    throw new Error('Missing TOGETHER_API_KEY environment variable');
  }

  const systemPrompt = [
    'You are an Islamic expert (mufti) who provides concise, accurate answers grounded in the Qur\'an, Sunnah, and recognized fiqh methodology.',
    'Follow these rules:',
    '- Always respond in English.',
    '- If the user\'s input is in Arabic, translate or summarize it into English before providing your ruling/answer.',
    '- If relevant, briefly cite primary sources (e.g., Qur\'an 2:286, Sahih Muslim) without lengthy quotes.',
    '- Be respectful, avoid political or sectarian bias, and prefer mainstream scholarly consensus when applicable.',
  ].join('\n');

  const userContent = isArabicLanguageCode(detectedLanguageCode)
    ? `The following user message is in Arabic. Translate it to English first, then provide the answer in English.\n\nUser message:\n${userInput}`
    : userInput;

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
      max_tokens: 700,
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

async function uploadToAssemblyAI(localFilePath) {
  const fileStream = fs.createReadStream(localFilePath);
  const response = await axios({
    method: 'post',
    url: `${ASSEMBLY_BASE_URL}/upload`,
    headers: {
      Authorization: assemblyApiKey,
      'Content-Type': 'application/octet-stream',
    },
    data: fileStream,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  return response.data.upload_url;
}

async function createTranscript(uploadUrl) {
  const response = await axios.post(
    `${ASSEMBLY_BASE_URL}/transcript`,
    {
      audio_url: uploadUrl,
      // Enable useful defaults; adjust as needed
      punctuate: true,
      format_text: true,
      language_detection: true,
      // Optionally require a minimum confidence for auto language detection
      language_confidence_threshold: 0.5,
    },
    {
      headers: {
        Authorization: assemblyApiKey,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data; // includes id
}

async function waitForTranscriptCompletion(transcriptId, { intervalMs = 3000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const startedAt = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await axios.get(`${ASSEMBLY_BASE_URL}/transcript/${transcriptId}`, {
      headers: { Authorization: assemblyApiKey },
    });
    const data = response.data;
    if (data.status === 'completed') return data;
    if (data.status === 'error') throw new Error(data.error || 'AssemblyAI transcription error');
    if (Date.now() - startedAt > timeoutMs) throw new Error('AssemblyAI transcription timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function transcribeWithAssemblyAI(localFilePath) {
  if (!assemblyApiKey) {
    throw new Error('Missing ASSEMBLY_API_KEY environment variable');
  }
  const uploadUrl = await uploadToAssemblyAI(localFilePath);
  const transcriptJob = await createTranscript(uploadUrl);
  const result = await waitForTranscriptCompletion(transcriptJob.id);
  console.log('AssemblyAI transcript language:', result.language_code, '(confidence:', result.language_confidence, ')');
  console.log('AssemblyAI transcript:', result.text);
  return {
    text: result.text,
    languageCode: result.language_code,
    languageConfidence: result.language_confidence,
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
    const detectedLangCode = containsArabicScript(incomingText) ? 'ar' : undefined;
    const llmReply = await getMuftiResponseLLM(incomingText, detectedLangCode);
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
    const relativePath = path.relative(process.cwd(), savedPath);
    await bot.sendMessage(chatId, `Voice received (${voice.duration}s). Saved: ${relativePath}`);
    // Transcribe, then send to LLM
    try {
      const { text, languageCode } = await transcribeWithAssemblyAI(savedPath);
      const llmReply = await getMuftiResponseLLM(text, languageCode);
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
    const relativePath = path.relative(process.cwd(), savedPath);
    const title = audio.title ? `Title: ${audio.title}\n` : '';
    await bot.sendMessage(chatId, `Audio received. ${title}Saved: ${relativePath}`);
    // Transcribe, then send to LLM
    try {
      const { text, languageCode } = await transcribeWithAssemblyAI(savedPath);
      const llmReply = await getMuftiResponseLLM(text, languageCode);
      await bot.sendMessage(chatId, llmReply, { parse_mode: 'Markdown' }).catch(() => bot.sendMessage(chatId, llmReply));
    } catch (err) {
      console.error('Transcription/LLM failed:', err);
      await bot.sendMessage(chatId, 'Sorry, I could not transcribe or process your audio file.');
    }
  } catch (error) {
    await bot.sendMessage(chatId, 'Sorry, I could not download your audio file.');
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


