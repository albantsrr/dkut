import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

const MODEL = 'gemini-3.5-flash-lite';

// Ported from the original client-side src/lib/geminiApi.js (see
// MIGRATION_PLAN.md phase 4) — same prompts/schemas/validation, just reading
// the API key from the environment instead of a function parameter, since it
// must never reach the browser once other users share this backend.

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('NO_API_KEY');
  return new GoogleGenerativeAI(apiKey, { apiVersion: 'v1' });
}

function buildSystemInstruction(title, author, chapter) {
  return `Tu es un professeur particulier, pédagogue et clair. Réponds toujours en français, quelle que soit la langue de l'utilisateur.
Livre : "${title}" de ${author}. Chapitre : ${chapter || 'inconnu'}.
Chaque message de l'utilisateur inclut le texte complet du chapitre en cours comme contexte.
Adapte la longueur de ta réponse à la question : reste bref pour une question simple, développe avec une explication structurée et des exemples concrets tirés du texte pour une demande d'explication ou d'approfondissement.
Découpe les idées complexes en étapes plutôt que d'empiler des définitions abstraites.
Le Markdown est bien rendu dans l'interface : utilise titres, gras, listes et blocs de code quand ça sert la clarté.
Pour toute formule mathématique, utilise exclusivement la syntaxe LaTeX standard rendue par KaTeX : "$...$" pour une formule en ligne, "$$...$$" sur ses propres lignes pour une formule isolée. N'utilise jamais de tableaux, de pseudo-fractions en texte brut ni de mise en page ASCII pour représenter une formule.`;
}

function buildUserMessage(userText, pageText) {
  if (!pageText || pageText.length < 30) return userText;
  return `Context — current chapter text:\n"""\n${pageText}\n"""\n\nQuestion: ${userText}`;
}

/**
 * Streams a chat reply from Gemini, yielding text chunks.
 */
