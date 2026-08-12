import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

const MODEL = 'gemini-3.5-flash-lite';

function buildSystemInstruction(title, author, chapter) {
  return `Tu es un professeur particulier, pédagogue et clair. Réponds toujours en français, quelle que soit la langue de l'utilisateur.
Livre : "${title}" de ${author}. Chapitre : ${chapter || 'inconnu'}.
Chaque message de l'utilisateur inclut le texte complet du chapitre en cours comme contexte.
Adapte la longueur de ta réponse à la question : reste bref pour une question simple, développe avec une explication structurée et des exemples concrets tirés du texte pour une demande d'explication ou d'approfondissement.
Découpe les idées complexes en étapes plutôt que d'empiler des définitions abstraites.
Le Markdown est bien rendu dans l'interface : utilise titres, gras, listes et blocs de code quand ça sert la clarté.`;
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
    generationConfig: { maxOutputTokens: 32768, temperature: 0.7 },
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
    generationConfig: { maxOutputTokens: 32768, temperature: 0.5 },
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

/**
 * Generates an interview-prep document: a mix of conceptual and
 * technical/practical questions with model answers, grounded in the
 * current chapter (non-streaming). Returns a markdown string.
 */
export async function generateInterviewPrep({
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
    systemInstruction: `Tu es un recruteur technique qui prépare un candidat à un entretien sur le contenu d'un chapitre. Réponds toujours en français, en Markdown avec des titres ##.
${ANTI_FABRICATION_RULES}`,
    generationConfig: { maxOutputTokens: 32768, temperature: 0.5 },
  });

  const chapterLabel = chapterName || 'Chapitre';
  const prompt = `Prépare une session d'entretien technique pour le chapitre "${chapterLabel}" du livre "${bookTitle}" de ${bookAuthor}.

${pageText && pageText.length > 30 ? `En te basant sur ce texte du chapitre :\n"""\n${pageText}\n"""\n` : ''}
Génère entre 6 et 10 questions, en alternant :
- des questions conceptuelles ("expliquez X", "quelle est la différence entre X et Y", "pourquoi utiliser X plutôt que Y") ;
- des questions techniques/pratiques (lire ou compléter un court extrait de code, prédire un résultat, identifier un piège).

Format exact, une section par question :
# ${chapterLabel} — Préparation d'entretien

## Question 1 (conceptuelle | technique)
(énoncé de la question)

**Réponse :**
(réponse modèle complète)

## Question 2 (conceptuelle | technique)
...`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}

// ── Multi-call revision set (one plan call + one call per concept) ──
//
// Replaces cramming N sheets into a single response: a long one-shot
// generation was observed to dilute rule-following (fabricated examples,
// under-developed sections) as it progressed. Splitting into focused,
// independent calls keeps each generation short enough that the model's
// full attention stays on one concept and one set of rules.

const PLAN_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    sheets: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          slug: { type: SchemaType.STRING, description: 'kebab-case, sans extension' },
          title: { type: SchemaType.STRING, description: 'Titre pédagogique EN FRANÇAIS — jamais une copie ou traduction littérale de sourceHeading' },
          sourceHeading: { type: SchemaType.STRING, description: 'Ligne de titre exacte copiée du texte source, sans le préfixe # — dans la langue d\'origine du texte, ne pas traduire' },
        },
        required: ['slug', 'title', 'sourceHeading'],
      },
    },
  },
  required: ['sheets'],
};

const PLAN_SYSTEM_INSTRUCTION = `Tu es un professeur qui découpe un chapitre en fiches de révision pédagogiques.
Identifie uniquement les concepts réellement enseignés dans le texte fourni, un par fiche : regroupe les concepts fortement liés, sépare ceux qui peuvent être compris indépendamment.
Chaque "sourceHeading" doit être une ligne de titre (précédée d'un ou plusieurs # dans le texte, de # à ######) copiée MOT POUR MOT depuis le texte fourni, sans le préfixe # — n'invente aucun titre, ne le traduis pas, ne le paraphrase pas. Les sous-titres profonds (####, #####, ######) sont des frontières de concept tout aussi valables que les titres principaux — ne te limite pas aux premiers niveaux.
Ne crée pas de fiche pour un titre qui n'apparaît pas littéralement dans le texte.
Le champ "title" doit toujours être rédigé en français, quelle que soit la langue du texte source — c'est une reformulation pédagogique, jamais une simple traduction ou copie de "sourceHeading".
Vise entre 6 et 20 fiches selon la densité réelle du chapitre ; ne force pas un nombre fixe.
Respecte l'ordre pédagogique du chapitre : si un concept sert de prérequis à un autre, il doit apparaître avant dans la liste.`;

