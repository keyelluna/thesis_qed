const connection = require("../../../../../config/db");
const groqService = require("../../../shared/ai/groq.service");
const youtubeService = require("../../../shared/ai/youtube.service");

exports.getCourseware = async (req, res) => {
  const { studentId, topicId } = req.params;
  const parentUserId = req.user?.userId;

  if (!parentUserId) {
    return res.status(401).json({ message: "Unauthorized." });
  }
  if (!studentId || !topicId) {
    return res.status(400).json({ message: "studentId and topicId are required." });
  }

  try {
    const [parentRows] = await connection.query(
      `SELECT id FROM parent_table WHERE user_id = ? AND is_deleted = 0`,
      [parentUserId]
    );
    if (parentRows.length === 0) {
      return res.status(404).json({ message: "Parent record not found." });
    }
    const parentId = parentRows[0].id;

    const [linkRows] = await connection.query(
      `SELECT 1 FROM parent_student WHERE parent_id = ? AND student_id = ? LIMIT 1`,
      [parentId, studentId]
    );
    if (linkRows.length === 0) {
      return res.status(403).json({ message: "You don't have access to this student's records." });
    }
    const [cachedDoc] = await connection.query(
      `SELECT title, content, generated_at FROM ai_reviewer_documents WHERE topic_id = ? ORDER BY generated_at DESC LIMIT 1`,
      [topicId]
    );
    const [cachedVideos] = await connection.query(
      `SELECT video_title, video_url, thumbnail_url, channel_name FROM ai_video_suggestions WHERE topic_id = ?`,
      [topicId]
    );

    if (cachedDoc.length > 0 && cachedVideos.length > 0) {
      return res.status(200).json({
        cached: true,
        document: normalizeDocument(cachedDoc[0]),
        videos: cachedVideos.map(normalizeCachedVideo),
      });
    }

    const [topicRows] = await connection.query(
      `SELECT lt.topic_name, lt.description, es.subject_name
       FROM learning_topics lt
       INNER JOIN \`subject-section\` ss ON lt.subject_section_id = ss.id
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       WHERE lt.id = ?`,
      [topicId]
    );
    if (topicRows.length === 0) {
      return res.status(404).json({ message: "Topic not found." });
    }
    const { topic_name: topicName, description, subject_name: subjectName } = topicRows[0];

    const { objectives, youtubeQueries } = await groqService.generateObjectivesAndQueries(
      topicName,
      subjectName,
      description
    );

    const videoResultsPerQuery = await Promise.all(
      youtubeQueries.map((q) => youtubeService.searchVideos(q, 5))
    );
    const allVideos = videoResultsPerQuery.flat();
    const uniqueVideos = Array.from(new Map(allVideos.map((v) => [v.videoId, v])).values());

    if (uniqueVideos.length === 0) {
      const fallbackContent = objectives.map((o) => `- ${o}`).join("\n");
      return res.status(200).json({
        cached: false,
        document: normalizeDocument({ title: topicName, content: fallbackContent }),
        videos: [],
        warning: "No videos found for this topic.",
      });
    }

    const { summary, selectedVideoUrls } = await groqService.organizeVideoResources(
      topicName,
      objectives,
      uniqueVideos
    );

    const selectedVideos = uniqueVideos.filter((v) => selectedVideoUrls.includes(v.url));

    const documentContent = [
      `## Learning Objectives`,
      ...objectives.map((o) => `- ${o}`),
      ``,
      `## Notes for Parents`,
      summary,
    ].join("\n");

    await connection.query(
      `INSERT INTO ai_reviewer_documents (topic_id, title, content, model_used) VALUES (?, ?, ?, ?)`,
      [topicId, topicName, documentContent, "groq"]
    );

    for (const v of selectedVideos) {
      await connection.query(
        `INSERT INTO ai_video_suggestions (topic_id, video_title, video_url, thumbnail_url, channel_name, source)
         VALUES (?, ?, ?, ?, ?, 'youtube')`,
        [topicId, v.title, v.url, v.thumbnail, v.channel]
      );
    }

    return res.status(200).json({
      cached: false,
      document: normalizeDocument({ title: topicName, content: documentContent }),
      videos: selectedVideos.map(normalizeFreshVideo),
    });
  } catch (error) {
    console.error("Error generating courseware:", error);
    return res.status(500).json({ message: "Failed to generate courseware." });
  }
};

// --- Response shape normalizers -------------------------------------------
// Both the cached branch (raw DB rows, snake_case) and the freshly-generated
// branch (youtube/groq service output, different key names) must produce
// the SAME shape here, so the frontend never has to branch on `cached`.

function normalizeDocument(doc) {
  return {
    title: doc.title,
    content: doc.content,
    generatedAt: doc.generated_at ?? null,
  };
}

function normalizeCachedVideo(row) {
  return {
    title: row.video_title,
    url: row.video_url,
    thumbnailUrl: row.thumbnail_url,
    channelName: row.channel_name,
  };
}

function normalizeFreshVideo(v) {
  return {
    title: v.title,
    url: v.url,
    thumbnailUrl: v.thumbnail,
    channelName: v.channel,
  };
}