export async function* streamChatMessage({
  userMessage,
  pageText,
  bookTitle,
  bookAuthor,
  chapterName,
  history = [],
  signal,
}) {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: buildSystemInstruction(bookTitle, bookAuthor, chapterName),
  });

  const chat = model.startChat({
    history,
    generationConfig: { maxOutputTokens: 32768, temperature: 0.7 },
  });

  const result = await chat.sendMessageStream(buildUserMessage(userMessage, pageText), { signal });

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
  pageText,
  bookTitle,
  bookAuthor,
  chapterName,
}) {
  const genAI = getClient();
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
- Le code lui-même (noms de fonctions, de variables, de classes, et commentaires à l'intérieur du code) doit toujours être en anglais, conformément aux conventions Python standard — même si le reste de la fiche est rédigée en français.`;

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

async function planRevisionSheets({ pageText, bookTitle, bookAuthor, chapterName, signal }) {
  const genAI = getClient();
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
export async function generateSheetForConcept({ pageText, bookTitle, bookAuthor, chapterName, sheet, signal }) {
  const genAI = getClient();
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
export async function* generateRevisionSet({ pageText, bookTitle, bookAuthor, chapterName, signal }) {
  if (!pageText || pageText.length < 30) throw new Error('NO_PAGE_TEXT');
  yield { type: 'planning' };

  let rawSheets;
  try {
    rawSheets = await planRevisionSheets({ pageText, bookTitle, bookAuthor, chapterName, signal });
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
        pageText, bookTitle, bookAuthor, chapterName, sheet: validated[i], signal,
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

const INTERVIEW_QUIZ_RULES = `Alterne entre questions conceptuelles ("quelle est la différence entre X et Y", "pourquoi utiliser X plutôt que Y") et questions techniques (lire un court extrait de code en lecture seule, prédire un résultat, identifier un piège) — comme dans un vrai entretien technique.
Chaque question doit être ENTIÈREMENT AUTONOME : si un extrait de code utilise une classe, fonction ou variable définie plus tôt dans le chapitre, sa définition complète doit être recopiée dans le champ "question" avant le code de la question — ne jamais renvoyer implicitement vers "l'exemple N" ou "la classe X du chapitre" sans le reproduire, le lecteur n'a que le texte de la question sous les yeux.
${ANTI_FABRICATION_RULES}`;

function buildInterviewSystemInstruction() {
  return `Tu es un formateur qui conçoit un QCM (questionnaire à choix multiples) de préparation à un entretien technique, à partir d'un chapitre. Réponds en français. Chaque question a exactement 4 options, une seule strictement correcte.
${INTERVIEW_QUIZ_RULES}`;
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

// ── Open-ended practice exercises (mode: 'exercise') — replaces MCQ ──
//
// Unlike interview prep (QUIZ_SCHEMA, always MCQ), practice exercises are
// open-ended and AI-graded (see gradeOpenExercise below) rather than
// multiple-choice. The app hosts arbitrary non-fiction books, not just
// programming ones, so the exercise "type" is never forced — Gemini picks it
// per exercise based on what the chapter actually teaches (a code-heavy
// chapter yields mostly "code" exercises, a theoretical one mostly
// "written").
const OPEN_EXERCISE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    questions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          type: { type: SchemaType.STRING, description: '"code", "math" ou "written" — le format le plus adapté à ce que ce point précis du chapitre enseigne réellement' },
          prompt: { type: SchemaType.STRING, description: 'Énoncé en français, Markdown et LaTeX ($...$/$$...$$) autorisés, entièrement autonome' },
          language: { type: SchemaType.STRING, description: 'Langage de programmation si type="code" (ex. "python"), chaîne vide sinon' },
          starterCode: { type: SchemaType.STRING, description: 'Squelette de départ optionnel si type="code" (peut être vide)' },
          expectedApproach: { type: SchemaType.STRING, description: 'Note interne, jamais montrée à l\'utilisateur : ce qu\'une bonne réponse doit couvrir, ancré dans le texte fourni — sert uniquement à la correction ultérieure' },
          expectedResult: {
            type: SchemaType.OBJECT,
            description: 'Uniquement si type="math" ET l\'exercice a une valeur numérique finale unique et vérifiable (jamais pour une preuve ou une dérivation ouverte) — omis dans tous les autres cas',
            properties: {
              valueExpr: { type: SchemaType.STRING, description: 'La valeur attendue, sous forme d\'expression évaluable par mathjs (fractions, pi, e, opérateurs standards) — ex. "3/4", "2*pi"' },
              tolerance: { type: SchemaType.NUMBER, description: 'Tolérance relative optionnelle pour la comparaison numérique (défaut 1e-6 si absente)' },
            },
            required: ['valueExpr'],
          },
          hints: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
            description: '1 à 3 indices progressifs (du plus vague au plus précis), affichés uniquement si le lecteur clique sur "Indice" — jamais la réponse elle-même. Le nombre et la précision des indices dépendent de la difficulté réelle de l\'exercice.',
          },
        },
        required: ['type', 'prompt', 'expectedApproach', 'hints'],
      },
    },
  },
  required: ['questions'],
};

const OPEN_EXERCISE_RULES = `Règles strictes :
- Pour chaque exercice, choisis le "type" le plus adapté à ce que ce point précis du chapitre enseigne réellement : "code" seulement si le chapitre présente effectivement du code à ce sujet, "math" pour un calcul ou une dérivation, "written" pour une question conceptuelle ou de conception. Ne force JAMAIS "code" sur un chapitre qui n'en contient pas — un chapitre théorique peut n'avoir que des exercices "written".
- Mélange naturellement les types selon la densité réelle du chapitre plutôt que de viser un quota fixe par type.
- N'utilise QUE les concepts, la syntaxe et les exemples réellement présents dans le texte fourni.
- Chaque "prompt" doit être ENTIÈREMENT AUTONOME : si l'exercice s'appuie sur une classe, fonction, formule ou exemple présenté plus tôt dans le chapitre, il DOIT être recopié intégralement dans "prompt" — le lecteur n'a que ce texte sous les yeux, pas le reste du chapitre.
- Pour un exercice "code" : "language" indique le langage (ex. "python"), "starterCode" peut fournir un squelette ou une signature de départ (facultatif, laisser vide si non pertinent). Les identifiants et commentaires du code restent en anglais, conformément aux conventions Python standard.
- "expectedApproach" (jamais affiché à l'utilisateur) doit décrire concrètement ce qu'une réponse correcte doit couvrir, en citant des éléments réellement présents dans le texte fourni — jamais une connaissance générique hors du texte. C'est ce qui servira de base à la correction.
- Pour un exercice "math" : si (et seulement si) il a une valeur numérique finale unique et vérifiable (jamais pour une preuve, une dérivation ouverte ou une démonstration), remplis "expectedResult.valueExpr" avec cette valeur sous forme d'expression évaluable par mathjs (fractions, pi, e, opérateurs standards) — sinon omets entièrement ce champ, ne force jamais une valeur numérique sur un exercice qui n'en a pas.
- "hints" : adapte le nombre et la précision des indices à la difficulté réelle de l'exercice — un exercice simple peut n'avoir qu'un seul indice bref, un exercice difficile 2 à 3 indices progressifs (du plus vague au plus précis). Un indice pointe vers la bonne direction (un concept à revoir, une piste de raisonnement) mais NE DOIT JAMAIS révéler la réponse elle-même ni le code/la formule finale.
- Formatage impératif de tout code dans "prompt"/"hints" : plusieurs instructions liées entre elles vont dans UN SEUL bloc de code fencé (\`\`\`), jamais énumérées en prose séparées par des virgules. Un identifiant ou une expression isolée cité en ligne reste entre backticks simples (\`comme_ceci\`).
${ANTI_FABRICATION_RULES}`;

function buildOpenExerciseSystemInstruction() {
  return `Tu es un formateur qui conçoit des exercices pratiques ouverts à partir d'un chapitre — pas des QCM, l'utilisateur rédige une vraie réponse. Réponds en français.
${OPEN_EXERCISE_RULES}`;
}

const OPEN_EXERCISE_TYPES = new Set(['code', 'math', 'written']);

// Same "normalize, never reject the whole exercise" philosophy as the hints
// handling below — a malformed/missing expectedResult just means no
// "Vérifier" button shows for that exercise, not that it's dropped.
function validateExpectedResult(q) {
  if (q.type !== 'math' || !q.expectedResult || typeof q.expectedResult.valueExpr !== 'string' || !q.expectedResult.valueExpr.trim()) {
    return undefined;
  }
  const tolerance = Number(q.expectedResult.tolerance);
  return {
    valueExpr: q.expectedResult.valueExpr.trim(),
    tolerance: Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 1e-6,
  };
}

// Same defensive philosophy as validateQuizQuestions — never trust the
// structured output blindly. `hints` is normalized rather than a rejection
// criterion: a missing/malformed hints array just means the hint button
// won't show for that exercise, not that the whole exercise is dropped.
function validateOpenExercises(questions) {
  return (Array.isArray(questions) ? questions : [])
    .filter(q =>
      q && OPEN_EXERCISE_TYPES.has(q.type) &&
      typeof q.prompt === 'string' && q.prompt.trim().length > 0 &&
      typeof q.expectedApproach === 'string' && q.expectedApproach.trim().length > 0
    )
    .map(q => ({
      ...q,
      hints: Array.isArray(q.hints) ? q.hints.filter(h => typeof h === 'string' && h.trim().length > 0) : [],
      expectedResult: validateExpectedResult(q),
    }));
}

/**
 * Generates a quiz for the current chapter, as a single structured call.
 * mode: 'interview' → multiple-choice (QUIZ_SCHEMA), for rehearsing quick
 * verbal answers. mode: 'exercise' → open-ended, AI-graded exercises
 * (OPEN_EXERCISE_SCHEMA) — the two modes now return structurally different
 * item shapes, so they're handled as separate branches rather than forced
 * through one shared code path. Never throws on individual malformed
 * entries (validation drops them) — only on missing input or a wholly empty
 * result.
 */
export async function generateQuiz({ mode, pageText, bookTitle, bookAuthor, chapterName, signal }) {
  const genAI = getClient();
  if (!pageText || pageText.length < 30) throw new Error('NO_PAGE_TEXT');
  const chapterLabel = chapterName || 'Chapitre';

  if (mode === 'interview') {
    const model = genAI.getGenerativeModel({
      model: MODEL,
      systemInstruction: buildInterviewSystemInstruction(),
      generationConfig: {
        temperature: 0.5,
        maxOutputTokens: 32768,
        responseMimeType: 'application/json',
        responseSchema: QUIZ_SCHEMA,
      },
    });
    const prompt = `Livre : "${bookTitle}" de ${bookAuthor}. Chapitre : ${chapterLabel}.

Texte du chapitre :
"""
${pageText}
"""

Conçois un QCM de préparation à un entretien technique de 8 à 10 questions, couvrant les concepts réellement enseignés dans ce texte, du plus simple au plus avancé.`;

    const result = await model.generateContent(prompt, { signal });
    const parsed = JSON.parse(result.response.text());
    const questions = validateQuizQuestions(parsed.questions);
    if (questions.length === 0) throw new Error('EMPTY_QUIZ');
    return questions;
  }

  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: buildOpenExerciseSystemInstruction(),
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 32768,
      responseMimeType: 'application/json',
      responseSchema: OPEN_EXERCISE_SCHEMA,
    },
  });
  const prompt = `Livre : "${bookTitle}" de ${bookAuthor}. Chapitre : ${chapterLabel}.

Texte du chapitre :
"""
${pageText}
"""

Conçois de 8 à 10 exercices pratiques ouverts, couvrant les concepts réellement enseignés dans ce texte, du plus simple au plus avancé.`;

  const result = await model.generateContent(prompt, { signal });
  const parsed = JSON.parse(result.response.text());
  const questions = validateOpenExercises(parsed.questions);
  if (questions.length === 0) throw new Error('EMPTY_QUIZ');
  return questions;
}

