/** Read the older part of a saved chat without repeatedly uploading its full transcript. */
export async function resolveChatHistory({ chatStore, chatId, history = [], reference }) {
  if (!reference) return Array.isArray(history) ? history : [];
  const fail = () => { throw new Error('The saved chat changed before this message was sent. Please send it again.'); };
  if (!chatId || !Number.isSafeInteger(reference.rev) || typeof reference.startId !== 'string'
      || typeof reference.endId !== 'string' || !Array.isArray(history)) return fail();
  const raw = await chatStore.read(chatId);
  if (!raw) return fail();
  const saved = JSON.parse(raw);
  if (saved.rev !== reference.rev) return fail();
  const messages = (saved.session?.messages ?? []).filter(m => !m.timeSkipId && !m.local
    && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim());
  const first = messages.findIndex(m => m.id === reference.startId);
  const last = messages.findIndex(m => m.id === reference.endId);
  if (first < 0 || last < first || last - first + 1 !== history.length) return fail();
  // The recent tail is the page's rendered image-aware history. Older pictures
  // remain in the transcript, but their pixels are not silently re-uploaded.
  return [...messages.slice(0, first).map(m => ({ role: m.role, content: m.content +
    (m.photos?.length ? '\n[Earlier pictures remain attached to the chat. Their pixels are not included in this request.]' : '') })), ...history];
}