const ANTI_FABRICATION_RULES = `Règles strictes :
- N'invente JAMAIS un nom de classe, de fonction ou de variable absent du texte source fourni.
- N'utilise QUE la syntaxe et les opérateurs effectivement présents dans le texte fourni.
- Adapte les exemples déjà présents dans le texte plutôt que d'en inventer de nouveaux ; ne fusionne pas deux exemples distincts du texte en un seul exemple composite.
- Si aucun exemple concret n'existe dans le texte pour ce concept précis, écris "Aucun exemple de code n'est fourni dans le texte pour ce concept" plutôt que d'en improviser un.
- Reste strictement centré sur le concept demandé, pas sur les autres sections du chapitre.
- Le code lui-même (noms de fonctions, de variables, de classes, et commentaires à l'intérieur du code) doit toujours être en anglais, conformément aux conventions Python standard — même si le reste de la fiche est rédigé en français.`;

const PEDAGOGY_RULES = `Cette fiche sera lue après le chapitre et avant les exercices, comme support de consolidation.
Privilégie : les explications progressives, les exemples concrets, les explications du « pourquoi », les cas d'utilisation, les pièges fréquents, les distinctions avec les concepts proches du chapitre.
Évite les définitions extrêmement condensées ; la longueur doit dépendre de la complexité du concept, pas d'un objectif de brièveté.`;

function buildSheetStructure({ bookTitle, bookAuthor, chapterName }) {
  return `# <Titre du concept, en français>

**Livre :** ${bookTitle} de ${bookAuthor}
**Chapitre :** ${chapterName || 'inconnu'}

## Le problème
## Le concept
## Exemple
## Quand l'utiliser ?
## Points importants
## Pièges à éviter
## À retenir

Adapte cette structure si une section n'a pas de sens pour ce concept précis — ne force pas une section vide.
Le bloc "Livre"/"Chapitre" doit être recopié exactement comme ci-dessus, avec les vraies valeurs fournies plus haut.`;
}

const SHEET_SYSTEM_INSTRUCTION = `Tu es un assistant académique qui rédige UNE fiche de révision ciblée sur UN SEUL concept d'un chapitre.
Réponds en français (conserve les termes techniques anglais usuels), en Markdown avec des titres ##.
${ANTI_FABRICATION_RULES}
${PEDAGOGY_RULES}`;

// Heading lines as left by capturePageText() in Reader.jsx: "# " through "###### " prefix.
function extractHeadingLines(pageText) {
  const matches = (pageText || '').match(/^#{1,6}\s+.+$/gm) || [];
  return matches.map(line => line.replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').trim());
}

// Defense in depth: the plan call is asked to copy headings verbatim, but we
// don't trust that blindly — drop any sheet whose sourceHeading doesn't
// actually match a real heading in the source text, before spending a
// generation call on it.
function validatePlanAgainstHeadings(sheets, pageText) {
  const headings = new Set(extractHeadingLines(pageText));
  return (Array.isArray(sheets) ? sheets : []).filter(
    s => s && typeof s.sourceHeading === 'string' && headings.has(s.sourceHeading.replace(/\s+/g, ' ').trim())
  );
}

async function planRevisionSheets({ apiKey, pageText, bookTitle, bookAuthor, chapterName, signal }) {
  const genAI = new GoogleGenerativeAI(apiKey, { apiVersion: 'v1' });
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: PLAN_SYSTEM_INSTRUCTION,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: PLAN_SCHEMA,
    },
  });

  const headings = extractHeadingLines(pageText);
  const headingChecklist = headings.length > 0
    ? `\n\nTitres et sous-titres détectés dans le texte, dans l'ordre (checklist — pour chacun, décide explicitement de lui donner sa propre fiche ou de le regrouper avec un titre voisin, ne l'ignore pas silencieusement) :\n${headings.map(h => `- ${h}`).join('\n')}`
    : '';

  const prompt = `Livre : "${bookTitle}" de ${bookAuthor}. Chapitre : ${chapterName || 'inconnu'}.

Texte du chapitre :
"""
${pageText}
"""${headingChecklist}`;

  const result = await model.generateContent(prompt, { signal });
  const parsed = JSON.parse(result.response.text());
  return Array.isArray(parsed.sheets) ? parsed.sheets : [];
}