// ── Pomodoro cycle exercises (2-3 questions on what was just read) ──

// Grounds exercises in the pages read during a single ~25-minute reading
// cycle rather than a whole chapter — that span can cover several chapters,
// so unlike generateQuiz's pageText (always one chapter), this one may be a
// concatenation of several. Capped to the tail so cost/latency stay bounded
// and the most recently read material is weighted most heavily.
const SESSION_TEXT_CHAR_CAP = 15000;

function capSessionText(pageText) {
  if (!pageText || pageText.length <= SESSION_TEXT_CHAR_CAP) return pageText;
  return pageText.slice(pageText.length - SESSION_TEXT_CHAR_CAP);
}

const SESSION_QUIZ_SYSTEM_INSTRUCTION = `Tu es un formateur qui conçoit de très courts exercices pratiques ouverts à partir des pages qu'un lecteur vient de lire pendant une session de 25 minutes — ce texte peut couvrir la fin d'un chapitre et le début du suivant. Réponds en français.
${OPEN_EXERCISE_RULES}`;

/**
 * Generates 2-3 short open-ended practice exercises grounded in the text
 * read during one Pomodoro reading cycle. Always exercise-flavored (there is
 * no interview-prep equivalent for Pomodoro sessions). Deliberately not
 * cached anywhere (unlike generateQuiz) — each cycle asks fresh exercises,
 * and nothing is persisted until the whole cycle is scored (see
 * pomodoroLog.js).
 */
