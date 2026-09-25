const { buildGradeProfile } = require("./gradeProfiles");

const GROQ_MODEL = "openai/gpt-oss-120b";

const GROQ_FALLBACK_MODELS = (
  process.env.GROQ_FALLBACK_MODELS || "openai/gpt-oss-20b"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const GROQ_BASE_URL = "https://api.groq.com/openai/v1/chat/completions";

const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS_PER_MODEL = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const QUIZ_QUESTION_COUNT = 10;

const MAX_OUTPUT_TOKENS = 4096;

const MAX_JSON_PARSE_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function getVideoApiKey() {
  return process.env.GROQ_API_KEY || null;
}

function getQuizApiKeys() {
  const keys = [process.env.GROQ_API_KEY_QUIZ];
  for (let i = 2; i <= 10; i++) {
    keys.push(process.env[`GROQ_API_KEY_QUIZ_${i}`]);
  }
  return keys.filter(Boolean);
}

// Prints counts only, never the keys themselves.
(function logKeyStatus() {
  const video = getVideoApiKey();
  const quiz = getQuizApiKeys();
  console.log(
    `Groq keys loaded: video=${video ? 1 : 0}, quiz=${quiz.length}`,
  );
  console.log(
    `Groq models: main=${GROQ_MODEL}, fallback=[${GROQ_FALLBACK_MODELS.join(", ")}]`,
  );
  if (video && quiz.includes(video)) {
    console.warn(
      "WARNING: a quiz key is identical to the video key. They share one quota; use separate Groq projects/keys.",
    );
  }
})();

// ---------------------------------------------------------------------------
// Low-level call
// ---------------------------------------------------------------------------

// The key is REQUIRED (no default), so a missing quiz key can never
// silently turn into the video key.
async function callGroq(prompt, apiKey, model = GROQ_MODEL) {
  if (!apiKey) throw new Error("Groq API key is missing for this call.");

  const response = await fetch(GROQ_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`, // header instead of a query param so it stays out of URLs and logs
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: MAX_OUTPUT_TOKENS,
      // Groq's OpenAI-compatible endpoint supports JSON mode on supported
      // models; every prompt in this file already asks for raw JSON, so
      // this just gives the model a stronger nudge to comply.
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`Groq API error: ${response.status} ${errText}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const choice = data?.choices?.[0];
  const text = choice?.message?.content;

  if (!text) throw new Error("Groq returned no content.");

  // If the response was cut off for hitting the token ceiling, surface that
  // clearly instead of letting a truncated JSON.parse() fail mysteriously
  // further up the stack.
  if (choice?.finish_reason === "length") {
    console.warn(
      `Groq response hit the token limit (${MAX_OUTPUT_TOKENS}). Output was likely truncated.`,
    );
  }

  return text;
}

// Retries overloaded / server errors, then falls back to other models.
// Any non-5xx error (including 429) is thrown straight through, so the quiz
// key rotation below still works exactly as before.
async function callWithResilience(prompt, apiKey) {
  const models = [GROQ_MODEL, ...GROQ_FALLBACK_MODELS];
  let lastError;

  for (const model of models) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        return await callGroq(prompt, apiKey, model);
      } catch (err) {
        lastError = err;
        if (!RETRYABLE_STATUSES.has(err.status)) throw err;

        console.warn(
          `${model} returned ${err.status} (attempt ${attempt + 1}/${MAX_ATTEMPTS_PER_MODEL}).`,
        );

        // Wait before retrying the same model; skip the wait when moving on to the next model.
        if (attempt < MAX_ATTEMPTS_PER_MODEL - 1) {
          await sleep(1000 * 2 ** attempt + Math.random() * 500);
        }
      }
    }
    console.warn(
      `${model} is still unavailable; trying the next model (if any).`,
    );
  }

  throw lastError;
}

// Video pipeline: video key only, no failover to quiz keys.
async function callGroqForVideo(prompt) {
  const key = getVideoApiKey();
  if (!key) throw new Error("GROQ_API_KEY (video) is not set.");
  return callWithResilience(prompt, key);
}

