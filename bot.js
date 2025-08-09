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
  console.log('AssemblyAI transcript:', result.text);
  return result.text;
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
    await bot.sendMessage(chatId, `You said: ${incomingText}`);
  } catch (error) {
    console.error('Failed to respond to text message:', error);
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
    await bot.sendMessage(
      chatId,
      `Received your voice message (duration: ${voice.duration}s). Saved to: ${relativePath}`
    );
    // Transcribe and log
    try {
      await transcribeWithAssemblyAI(savedPath);
    } catch (err) {
      console.error('Transcription failed:', err);
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
    await bot.sendMessage(
      chatId,
      `Received your audio file. ${title}Saved to: ${relativePath}`
    );
    // Transcribe and log
    try {
      await transcribeWithAssemblyAI(savedPath);
    } catch (err) {
      console.error('Transcription failed:', err);
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