function buildSheetPrompt({ pageText, sheet, chapterName, bookTitle, bookAuthor }) {
  return `Livre : "${bookTitle}" de ${bookAuthor}. Chapitre : ${chapterName || 'inconnu'}.

Texte complet du chapitre (source de vérité — n'utilise que ce qui y figure réellement) :
"""
${pageText}
"""

Concept ciblé pour cette fiche : "${sheet.title}" (section source du chapitre : "${sheet.sourceHeading}", dans sa langue d'origine)

Structure à suivre :
${buildSheetStructure({ bookTitle, bookAuthor, chapterName })}

Rappel : ${ANTI_FABRICATION_RULES}
Rappel : rédige l'intégralité de la fiche en français, y compris la section "À retenir" — même si le texte source ou le titre de la section sont dans une autre langue, traduis-les, ne les recopie jamais tels quels.`;
}

/**
 * Generates a single revision sheet for one planned concept (non-streaming).
 * Exported standalone so a failed card can be retried without re-running
 * the whole set.
 */
export async function generateSheetForConcept({ apiKey, pageText, bookTitle, bookAuthor, chapterName, sheet, signal }) {
  if (!apiKey) throw new Error('NO_API_KEY');

  const genAI = new GoogleGenerativeAI(apiKey, { apiVersion: 'v1' });
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: SHEET_SYSTEM_INSTRUCTION,
    generationConfig: { maxOutputTokens: 3072, temperature: 0.4 },
  });

  const result = await model.generateContent(
    buildSheetPrompt({ pageText, sheet, chapterName, bookTitle, bookAuthor }),
    { signal }
  );
  return result.response.text();
}

/**
 * Plans then generates a full set of concept-based revision sheets for the
 * current chapter. Async generator yielding progress events:
 *   { type: 'planning' }
 *   { type: 'plan', sheets: [{ slug, title, sourceHeading }, ...] }
 *   { type: 'sheet-start', index }
 *   { type: 'sheet-done', index, text }
 *   { type: 'sheet-error', index, error }
 *   { type: 'plan-error', error }
 *   { type: 'aborted', fromIndex? }
 *   { type: 'done' }
 */
export async function* generateRevisionSet({ apiKey, pageText, bookTitle, bookAuthor, chapterName, signal }) {
  if (!apiKey) throw new Error('NO_API_KEY');
  if (!pageText || pageText.length < 30) throw new Error('NO_PAGE_TEXT');

  yield { type: 'planning' };

  let rawSheets;
  try {
    rawSheets = await planRevisionSheets({ apiKey, pageText, bookTitle, bookAuthor, chapterName, signal });
  } catch (err) {
    if (err.name === 'AbortError') { yield { type: 'aborted' }; return; }
    yield { type: 'plan-error', error: err.message || 'NETWORK' };
    return;
  }

  const validated = validatePlanAgainstHeadings(rawSheets, pageText).slice(0, 25);
  if (validated.length === 0) {
    yield { type: 'plan-error', error: 'EMPTY_PLAN' };
    return;
  }
  yield { type: 'plan', sheets: validated };

  for (let i = 0; i < validated.length; i++) {
    if (signal?.aborted) { yield { type: 'aborted', fromIndex: i }; return; }
    yield { type: 'sheet-start', index: i };
    try {
      const text = await generateSheetForConcept({
        apiKey, pageText, bookTitle, bookAuthor, chapterName, sheet: validated[i], signal,
      });
      yield { type: 'sheet-done', index: i, text };
    } catch (err) {
      if (err.name === 'AbortError') { yield { type: 'aborted', fromIndex: i }; return; }
      yield { type: 'sheet-error', index: i, error: err.message || 'NETWORK' };
    }
  }
  yield { type: 'done' };
}

