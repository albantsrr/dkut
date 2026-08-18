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

// ── Quiz (QCM) generation — exercises and interview prep, one call each ──

const QUIZ_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    questions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          question: { type: SchemaType.STRING, description: 'Énoncé en français, Markdown autorisé (bloc de code fencé si pertinent)' },
          options: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
            description: 'Exactement 4 choix de réponse, un seul strictement correct',
          },
          correctIndex: { type: SchemaType.NUMBER, description: 'Index (0 à 3) de la réponse correcte dans options' },
          explanation: { type: SchemaType.STRING, description: 'Courte explication de la bonne réponse, en français' },
        },
        required: ['question', 'options', 'correctIndex', 'explanation'],
      },
    },
  },
  required: ['questions'],
};

// Deliberately distinct from ANTI_FABRICATION_RULES: revision sheets must
// never invent examples, but exercises exist specifically to test new
// practice scenarios — they just need to stay inside what the chapter
// actually taught, and favor reasoning over plain definition recall.
const EXERCISE_QUIZ_RULES = `Règles strictes :
- N'utilise QUE les fonctions, méthodes, syntaxe et concepts réellement enseignés dans le texte fourni.
- Varie les types de questions plutôt que d'empiler des questions de définition ; mélange par exemple :
  - prédire le résultat d'un court extrait de code ("Que va afficher ce code ?") ;
  - repérer lequel de plusieurs extraits similaires contient un bug ;
  - compléter une ligne manquante d'un extrait, à choix parmi 4 propositions.
- Le code affiché dans "question" ou "options" est toujours en LECTURE SEULE — l'utilisateur ne fait que choisir une réponse, il n'écrit jamais de code. Utilise des blocs Markdown fencés (\`\`\`) pour tout extrait de code.
- Si une question fait référence à "ce code" ou à un extrait ("Que va afficher ce code ?", "lequel de ces extraits contient un bug ?"), l'extrait de code correspondant DOIT être recopié intégralement et littéralement dans le champ "question" (ou réparti dans "options" pour un choix entre extraits) — ne JAMAIS décrire un code sans le montrer, ne jamais supposer que le lecteur connaît déjà l'extrait auquel tu fais allusion.
- Chaque question doit être ENTIÈREMENT AUTONOME : si le code de la question utilise une classe, fonction ou variable définie plus tôt dans le chapitre (ex. une classe "Vector" présentée dans un exemple précédent), la définition complète de cette classe/fonction DOIT être recopiée dans le champ "question", juste avant le code de la question elle-même — dans le même bloc ou dans un second bloc de code séparé. N'utilise JAMAIS une formulation du type "en utilisant la classe X de l'exemple N" sans reproduire intégralement ce que cette classe/cet exemple contient : le lecteur n'a que le texte de la question sous les yeux, pas le reste du chapitre.
- Les 4 options doivent être plausibles (pas de distracteur absurde), une seule strictement correcte.
- Le code lui-même (identifiants, commentaires) doit toujours être en anglais, conformément aux conventions Python standard, même si l'énoncé est en français.`;

const INTERVIEW_QUIZ_RULES = `Alterne entre questions conceptuelles ("quelle est la différence entre X et Y", "pourquoi utiliser X plutôt que Y") et questions techniques (lire un court extrait de code en lecture seule, prédire un résultat, identifier un piège) — comme dans un vrai entretien technique.
Chaque question doit être ENTIÈREMENT AUTONOME : si un extrait de code utilise une classe, fonction ou variable définie plus tôt dans le chapitre, sa définition complète doit être recopiée dans le champ "question" avant le code de la question — ne jamais renvoyer implicitement vers "l'exemple N" ou "la classe X du chapitre" sans le reproduire, le lecteur n'a que le texte de la question sous les yeux.
${ANTI_FABRICATION_RULES}`;

function buildQuizSystemInstruction(mode) {
  const base = 'Tu es un formateur qui conçoit un QCM (questionnaire à choix multiples) à partir d\'un chapitre. Réponds en français. Chaque question a exactement 4 options, une seule strictement correcte.';
  return mode === 'interview' ? `${base}\n${INTERVIEW_QUIZ_RULES}` : `${base}\n${EXERCISE_QUIZ_RULES}`;
}

