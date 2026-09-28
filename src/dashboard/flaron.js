const FLARON_BASE = 'https://flaron.halceon.dev';
const CACHE_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;

/**
 * Flaron is Hack Club's Slack data cache and the source for the things Slack's
 * API will not tell us cheaply: how big a channel is and who runs it.
 *
 *   GET /cid/C012ABCDEF -> { id, name, counts: { total, bots }, managers: [U…] }
 *
 * It answers without authentication. It also refuses to describe private
 * channels (`{"error": "private"}`), which is a normal answer rather than a
 * failure: those channels fall back to Slack for a size and say so.
 */
export function flaronChannelUrl(channelId) {
  return `${FLARON_BASE}/cid/${encodeURIComponent(channelId)}`;
}

export function createFlaronDirectory({
  fetchImpl = globalThis.fetch,
  logger = console,
  cacheMs = CACHE_MS,
  baseUrl = FLARON_BASE,
} = {}) {
  const cache = new Map();

  async function fetchChannel(channelId) {
    const cached = cache.get(channelId);
    if (cached && Date.now() - cached.fetchedAt < cacheMs) {
      return cached.value;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let value = null;
    try {
      const response = await fetchImpl(`${baseUrl}/cid/${encodeURIComponent(channelId)}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const body = response.ok ? await response.json().catch(() => ({})) : {};
      // A private or unknown channel comes back as an error object with HTTP 200,
      // so check the body rather than the status alone.
      if (!body?.error && body?.id) {
        const total = Number(body?.counts?.total);
        const bots = Number(body?.counts?.bots);
        value = {
          channelId: body.id,
          name: body.name || '',
          members: Number.isFinite(total) ? total : null,
          bots: Number.isFinite(bots) ? bots : null,
          humans: Number.isFinite(total) && Number.isFinite(bots) ? Math.max(0, total - bots) : null,
          managers: Array.isArray(body.managers) ? body.managers.filter((id) => typeof id === 'string' && id) : [],
          creator: body.creator || '',
          topic: body.topic || '',
          description: body.description || '',
          archived: !!body.is_archived,
        };
      } else if (body?.error) {
        logger.info?.(`[flaron] ${channelId} -> ${body.error}`);
      }
    } catch (error) {
      logger.warn?.(`[flaron] ${channelId} lookup failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
    // Negative answers are cached as null too, so a private channel does not get
    // re-asked on every dashboard refresh.
    cache.set(channelId, { value, fetchedAt: Date.now() });
    return value;
  }

  /** Channel records for a set of ids, keyed by id. Ids Flaron cannot answer for are omitted. */
  async function list(channelIds) {
    const unique = [...new Set((channelIds || []).filter(Boolean))];
    const results = await Promise.all(unique.map((id) => fetchChannel(id).catch(() => null)));
    const byId = {};
    for (const record of results) {
      if (record) {
        byId[record.channelId] = record;
      }
    }
    return byId;
  }

  return {
    fetchChannel,
    list,
    clear: () => cache.clear(),
  };
}