// ── Learning package (paired exercises + solutions, one call) ──

const LEARNING_PACKAGE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    exercises: { type: SchemaType.STRING, description: 'Document Markdown complet des exercices, en français' },
    solutions: { type: SchemaType.STRING, description: 'Document Markdown complet des solutions, en français, même numérotation que exercises' },
  },
  required: ['exercises', 'solutions'],
};

// Deliberately distinct from ANTI_FABRICATION_RULES: revision sheets must
// never invent examples, but exercises exist specifically to be new practice
// problems — they just need to stay inside what the chapter actually taught.
const EXERCISE_SCOPE_RULES = `Règles strictes :
- Les exercices doivent être des scénarios NOUVEAUX (ne recopie pas les exemples du livre tels quels) — c'est le but d'un exercice.
- N'utilise QUE les fonctions, méthodes, syntaxe et concepts réellement enseignés dans le texte fourni ; n'exige aucune bibliothèque ou notion externe non mentionnée dans le chapitre.
- Chaque exercice doit être réalisable avec uniquement ce qui a été enseigné jusqu'ici dans ce texte.
- La numérotation des exercices dans "exercises" et des solutions dans "solutions" doit correspondre exactement (Exercice 1 ↔ Solution 1, etc.).
- Le code lui-même (noms de fonctions, de variables, de classes, et commentaires à l'intérieur du code) doit toujours être en anglais, conformément aux conventions Python standard — même si les énoncés et explications sont en français.`;

const LEARNING_PACKAGE_SYSTEM_INSTRUCTION = `Tu es un formateur qui conçoit des exercices de code pratiques à partir d'un chapitre.
Réponds en français pour les énoncés et explications ; le code doit toujours être en anglais (identifiants et commentaires).
Utilise du Markdown avec des titres ##.
${EXERCISE_SCOPE_RULES}`;

/**
 * Generates a paired learning package: a set of code exercises and their
 * corrected solutions, grounded in the current chapter (single structured
 * call so the two documents stay numbered consistently).
 */
export async function generateLearningPackage({
  apiKey,
  pageText,
  bookTitle,
  bookAuthor,
  chapterName,
  signal,
}) {
  if (!apiKey) throw new Error('NO_API_KEY');
  if (!pageText || pageText.length < 30) throw new Error('NO_PAGE_TEXT');

  const genAI = new GoogleGenerativeAI(apiKey, { apiVersion: 'v1' });
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: LEARNING_PACKAGE_SYSTEM_INSTRUCTION,
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 32768,
      responseMimeType: 'application/json',
      responseSchema: LEARNING_PACKAGE_SCHEMA,
    },
  });

  const chapterLabel = chapterName || 'Chapitre';
  const prompt = `Livre : "${bookTitle}" de ${bookAuthor}. Chapitre : ${chapterLabel}.

Texte du chapitre :
"""
${pageText}
"""

Conçois entre 4 et 8 exercices de code à écrire par le lecteur, du plus simple au plus avancé, couvrant les concepts réellement enseignés dans ce texte.

Format de "exercises" :
# ${chapterLabel} — Exercices

## Exercice 1
(énoncé, éventuellement avec un point de départ de code à compléter)

## Exercice 2
...

Format de "solutions" :
# ${chapterLabel} — Solutions

## Solution 1
\`\`\`python
(code corrigé complet)
\`\`\`
(courte explication si utile)

## Solution 2
...`;

  const result = await model.generateContent(prompt, { signal });
  const parsed = JSON.parse(result.response.text());
  return { exercises: parsed.exercises, solutions: parsed.solutions };
}