export async function generateSessionExercises({ pageText, bookTitle, bookAuthor, chapterName, signal }) {
  const genAI = getClient();
  if (!pageText || pageText.length < 30) throw new Error('NO_PAGE_TEXT');
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: SESSION_QUIZ_SYSTEM_INSTRUCTION,
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 6144,
      responseMimeType: 'application/json',
      responseSchema: OPEN_EXERCISE_SCHEMA,
    },
  });

  const prompt = `Livre : "${bookTitle}" de ${bookAuthor}. Pages lues pendant cette session : ${chapterName || 'inconnu'}.

Texte lu pendant cette session de lecture :
"""
${capSessionText(pageText)}
"""

Conçois 2 à 3 exercices pratiques ouverts et courts, uniquement sur ce qui vient d'être lu.`;

  const result = await model.generateContent(prompt, { signal });
  const parsed = JSON.parse(result.response.text());
  const questions = validateOpenExercises(parsed.questions);
  if (questions.length === 0) throw new Error('EMPTY_QUIZ');
  return questions;
}

// ── Grading a submitted answer to one open exercise ──
//
// Called once per submitted answer (never pre-computed at generation time).
// Grades against `exercise.expectedApproach` and the original chapter text,
// not generic outside knowledge — same grounding discipline as generation.