// Quiz pipeline: quiz keys only. Starts at a different key each time to spread
// load, and moves to the next key ONLY on a 429 (quota) error.
let nextQuizKey = 0;

async function callGroqForQuiz(prompt) {
  const keys = getQuizApiKeys();
  if (keys.length === 0)
    throw new Error("GROQ_API_KEY_QUIZ (quiz) is not set.");

  const start = nextQuizKey++ % keys.length;
  let lastError;

  for (let i = 0; i < keys.length; i++) {
    const index = (start + i) % keys.length;
    try {
      return await callWithResilience(prompt, keys[index]);
    } catch (err) {
      lastError = err;
      if (err.status !== 429) throw err; // only switch keys on quota errors
      console.warn(
        `Quiz key #${index + 1} hit its quota; trying the next key.`,
      );
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------------

function stripMarkdownFences(raw) {
  return raw.replace(/```json|```/g, "").trim();
}

// Tries to parse Groq's text as JSON. If it's truncated or malformed, this
// throws a descriptive error (with a snippet of the offending text logged)
// instead of a bare "Unterminated string..." from JSON.parse.
function parseJsonResponse(raw, context) {
  const cleaned = stripMarkdownFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error(
      `Failed to parse Groq JSON for ${context}. Raw length: ${cleaned.length}. ` +
        `Last 200 chars: ${cleaned.slice(-200)}`,
    );
    const wrapped = new Error(
      `Groq returned malformed JSON for ${context}: ${err.message}`,
    );
    wrapped.isJsonParseError = true;
    throw wrapped;
  }
}

async function callGroqJson(callFn, prompt, context) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_JSON_PARSE_ATTEMPTS; attempt++) {
    const raw = await callFn(prompt);
    try {
      return parseJsonResponse(raw, context);
    } catch (err) {
      lastError = err;
      if (!err.isJsonParseError) throw err;
      console.warn(
        `JSON parse attempt ${attempt}/${MAX_JSON_PARSE_ATTEMPTS} failed for ${context}; retrying generation.`,
      );
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Courseware pipeline (video key: GROQ_API_KEY)
// ---------------------------------------------------------------------------

exports.generateObjectivesAndQueries = async (
  topicName,
  subjectName,
  description,
) => {
  const prompt = `
You are an elementary school curriculum assistant.

Topic: "${topicName}"
Subject: "${subjectName}"
${description ? `Description: "${description}"` : ""}

A student is struggling with this topic. Respond ONLY with valid JSON, no markdown, no preamble, in this exact shape:

{
  "objectives": ["objective 1", "objective 2", "objective 3"],
  "youtubeQueries": ["search query 1", "search query 2", "search query 3"]
}

- "objectives": 3 to 5 clear, age-appropriate learning objectives for this topic.
- "youtubeQueries": 3 short YouTube search queries likely to surface short, kid-friendly educational videos on this exact topic.
`.trim();

  return callGroqJson(callGroqForVideo, prompt, "objectives/queries");
};

exports.organizeVideoResources = async (topicName, objectives, videos) => {
  const videoList = videos
    .map((v, i) => `${i + 1}. "${v.title}" by ${v.channel} (${v.url})`)
    .join("\n");

  const prompt = `
You are organizing learning resources for a parent whose child is struggling with "${topicName}".

Learning objectives:
${objectives.map((o) => `- ${o}`).join("\n")}

Candidate videos found:
${videoList}

Respond ONLY with valid JSON, no markdown, in this exact shape:

{
  "summary": "a short 2-3 sentence note to the parent explaining what this topic covers and how to use these resources",
  "selectedVideoUrls": ["url1", "url2", "url3"]
}

Pick the 3 to 5 best, most relevant, most kid-appropriate videos from the candidate list above. Only include URLs exactly as given in the candidate list.
`.trim();

  return callGroqJson(callGroqForVideo, prompt, "video resources");
};

// ---------------------------------------------------------------------------
// Quiz pipeline (quiz keys: GROQ_API_KEY_QUIZ, _2, _3, ...)
// ---------------------------------------------------------------------------

exports.generateQuiz = async (
  topicName,
  subjectName,
  objectives,
  difficulty = "Easy",
  gradeLevel = null,
) => {
  const gradeBlock = gradeLevel
    ? `
STUDENT GRADE LEVEL: "${gradeLevel}"

GRADE LEVEL RULES:
- Write every question, answer choice, and explanation for a ${gradeLevel} student.
- Match the vocabulary, sentence length, reading level, and number ranges to what a ${gradeLevel} student is expected to handle.
- Only use concepts that belong to the ${gradeLevel} curriculum for this topic.
- The difficulty levels below are relative to ${gradeLevel}: "Hard" means challenging for a ${gradeLevel} student, never material from a higher grade.
- Explanations must be short and simple enough for a ${gradeLevel} student to read on their own.
`
    : "";

  const gradeProfile = buildGradeProfile(gradeLevel, difficulty);

  const prompt = `
You are an educational quiz generator for QED (Quality Education), a web-based
student monitoring and intervention system for elementary students.

Create a short multiple-choice quiz specifically about the student's identified
learning-gap topic.

SUBJECT: "${subjectName}"
TOPIC: "${topicName}"

LEARNING OBJECTIVES:
${objectives.map((o) => `- ${o}`).join("\n")}
${gradeBlock}
DIFFICULTY LEVEL: "${difficulty}"

DIFFICULTY RULES:

Easy:
- Focus on basic understanding, recognition, recall, and simple application.
- Use straightforward questions.
- Avoid unnecessary calculations or confusing wording.
- The student should demonstrate understanding of the fundamental concept.

Medium:
- Focus on applying the concept to familiar situations.
- Require more reasoning than Easy.
- Include simple problem-solving.
- Do not make questions difficult simply by using larger numbers.

Hard:
- Focus on deeper understanding, multi-step reasoning, and problem-solving.
- Require the student to apply the concept in less familiar situations.
- Questions may combine multiple concepts from the learning objectives.
- Avoid trick questions.
${gradeProfile}
IMPORTANT EDUCATIONAL RULES:
- Questions must directly relate to "${topicName}".
- Questions must be appropriate for elementary students.
- Use age-appropriate vocabulary.
- Do not introduce concepts outside the provided learning objectives.
- Avoid ambiguous questions.
- Only one answer may be clearly correct.
- Distractors should be plausible but clearly incorrect based on the concept.
- Do not use "all of the above" or "none of the above."
- Do not intentionally trick the student.
- Keep explanations short, clear, and encouraging.
- The quiz should measure understanding of the identified topic, not general intelligence.

IMPORTANT JSON RULES:
- Respond ONLY with valid JSON.
- Do not use markdown.
- Do not include \`\`\`json.
- Do not include any text before or after the JSON.
- "correctAnswer" must be exactly "A", "B", "C", or "D".
- Write exactly ${QUIZ_QUESTION_COUNT} questions.
- Every question must contain exactly four choices.
- Keep each "explanation" to one short sentence so the full response fits comfortably within the output limit.

Respond using exactly this structure:

{
  "questions": [
    {
      "questionText": "...",
      "choiceA": "...",
      "choiceB": "...",
      "choiceC": "...",
      "choiceD": "...",
      "correctAnswer": "A",
      "explanation": "..."
    }
  ]
}
`.trim();

  const context = `quiz (${topicName}, ${difficulty}${gradeLevel ? `, ${gradeLevel}` : ""})`;
  const parsedBody = await callGroqJson(callGroqForQuiz, prompt, context);
  const parsed = parsedBody.questions;

  // If Groq ignores the count instruction, a short or long question set
  // would silently get cached and served to students. This can't correct the
  // count, but it makes a mismatch visible in the logs immediately.
  if (!Array.isArray(parsed) || parsed.length !== QUIZ_QUESTION_COUNT) {
    console.warn(
      `Groq returned ${Array.isArray(parsed) ? parsed.length : "non-array"} questions ` +
        `instead of ${QUIZ_QUESTION_COUNT} for topic "${topicName}" (${difficulty}` +
        `${gradeLevel ? `, ${gradeLevel}` : ""}).`,
    );
  }

  return parsed;
};

// ---------------------------------------------------------------------------
// Bonus games (matching + memory). Uses the QUIZ keys, same as the quiz.
// ---------------------------------------------------------------------------

const MATCH_PAIR_COUNT = 5;
const MAX_CARD_TEXT_LENGTH = 40;

// Keeps only usable pairs: non-empty, short, and no duplicate left or right
// text (a duplicate would make a match ambiguous).
function cleanPairs(rawPairs) {
  if (!Array.isArray(rawPairs)) return [];
  const seenLeft = new Set();
  const seenRight = new Set();
  const out = [];

  for (const p of rawPairs) {
    const left = typeof p?.left === "string" ? p.left.trim() : "";
    const right = typeof p?.right === "string" ? p.right.trim() : "";
    if (!left || !right) continue;
    if (
      left.length > MAX_CARD_TEXT_LENGTH ||
      right.length > MAX_CARD_TEXT_LENGTH
    )
      continue;

    const l = left.toLowerCase();
    const r = right.toLowerCase();
    if (l === r || seenLeft.has(l) || seenRight.has(r)) continue;

    seenLeft.add(l);
    seenRight.add(r);
    out.push({ left, right });
  }
  return out;
}

exports.generateMatchPairs = async (
  topicName,
  subjectName,
  gradeLevel = null,
  count = MATCH_PAIR_COUNT,
) => {
  const gradeBlock = gradeLevel
    ? `
STUDENT GRADE LEVEL: "${gradeLevel}"
- Write everything for a ${gradeLevel} student: vocabulary, reading level, and number ranges.
- Only use concepts that belong to the ${gradeLevel} curriculum.
`
    : "";

  const gradeProfile = buildGradeProfile(gradeLevel, "Easy");

  const prompt = `
You are creating a matching-game activity for QED (Quality Education),
a web-based student monitoring and intervention system for elementary
students.

SUBJECT: "${subjectName}"
TOPIC: "${topicName}"
${gradeBlock}
${gradeProfile}
Create ${count} short "left / right" pairs that a student could match
to reinforce the topic above (e.g. a term and its meaning, a question
and its answer, a picture description and its label — whichever fits
"${topicName}" best).

RULES:
- Each pair must directly relate to "${topicName}".
- Keep each side of a pair short: under 40 characters.
- No pair's left or right text may duplicate another pair's left or
  right text.
- Use age-appropriate, grade-appropriate vocabulary.
- Do not use "all of the above" or "none of the above".
- Do not introduce concepts outside "${topicName}".

IMPORTANT JSON RULES:
- Respond ONLY with valid JSON.
- Do not use markdown.
- Do not include \`\`\`json.
- Do not include any text before or after the JSON.
- Write exactly ${count} pairs.

Respond using exactly this structure:

{
  "pairs": [
    { "left": "...", "right": "..." }
  ]
}
`.trim();

  const context = `match pairs (${topicName}${gradeLevel ? `, ${gradeLevel}` : ""})`;
  const parsedBody = await callGroqJson(callGroqForQuiz, prompt, context);
  const pairs = cleanPairs(parsedBody.pairs);

  // Never cache a short set: the game needs a full board.
  if (pairs.length < count) {
    throw new Error(
      `Groq returned only ${pairs.length} usable pairs (need ${count}) for topic "${topicName}".`,
    );
  }
  return pairs.slice(0, count);
};

// The two pipelines NEVER fall back to each other's keys. If a key is missing,
// the call fails with a clear error instead of silently using the other pool.
//
// OVERLOAD HANDLING
//   429 (quota)        -> quiz pipeline moves to the next quiz key.
//   500/502/503/504    -> retry the same model briefly, then fall back to
//                         GROQ_FALLBACK_MODELS. Switching keys does NOT help
//                         here because the whole model is overloaded, not the key.
//
// JSON PARSE FAILURES
//   Groq occasionally returns truncated or malformed JSON (e.g. the response
//   hits the token limit mid-string). callGroqJson() retries the whole
//   generation a few times before giving up, and max_tokens below gives
//   responses enough headroom to actually finish.