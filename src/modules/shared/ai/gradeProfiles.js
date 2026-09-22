const PROFILES = {
  1: {
    language:
      "Use very simple, familiar language appropriate for beginning readers. " +
      "Use short sentences, familiar words, concrete objects, and situations " +
      "from home, school, and the learner's immediate environment.",

    numbers:
      "Use only mathematical ideas appropriate to the selected Grade 1 " +
      "Mathematics competency. Prefer concrete quantities, visual models, " +
      "counting, comparing, simple operations, patterns, measurement, " +
      "and familiar everyday contexts when relevant.",

    easy:
      "Recognize, identify, match, name, or recall one concept. " +
      "Use one clear step and familiar examples.",

    medium:
      "Apply the target concept in a familiar situation. " +
      "Use simple reasoning with at most one or two clear steps.",

    hard:
      "Apply the target concept in a slightly less familiar situation. " +
      "Require simple reasoning, but remain within the Grade 1 competency."
  },

  2: {
    language:
      "Use simple Grade 2 vocabulary and short, clear sentences. " +
      "Use familiar school, home, community, and everyday situations. " +
      "Short story or word problems are allowed when appropriate to the topic.",

    numbers:
      "Use only mathematical ideas appropriate to the selected Grade 2 " +
      "Mathematics competency. Use familiar quantities, operations, patterns, " +
      "measurement, money, time, and simple problem situations only when " +
      "supported by the target competency.",

    easy:
      "Recall, identify, recognize, or demonstrate the target concept " +
      "using a straightforward one-step task.",

    medium:
      "Apply the target concept in a familiar situation. " +
      "Use one or two reasoning steps.",

    hard:
      "Apply the target concept in a new but age-appropriate situation. " +
      "Require simple reasoning or up to two connected steps without " +
      "introducing higher-grade concepts."
  },

  3: {
    language:
      "Use Grade 3 vocabulary and developmentally appropriate sentences. " +
      "Short passages, stories, diagrams, and real-life situations may be used " +
      "when relevant to the target competency.",

    numbers:
      "Use only mathematical ideas explicitly appropriate to the selected " +
      "Grade 3 Mathematics competency. Do not introduce Grade 4-level concepts " +
      "simply to make the question harder.",

    easy:
      "Recall, identify, describe, or demonstrate the target concept " +
      "using a straightforward task.",

    medium:
      "Apply the target concept to a familiar problem or situation. " +
      "Require one or two connected steps.",

    hard:
      "Require reasoning, interpretation, or problem solving using the target " +
      "Grade 3 competency. Multiple steps are allowed only when appropriate " +
      "to the competency. Do not use Grade 4 content."
  },

  4: {
    language:
      "Use Grade 4 vocabulary and sentence structures. " +
      "Short passages, diagrams, tables, and real-world situations may be used " +
      "when they support the target competency.",

    numbers:
      "Use only mathematical ideas appropriate to the selected Grade 4 " +
      "Mathematics competency. Do not introduce Grade 5 concepts merely to " +
      "increase difficulty.",

    easy:
      "Recall, identify, explain, or directly apply the target concept.",

    medium:
      "Apply the target concept in a familiar or moderately varied situation. " +
      "Use two connected steps when appropriate.",

    hard:
      "Require multi-step application, reasoning, comparison, interpretation, " +
      "or problem solving within the selected Grade 4 competency. " +
      "Do not use Grade 5 content."
  },

  5: {
    language:
      "Use Grade 5 vocabulary and developmentally appropriate sentence structures. " +
      "Longer passages, tables, diagrams, and realistic situations may be used " +
      "when relevant to the competency.",

    numbers:
      "Use only mathematical ideas appropriate to the selected Grade 5 " +
      "Mathematics competency. The exact numbers and operations must be determined " +
      "by the target topic or competency.",

    easy:
      "Recall, identify, describe, or perform a straightforward application " +
      "of the target concept.",

    medium:
      "Apply the target concept in varied or familiar real-world situations. " +
      "Require multiple connected steps when appropriate.",

    hard:
      "Require multi-step reasoning, interpretation, comparison, justification, " +
      "or problem solving using the target Grade 5 competency. " +
      "Do not use Grade 6 content."
  },

  6: {
    language:
      "Use Grade 6 vocabulary and developmentally appropriate sentence structures. " +
      "Multi-sentence passages, tables, graphs, diagrams, and real-world contexts " +
      "may be used when relevant to the target competency.",

    numbers:
      "Use only mathematical ideas appropriate to the selected Grade 6 " +
      "Mathematics competency. The exact numerical range must come from the " +
      "selected topic or competency rather than an arbitrary grade-wide limit.",

    easy:
      "Recall, identify, explain, or directly apply the target concept " +
      "using a straightforward task.",

    medium:
      "Apply the target concept in varied or less familiar situations. " +
      "Require multiple connected steps when appropriate.",

    hard:
      "Require multi-step reasoning, interpretation, justification, comparison, " +
      "or problem solving using the selected Grade 6 competency. " +
      "Do not introduce Grade 7 content."
  },
};

function getProfile(gradeLevel) {
  if (!gradeLevel) return null;

  const label = String(gradeLevel);
  const digits = label.match(/\d+/);
  const n = digits ? parseInt(digits[0], 10) : null;

  return n && PROFILES[n]
    ? {
        name: `Grade ${n}`,
        ...PROFILES[n],
      }
    : null;
}

// Returns a grade-specific prompt block.
// Returns an empty string when the grade is unknown.

exports.buildGradeProfile = (
  gradeLevel,
  difficulty = "Easy"
) => {
  const p = getProfile(gradeLevel);

  if (!p) return "";

  const key = String(difficulty).toLowerCase();
  const levelRule = p[key] || p.easy;

  return `
GRADE-SPECIFIC MATATAG RULES FOR ${p.name.toUpperCase()}
These rules must be followed together with the selected subject,
topic, learning competency, and intervention objective.

1. LANGUAGE LEVEL
${p.language}

2. CONTENT BOUNDARY
The selected topic and learning competency are the PRIMARY content boundary.
Generate questions only from the specified topic and competency.

${p.numbers}

Do NOT introduce a higher-grade concept just to make the question harder.

3. DIFFICULTY: ${difficulty.toUpperCase()}
${levelRule}

4. CURRICULUM ALIGNMENT
- Keep the question appropriate for ${p.name}.
- Keep vocabulary and reading demands appropriate for ${p.name}.
- Keep examples culturally and contextually appropriate for Filipino elementary learners.
- Use real-life situations when they naturally support the target competency.
- Do not mix unrelated competencies.
- Do not introduce content from a higher grade level.
- Difficulty must increase the thinking required, NOT the curriculum level.

5. INTERVENTION FOCUS
Because this quiz is being generated as an intervention activity:
- Focus directly on the identified weak topic.
- Reinforce the target concept before adding complexity.
- Avoid trick questions.
- Avoid unnecessary information.
- Make every question answerable using the knowledge expected from ${p.name}.
`;
};
// ============================================================
// QED — MATATAG CURRICULUM GRADE PROFILES
// ============================================================
//
// These profiles are used to control the language, reasoning,
// and difficulty of AI-generated intervention quizzes.
//
// IMPORTANT:
// - The selected topic/learning competency is the PRIMARY
//   content boundary.
// - The grade profile controls developmental appropriateness.
// - Do NOT introduce concepts from higher grade levels.
// - Do NOT impose arbitrary numerical limits when they are
//   unrelated to the selected topic.
// - Difficulty changes the cognitive demand, not the curriculum
//   level.
// ============================================================