const GRADING_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    verdict: { type: SchemaType.STRING, description: '"correct", "partial" ou "incorrect"' },
    feedback: { type: SchemaType.STRING, description: 'Retour en français, doit citer un élément concret du chapitre pour justifier le verdict. Tout identifiant, expression ou instruction de code DOIT être formaté en Markdown : bloc de code fencé (```) pour toute séquence de plusieurs instructions liées, backticks simples (`) pour un identifiant ou une expression isolée cité en ligne. Formules mathématiques en LaTeX ($...$/$$...$$).' },
  },
  required: ['verdict', 'feedback'],
};

const GRADING_RULES = `Tu corriges la réponse d'un lecteur à un exercice pratique, à partir du texte du chapitre et de la piste attendue pour une bonne réponse.
Règles strictes :
- "verdict" vaut "correct" si la réponse couvre l'essentiel de la piste attendue, "partial" si elle va dans la bonne direction mais reste incomplète, imprécise ou partiellement fausse, "incorrect" si elle passe à côté du concept ou contient une erreur de fond.
- N'exige JAMAIS un point absent de la piste attendue — juge uniquement par rapport à ce qui y est décrit, pas par rapport à une connaissance générale plus large.
- "feedback" doit être constructif : dire ce qui est juste, ce qui manque ou est faux, et citer un élément concret du texte du chapitre pour appuyer le verdict — jamais un jugement générique déconnecté du chapitre.
- Reste bref et direct : quelques phrases suffisent, ce n'est pas une nouvelle leçon complète.
- Formatage impératif de tout code dans "feedback" : si tu cites plusieurs instructions liées entre elles (ex. une suite d'affectations ou d'appels qui forment un raisonnement), regroupe-les dans UN SEUL bloc de code fencé (\`\`\`) avec des retours à la ligne entre chaque instruction — jamais une suite d'instructions séparées par des virgules dans une phrase en prose. Un identifiant ou une expression isolée cité en ligne dans une phrase reste entre backticks simples (\`comme_ceci\`). N'écris jamais de code brut sans formatage Markdown.
${ANTI_FABRICATION_RULES}`;

const GRADING_VERDICTS = new Set(['correct', 'partial', 'incorrect']);

// Stricter than validateQuizQuestions/validateOpenExercises, which silently
// filter out malformed entries — a grading result is displayed and scored
// as-is, so a malformed one must fail loudly rather than be coerced.
function validateGrading(parsed) {
  if (!parsed || !GRADING_VERDICTS.has(parsed.verdict) || typeof parsed.feedback !== 'string' || !parsed.feedback.trim()) {
    throw new Error('INVALID_GRADING');
  }
  return { verdict: parsed.verdict, feedback: parsed.feedback };
}

export async function gradeOpenExercise({ exercise, pageText, userAnswer, bookTitle, bookAuthor, chapterName, signal }) {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: GRADING_RULES,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: GRADING_SCHEMA,
    },
  });

  const prompt = `Livre : "${bookTitle}" de ${bookAuthor}. Chapitre : ${chapterName || 'inconnu'}.

Texte du chapitre (contexte) :
"""
${capSessionText(pageText)}
"""

Exercice posé (type : ${exercise?.type}) :
"""
${exercise?.prompt}
"""

Piste attendue pour une bonne réponse (usage interne, ne pas la citer littéralement dans le feedback) :
"""
${exercise?.expectedApproach}
"""

Réponse soumise par le lecteur :
"""
${userAnswer}
"""

Corrige cette réponse.`;

  const result = await model.generateContent(prompt, { signal });
  const parsed = JSON.parse(result.response.text());
  return validateGrading(parsed);
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
 * (see validateBatch in src/lib/epubTranslator.js, which never trusts this blindly).
 */
export async function translateSegments({ segments, targetLangLabel, signal }) {
  const genAI = getClient();
  if (!segments?.length) return [];
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