// Never trust the structured output blindly: drop any question missing a
// field, without exactly 4 options, or with an out-of-range correctIndex,
// rather than letting a malformed entry crash the quiz player.
function validateQuizQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).filter(q =>
    q && typeof q.question === 'string' &&
    Array.isArray(q.options) && q.options.length === 4 &&
    Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4 &&
    typeof q.explanation === 'string'
  );
}

/**
 * Generates a multiple-choice quiz (mode: 'exercise' | 'interview') for the
 * current chapter, as a single structured call. Returns a validated array
 * of questions (never throws on individual malformed questions — only on
 * missing input or a wholly empty result).
 */
export async function generateQuiz({ apiKey, mode, pageText, bookTitle, bookAuthor, chapterName, signal }) {
  if (!apiKey) throw new Error('NO_API_KEY');
  if (!pageText || pageText.length < 30) throw new Error('NO_PAGE_TEXT');

  const genAI = new GoogleGenerativeAI(apiKey, { apiVersion: 'v1' });
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: buildQuizSystemInstruction(mode),
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 32768,
      responseMimeType: 'application/json',
      responseSchema: QUIZ_SCHEMA,
    },
  });

  const chapterLabel = chapterName || 'Chapitre';
  const kind = mode === 'interview' ? "de préparation à un entretien technique" : "d'exercices pratiques";
  const prompt = `Livre : "${bookTitle}" de ${bookAuthor}. Chapitre : ${chapterLabel}.

Texte du chapitre :
"""
${pageText}
"""

Conçois un QCM ${kind} de 8 à 10 questions, couvrant les concepts réellement enseignés dans ce texte, du plus simple au plus avancé.`;

  const result = await model.generateContent(prompt, { signal });
  const parsed = JSON.parse(result.response.text());
  const questions = validateQuizQuestions(parsed.questions);
  if (questions.length === 0) throw new Error('EMPTY_QUIZ');
  return questions;
}

// ── Whole-book translation (structured batch calls, one per chapter) ──

const TRANSLATION_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    translations: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          id: { type: SchemaType.STRING, description: 'Identifiant recopié tel quel depuis le segment source correspondant' },
          text: { type: SchemaType.STRING, description: 'Texte traduit ; les jetons ⟦N⟧ éventuels doivent être recopiés à l\'identique, à la même position relative' },
        },
        required: ['id', 'text'],
      },
    },
  },
  required: ['translations'],
};

function buildTranslationSystemInstruction(targetLangLabel) {
  return `Tu es un traducteur professionnel. Traduis chaque segment fourni vers ${targetLangLabel}.
Règles strictes :
- Traduis fidèlement le sens de chaque segment ; n'ajoute, ne supprimes, ne fusionnes et ne résumes jamais de contenu.
- N'explique jamais ta traduction, ne commente jamais, ne reformule pas au-delà de ce que la traduction exige.
- Les jetons de la forme ⟦0⟧, ⟦1⟧, ⟦2⟧... marquent du code ou des formules mathématiques masqués : recopie-les EXACTEMENT tels quels (mêmes crochets, même nombre), à la même position relative dans la phrase, sans jamais les traduire ni les modifier.
- Préserve les noms propres, noms de produits et identifiants techniques non masqués tels quels.
- Retourne exactement un objet de sortie par segment d'entrée, avec le même "id".
- Ne retourne jamais un "id" absent de la requête, et n'en invente aucun.`;
}

/**
 * Translates a batch of independent text segments in one structured call.
 * Raw call only — no validation against the request is performed here
 * (see validateBatch in epubTranslator.js, which never trusts this blindly).
 */
export async function translateSegments({ apiKey, segments, targetLangLabel, signal }) {
  if (!apiKey) throw new Error('NO_API_KEY');
  if (!segments?.length) return [];

  const genAI = new GoogleGenerativeAI(apiKey, { apiVersion: 'v1' });
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: buildTranslationSystemInstruction(targetLangLabel),
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: TRANSLATION_SCHEMA,
    },
  });

  const prompt = `Segments à traduire (JSON) :\n${JSON.stringify(segments)}`;
  const result = await model.generateContent(prompt, { signal });
  const parsed = JSON.parse(result.response.text());
  return Array.isArray(parsed.translations) ? parsed.translations : [];
}
