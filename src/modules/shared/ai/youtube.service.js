const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

exports.searchVideos = async (query, maxResults = 5) => {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("safeSearch", "strict");
  url.searchParams.set("videoEmbeddable", "true");
  url.searchParams.set("key", YOUTUBE_API_KEY);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`YouTube API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  return (data.items || []).map((item) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    channel: item.snippet.channelTitle,
    thumbnail: item.snippet.thumbnails?.medium?.url || null,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
  }));
};