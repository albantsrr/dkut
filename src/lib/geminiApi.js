import { GoogleGenerativeAI } from '@google/generative-ai';

const MODEL = 'gemini-2.5-flash';

function buildSystemInstruction(title, author, chapter) {
  return `Tu es un assistant de lecture utile. Réponds toujours en français, quelle que soit la langue de l'utilisateur.
Livre : "${title}" de ${author}. Chapitre : ${chapter || 'inconnu'}.
Chaque message de l'utilisateur inclut le texte complet du chapitre en cours comme contexte.
Réponds de façon claire et concise (3–5 phrases) sauf si on te demande plus de détails.
Pas de Markdown complexe — texte simple et listes à puces uniquement.`;
}

function buildUserMessage(userText, pageText) {
  if (!pageText || pageText.length < 30) return userText;
  return `Context — current chapter text:\n"""\n${pageText}\n"""\n\nQuestion: ${userText}`;
}

/**
 * Streams a chat reply from Gemini, yielding text chunks.
 */
export async function* streamChatMessage({
  apiKey,
  userMessage,
  pageText,
  bookTitle,
  bookAuthor,
  chapterName,
  history = [],
  signal,
}) {
  if (!apiKey) throw new Error('NO_API_KEY');

  const genAI = new GoogleGenerativeAI(apiKey, { apiVersion: 'v1' });
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: buildSystemInstruction(bookTitle, bookAuthor, chapterName),
  });

  const chat = model.startChat({
    history,
    // thinkingBudget: 0 disables Gemini 2.5's hidden reasoning tokens, which
    // otherwise eat into maxOutputTokens and truncate long responses before
    // any visible text is written.
    generationConfig: { maxOutputTokens: 32768, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } },
  });

  const result = await chat.sendMessageStream(buildUserMessage(userMessage, pageText));

  for await (const chunk of result.stream) {
    if (signal?.aborted) return;
    const text = chunk.text();
    if (text) yield text;
  }
}

/**
 * Generates a full revision sheet document (non-streaming).
 * Returns a markdown string.
 */
export async function generateRevisionSheet({
  apiKey,
  pageText,
  bookTitle,
  bookAuthor,
  chapterName,
}) {
  if (!apiKey) throw new Error('NO_API_KEY');

  const genAI = new GoogleGenerativeAI(apiKey, { apiVersion: 'v1' });
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: 'Tu es un assistant académique. Crée des fiches de révision structurées et concises. Réponds toujours en français. Utilise du Markdown simple avec des titres ## et des listes à puces.',
    generationConfig: { maxOutputTokens: 32768, temperature: 0.5, thinkingConfig: { thinkingBudget: 0 } },
  });

  const chapterLabel = chapterName || 'Chapitre';
  const prompt = `Crée une fiche de révision pour le chapitre "${chapterLabel}" du livre "${bookTitle}" de ${bookAuthor}.

${pageText && pageText.length > 30 ? `En te basant sur ce texte du chapitre :\n"""\n${pageText}\n"""\n` : ''}
Format exact :
# ${chapterLabel} — Fiche de révision

## Résumé
(aperçu du chapitre en 3–5 phrases)

## Concepts clés
- (idées principales, une par puce)

## Termes importants
- **terme** : définition

## Questions de révision
1. (question)
2. (question)
3. (question)`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}
