/**
 * 观众声音装配：4317 只读路由拼装主题卡/逐字原文。
 */
import type { PwVoiceTheme, PwVoiceThemeDetail } from "../types.js";
import { fetchCorpus, fetchVoiceCards } from "./pw-client.js";

export async function collectVoiceThemes(baseUrl: string): Promise<PwVoiceTheme[]> {
  const corpus = await fetchCorpus(baseUrl);
  const themes: PwVoiceTheme[] = [];
  for (const doc of corpus) {
    const bvid = String(doc.bvid ?? "");
    if (!bvid) continue;
    let cards: Awaited<ReturnType<typeof fetchVoiceCards>> = [];
    try {
      cards = await fetchVoiceCards(baseUrl, bvid, "suggested");
    } catch {
      continue;
    }
    for (const card of cards) {
      themes.push({
        id: String(card.id),
        bvid,
        videoTitle: doc.title ? String(doc.title) : null,
        title: String(card.title ?? "未命名主题"),
        summary: card.summary ?? null,
        status: (card.status ?? "suggested") as PwVoiceTheme["status"],
        itemCount: Array.isArray(card.items) ? card.items.length : 0,
        createdAt: String(card.createdAt ?? ""),
      });
    }
  }
  return themes;
}

export async function collectVoiceThemeDetail(
  baseUrl: string,
  themeId: string,
): Promise<PwVoiceThemeDetail | null> {
  const corpus = await fetchCorpus(baseUrl);
  for (const doc of corpus) {
    const bvid = String(doc.bvid ?? "");
    if (!bvid) continue;
    let cards: Awaited<ReturnType<typeof fetchVoiceCards>> = [];
    try {
      cards = await fetchVoiceCards(baseUrl, bvid, "suggested");
    } catch {
      continue;
    }
    const found = cards.find((card) => String(card.id) === themeId);
    if (!found) continue;
    const theme: PwVoiceTheme = {
      id: String(found.id),
      bvid,
      videoTitle: doc.title ? String(doc.title) : null,
      title: String(found.title ?? "未命名主题"),
      summary: found.summary ?? null,
      status: (found.status ?? "suggested") as PwVoiceTheme["status"],
      itemCount: Array.isArray(found.items) ? found.items.length : 0,
      createdAt: String(found.createdAt ?? ""),
    };
    const items = (Array.isArray(found.items) ? found.items : []).map((item: any) => ({
      rpid: Number(item.rpid ?? 0),
      message: String(item.message ?? ""),
      uname: item.uname ?? null,
      like: item.like ?? item.like_count ?? null,
      ctime: item.ctime ?? null,
      collected: Boolean(item.collected),
      voiceId: item.voiceId ?? item.voice_id ?? null,
    }));
    return { ...theme, items };
  }
  return null;
}
